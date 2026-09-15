// The shop's API on Netlify. Same endpoints as the local server, but the data
// lives in Netlify Blobs so the storefront and the admin panel both work online.
//
// What lives here: the catalogue, customer accounts, orders and receipts,
// delivery priced by distance, M-Pesa STK push, and the activity log that
// records every change made to the store.
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import seed from './seed.mjs';

import { quoteDelivery, DEFAULT_PER_KM } from '../../lib/pricing.js';
import { receiptHtml } from '../../lib/receipt.js';
import * as fin from '../../lib/finance.js';
import * as log from '../../lib/activity.js';
import * as mailer from '../../lib/email.js';
import {
  hashPassword, verifyPassword, passwordProblem,
  issueToken, readToken, bearer,
  normalizeEmail, isEmail, publicCustomer
} from '../../lib/auth.js';
import {
  stkPush, stkQuery, parseCallback, normalizePhone,
  isConfigured as mpesaConfigured
} from '../../mpesa.js';

const CATEGORIES = [
  'Lip Products', 'Makeup', 'Skincare', 'Body Care',
  'Perfumes & Mists', 'Hair Care', 'Beauty Accessories', 'Gift Sets'
];

const SECRET = process.env.TOKEN_SECRET || 'tessora-dev-secret';
const ENV_PASSWORD = process.env.ADMIN_PASSWORD || '1234';
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

// Strong consistency matters here: with the default eventual reads, a request
// right after a change can still see the old shop — and the seeding below would
// then overwrite real products with the starter set.
const data = () => getStore({ name: 'tessora-shop', consistency: 'strong' });
const media = () => getStore('tessora-media');

/* ------------------------------------------------------------------ state */

// Settings added after the shop went live. Merged in on every read so an
// existing database picks them up without anyone having to migrate anything.
const SETTINGS_ADDED = {
  // delivery priced by distance
  deliveryPerKm: DEFAULT_PER_KM,
  deliveryBaseFee: 0,
  storeLat: -1.286389,
  storeLng: 36.817223,
  mapsApiKey: '',
  // M-Pesa (Daraja)
  mpesaEnabled: false,
  mpesaEnv: 'sandbox',
  mpesaType: 'paybill',
  mpesaShortcode: '',
  mpesaTill: '',
  mpesaPasskey: '',
  mpesaConsumerKey: '',
  mpesaConsumerSecret: '',
  mpesaCallbackUrl: '',
  // reports and alerts
  reportEmail: '',
  emailApiKey: '',
  emailFrom: '',
  notifyNewOrder: true,
  notifyPayment: true,
  notifyStatusChange: true,
  notifyAdminChanges: false,
  // the admin password, once it has been changed from the environment one
  adminPassword: '',
  passwordIsDefault: false
};

async function load() {
  const store = data();
  const saved = await store.get('db', { type: 'json' });
  if (saved) {
    // Newly added settings and collections, filled in without touching what is
    // already there. Never overwrite a value the shop owner has set.
    saved.settings = { ...SETTINGS_ADDED, ...saved.settings };
    saved.products ||= [];
    saved.orders ||= [];
    saved.customers ||= [];
    saved.activity ||= [];
    saved.counters ||= { order: 1000 };
    return saved;
  }
  // Genuinely empty, so this is the shop's first ever request: lay down the
  // starter products once. Written immediately so concurrent requests agree.
  const fresh = {
    settings: { ...seed.settings, ...SETTINGS_ADDED },
    products: seed.products.map((p) => ({ ...p })),
    orders: [],
    customers: [],
    activity: [],
    counters: { order: 1000 }
  };
  await store.setJSON('db', fresh);
  return fresh;
}

const persist = (db) => data().setJSON('db', db);

/* ------------------------------------------------------------------ auth */

const adminToken = () => issueToken(SECRET, 'admin', ADMIN_SESSION_MS);
const customerToken = (id) => issueToken(SECRET, `c:${id}`, CUSTOMER_SESSION_MS);

const isAuthed = (req) => readToken(SECRET, bearer(req.headers.get('authorization'))) === 'admin';

function currentCustomer(req, db) {
  const subject = readToken(SECRET, bearer(req.headers.get('authorization')));
  if (!subject.startsWith('c:')) return null;
  return (db.customers || []).find((c) => c.id === subject.slice(2)) || null;
}

/** The password to check against: the saved one, or the environment fallback. */
function checkAdminPassword(db, given) {
  const saved = db.settings.adminPassword;
  if (saved) return verifyPassword(given, saved);
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(ENV_PASSWORD));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ----------------------------------------------------------------- utils */
const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

const html = (status, body) => new Response(body, {
  status,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
});

/** A downloadable file, named so the browser saves it rather than showing it. */
const file = (body, filename, type = 'text/csv; charset=utf-8') => new Response(
  // The BOM makes Excel open UTF-8 CSVs with accents intact.
  type.startsWith('text/csv') ? `﻿${body}` : body,
  {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store'
    }
  }
);

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);
const salePrice = (p) => Math.round(num(p.price) * (1 - clamp(num(p.discount), 0, 95) / 100));
const publicProduct = (p) => ({ ...p, salePrice: salePrice(p) });
const newId = () => crypto.randomBytes(9).toString('base64url');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Settings the storefront may see. Keys, passwords and payment secrets never leave. */
function publicSettings(s) {
  const {
    adminPassword, mpesaConsumerKey, mpesaConsumerSecret, mpesaPasskey,
    mpesaCallbackUrl, emailApiKey, reportEmail, ...rest
  } = s;
  return {
    ...rest,
    // Only advertise M-Pesa when it would actually work.
    mpesaEnabled: Boolean(s.mpesaEnabled) && mpesaConfigured(s)
  };
}

/** Settings the admin panel may see — secrets shown only as "is it set?". */
function adminSettings(s) {
  const { adminPassword, mpesaConsumerSecret, mpesaPasskey, emailApiKey, ...rest } = s;
  return {
    ...rest,
    mpesaConsumerSecretSet: Boolean(mpesaConsumerSecret),
    mpesaPasskeySet: Boolean(mpesaPasskey),
    emailApiKeySet: Boolean(emailApiKey),
    emailReady: mailer.isConfigured(s)
  };
}

/* --------------------------------------------------------------- uploads */
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

async function saveImage(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('Unsupported image format');
  const ext = TYPES[m[1]];
  if (!ext) throw new Error('Images must be PNG, JPG, WEBP or GIF');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 5 * 1024 * 1024) throw new Error('Image is larger than 5MB');
  const key = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
  await media().set(key, bytes, { metadata: { type: m[1] } });
  return `/uploads/${key}`;
}

const dropImage = (url) => {
  if (typeof url === 'string' && url.startsWith('/uploads/')) {
    media().delete(url.slice('/uploads/'.length)).catch(() => {});
  }
};

/* -------------------------------------------------------------- products */
function normalize(input, existing = {}) {
  const name = str(input.name ?? existing.name, 120);
  if (!name) throw new Error('Product name is required');
  const price = Math.round(num(input.price ?? existing.price, 0));
  if (price <= 0) throw new Error('Price must be greater than 0');

  return {
    id: existing.id || newId(),
    name,
    slug: slug(name),
    category: CATEGORIES.includes(input.category) ? input.category : (existing.category || CATEGORIES[0]),
    brand: str(input.brand ?? existing.brand, 60),
    description: str(input.description ?? existing.description, 1500),
    price,
    // What you paid for it. Optional — but without it the shop cannot work out
    // profit, so the financial statements say so rather than guessing.
    costPrice: Math.max(0, Math.round(num(input.costPrice ?? existing.costPrice, 0))),
    discount: clamp(Math.round(num(input.discount ?? existing.discount, 0)), 0, 95),
    stock: Math.max(0, Math.round(num(input.stock ?? existing.stock, 0))),
    sku: str(input.sku ?? existing.sku, 40) || `TB-${slug(name).slice(0, 12).toUpperCase()}`,
    images: Array.isArray(existing.images) ? existing.images : [],
    featured: Boolean(input.featured ?? existing.featured ?? false),
    active: input.active === undefined ? (existing.active ?? true) : Boolean(input.active),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

const PRODUCT_FIELDS = {
  name: 'Name', category: 'Category', brand: 'Brand', price: 'Price',
  costPrice: 'Cost price',
  discount: 'Discount %', stock: 'Stock', sku: 'SKU',
  active: 'Visible', featured: 'Bestseller', description: 'Description'
};

/* ------------------------------------------------------- notifying admin */

/**
 * Send an email about something that just happened, but only if the shop owner
 * asked for that kind of alert. Failures are swallowed on purpose: the event is
 * already in the activity log, which is the record that matters.
 */
async function notify(db, { when, subject, body }) {
  if (!when) return;
  if (!mailer.isConfigured(db.settings)) return;
  await mailer.sendEmail(db.settings, { subject, html: body }).catch(() => {});
}

/* ------------------------------------------- new-order email, via Netlify */

/**
 * Email the store about a new order without any email service.
 *
 * Netlify emails every submission of the hidden "order-alert" form
 * (public/order-alert.html) to the store's inbox, so posting the order into
 * that form is what sends the email. If a Resend key has been added the Resend
 * alert already covers it, and this steps aside so nobody gets two emails.
 *
 * It never fails the order: the order is saved before this runs, and if the
 * form post doesn't go through that is written to the activity log instead.
 */
async function alertNewOrder(db, order, origin) {
  if (mailer.isConfigured(db.settings)) return;

  const currency = db.settings.currency || 'KSh';
  const m = (n) => `${currency} ${Math.round(Number(n) || 0).toLocaleString('en-KE')}`;
  const d = order.delivery || {};

  const fields = {
    'form-name': 'order-alert',
    'bot-field': '',
    Order: order.code,
    Total: m(order.total),
    Customer: order.customer.name,
    Phone: order.customer.phone,
    Email: order.customer.email || '—',
    Deliver_to: order.customer.location || '—',
    Items: order.items.map((i) => `${i.qty} × ${i.name} — ${m(i.price * i.qty)}`).join('\n'),
    Delivery: [
      order.deliveryFee === 0 ? 'Free' : m(order.deliveryFee),
      d.distanceKm !== null && d.distanceKm !== undefined ? `${d.distanceKm} km` : '',
      d.label ? `arrives ${d.label}` : ''
    ].filter(Boolean).join(' · '),
    Payment: order.payment?.status === 'paid' ? 'Paid by M-Pesa' : 'Awaiting M-Pesa payment',
    Notes: order.customer.notes || '—',
    Placed: new Date(order.createdAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }),
    // The admin panel rather than a receipt link: a receipt link carries the
    // order's payment token, which shouldn't travel around in email.
    Manage: `${origin}/admin`
  };

  try {
    const res = await fetch(`${origin}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(6000)
    });
    // Netlify answers an accepted submission with a redirect or a 200.
    if (res.status >= 400) throw new Error(`Netlify answered ${res.status}`);
  } catch (err) {
    log.record(db, {
      type: 'order.alert_failed', actor: 'system', target: order.code, targetId: order.id,
      summary: `The new-order email could not be sent (${err.message || err}). The order itself is saved.`
    });
    await persist(db);
  }
}

/* ----------------------------------------------------------------- routes */
export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(api|\.netlify\/functions\/api)/, '');
  const seg = path.split('/').filter(Boolean);
  const method = req.method;
  const body = ['POST', 'PUT', 'PATCH'].includes(method)
    ? await req.json().catch(() => ({}))
    : {};

  /* ---- product photos ---- */
  if (seg[0] === 'uploads' && seg[1] && method === 'GET') {
    const blob = await media().getWithMetadata(seg[1], { type: 'arrayBuffer' });
    if (!blob) return new Response('Not found', { status: 404 });
    return new Response(blob.data, {
      headers: {
        'Content-Type': (blob.metadata && blob.metadata.type) || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  }

  const db = await load();
  const settings = db.settings;

  /* ---- the shop, for customers ---- */
  if (seg[0] === 'storefront' && method === 'GET') {
    return json(200, {
      settings: publicSettings(settings),
      categories: CATEGORIES,
      products: db.products.filter((p) => p.active).map(publicProduct)
    });
  }

  /* ================================================ customer accounts ==== */

  if (seg[0] === 'account' && seg[1] === 'register' && method === 'POST') {
    const email = normalizeEmail(body.email);
    const name = str(body.name, 80);
    const phone = str(body.phone, 30);
    if (!name) return json(400, { error: 'Please enter your name.' });
    if (!isEmail(email)) return json(400, { error: 'Please enter a valid email address.' });
    if (!phone) return json(400, { error: 'Please enter your phone number.' });
    const problem = passwordProblem(body.password);
    if (problem) return json(400, { error: problem });
    if (db.customers.some((c) => c.email === email)) {
      return json(409, { error: 'You already have an account with that email — please sign in.' });
    }

    const customer = {
      id: newId(),
      name,
      email,
      phone,
      password: hashPassword(body.password),
      address: {
        location: str(body.location, 160),
        lat: body.lat === undefined || body.lat === null ? null : num(body.lat),
        lng: body.lng === undefined || body.lng === null ? null : num(body.lng)
      },
      createdAt: new Date().toISOString()
    };
    db.customers.push(customer);
    log.record(db, {
      type: 'account.created', actor: 'customer',
      target: name, targetId: customer.id, summary: `${name} (${email}) created an account`
    });
    await persist(db);
    return json(201, { token: customerToken(customer.id), customer: publicCustomer(customer) });
  }

  if (seg[0] === 'account' && seg[1] === 'login' && method === 'POST') {
    const email = normalizeEmail(body.email);
    const customer = db.customers.find((c) => c.email === email);
    // Same message either way, so the form cannot be used to discover who has
    // an account here.
    if (!customer || !verifyPassword(str(body.password, 200), customer.password)) {
      return json(401, { error: 'That email and password do not match.' });
    }
    return json(200, { token: customerToken(customer.id), customer: publicCustomer(customer) });
  }

  if (seg[0] === 'account' && seg[1] === 'me') {
    const me = currentCustomer(req, db);
    if (!me) return json(401, { error: 'Please sign in again.' });

    if (method === 'GET') {
      return json(200, {
        customer: publicCustomer(me),
        orders: db.orders
          .filter((o) => o.customerId === me.id)
          .map((o) => ({ ...o, payToken: undefined }))
      });
    }

    if (method === 'PUT') {
      if (body.name !== undefined) me.name = str(body.name, 80) || me.name;
      if (body.phone !== undefined) me.phone = str(body.phone, 30) || me.phone;
      if (body.location !== undefined || body.lat !== undefined) {
        me.address = {
          location: str(body.location ?? me.address?.location, 160),
          lat: body.lat === undefined ? (me.address?.lat ?? null) : num(body.lat),
          lng: body.lng === undefined ? (me.address?.lng ?? null) : num(body.lng)
        };
      }
      if (body.password) {
        const problem = passwordProblem(body.password);
        if (problem) return json(400, { error: problem });
        if (!verifyPassword(str(body.currentPassword, 200), me.password)) {
          return json(401, { error: 'Your current password is not right.' });
        }
        me.password = hashPassword(body.password);
      }
      await persist(db);
      return json(200, { customer: publicCustomer(me) });
    }
  }

  /* ==================================================== delivery quote ==== */

  // The checkout calls this as soon as a location is pinned, so the customer
  // sees the real delivery charge before committing to anything.
  if (seg[0] === 'delivery' && seg[1] === 'quote' && method === 'POST') {
    const subtotal = Math.max(0, Math.round(num(body.subtotal)));
    const dest = num(body.lat) && num(body.lng) ? { lat: num(body.lat), lng: num(body.lng) } : null;
    // Returned flat (not wrapped) because the checkout reads quote.fee,
    // quote.basis and quote.distanceKm straight off the response.
    return json(200, await quoteDelivery(settings, subtotal, dest));
  }

  /* ========================================================== ordering ==== */

  if (seg[0] === 'orders' && method === 'POST' && !seg[1]) {
    const me = currentCustomer(req, db);
    const customer = {
      name: str(body?.customer?.name ?? me?.name, 80),
      phone: str(body?.customer?.phone ?? me?.phone, 30),
      email: normalizeEmail(body?.customer?.email ?? me?.email),
      location: str(body?.customer?.location, 160),
      lat: num(body?.customer?.lat) || null,
      lng: num(body?.customer?.lng) || null,
      notes: str(body?.customer?.notes, 500)
    };
    if (!customer.name || !customer.phone) {
      return json(400, { error: 'Name and phone number are required' });
    }
    if (!customer.location) {
      return json(400, { error: 'Please add your delivery location so we can work out the delivery charge.' });
    }

    const cart = Array.isArray(body?.items) ? body.items.slice(0, 50) : [];
    if (!cart.length) return json(400, { error: 'Your cart is empty' });

    const items = [];
    for (const line of cart) {
      const product = db.products.find((p) => p.id === line.id);
      if (!product || !product.active) {
        return json(400, { error: 'A product in your cart is no longer available' });
      }
      const qty = clamp(Math.round(num(line.qty, 1)), 1, 99);
      if (product.stock < qty) {
        return json(409, {
          error: `Only ${product.stock} left of ${product.name}`,
          productId: product.id, stock: product.stock
        });
      }
      items.push({
        productId: product.id, name: product.name, sku: product.sku,
        price: salePrice(product),
        wasPrice: product.discount > 0 ? Math.round(num(product.price)) : 0,
        qty, image: product.images[0] || ''
      });
    }

    const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const dest = customer.lat && customer.lng ? { lat: customer.lat, lng: customer.lng } : null;
    const delivery = await quoteDelivery(settings, subtotal, dest);

    // The shop is paid up front by M-Pesa — there is no cash on delivery.
    // If M-Pesa is not configured yet the order is still taken and recorded as
    // awaiting payment, so trading never stops; it is simply not marked paid.
    const mpesaLive = Boolean(settings.mpesaEnabled) && mpesaConfigured(settings);

    db.counters.order += 1;
    const order = {
      id: newId(),
      code: `TB-${db.counters.order}`,
      customerId: me?.id || null,
      customer,
      items,
      subtotal,
      deliveryFee: delivery.fee,
      total: subtotal + delivery.fee,
      delivery,
      payment: {
        method: 'mpesa',
        status: 'unpaid',
        mpesaReady: mpesaLive,
        checkoutRequestId: '', receipt: '', phone: '', paidAt: null, failReason: ''
      },
      payToken: crypto.randomBytes(12).toString('base64url'),
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    for (const item of items) {
      const product = db.products.find((p) => p.id === item.productId);
      product.stock = Math.max(0, product.stock - item.qty);
    }
    db.orders.unshift(order);

    log.record(db, {
      type: 'order.placed', actor: 'customer', target: order.code, targetId: order.id,
      summary: `${customer.name} ordered ${items.length} item${items.length === 1 ? '' : 's'} — ${order.total}`,
      meta: { total: order.total, distanceKm: delivery.distanceKm }
    });
    await persist(db);

    await notify(db, {
      when: settings.notifyNewOrder,
      subject: `New order ${order.code} — ${settings.currency || 'KSh'} ${order.total}`,
      body: mailer.orderHtml(order, settings, 'NEW ORDER')
    });
    // Awaited, not fired off: Netlify can freeze a function as soon as it has
    // responded, which would silently drop the email.
    if (settings.notifyNewOrder !== false) await alertNewOrder(db, order, url.origin);

    return json(201, { order });
  }

  /* ---- the receipt, as a page or as data ---- */
  if (seg[0] === 'orders' && seg[1] && seg[2] === 'receipt' && method === 'GET') {
    const order = db.orders.find((o) => o.id === seg[1]);
    const token = url.searchParams.get('token') || '';
    const me = currentCustomer(req, db);
    const allowed = order && (order.payToken === token || (me && order.customerId === me.id) || isAuthed(req));
    if (!allowed) return json(404, { error: 'Receipt not found.' });

    if (url.searchParams.get('format') === 'json') return json(200, { order, settings: publicSettings(settings) });
    return html(200, receiptHtml(order, settings));
  }

  /* ---- M-Pesa: start the prompt on the customer's phone ---- */
  if (seg[0] === 'mpesa' && seg[1] === 'stkpush' && method === 'POST') {
    const order = db.orders.find((o) => o.id === str(body.orderId, 40));
    const given = str(body.payToken ?? body.token, 60);
    if (!order || order.payToken !== given) {
      return json(404, { error: 'Order not found.' });
    }
    if (!settings.mpesaEnabled || !mpesaConfigured(settings)) {
      return json(400, {
        error: 'M-Pesa checkout is not switched on yet. Your order is saved — '
          + 'send it on WhatsApp and we will confirm payment with you.'
      });
    }
    if (order.payment.status === 'paid') return json(200, { alreadyPaid: true });

    const phone = str(body.phone, 20) || order.customer.phone;
    // Safaricom calls us back, so the callback must be a public URL.
    if (!settings.mpesaCallbackUrl) settings.mpesaCallbackUrl = `${url.origin}/api/mpesa/callback`;

    try {
      const push = await stkPush(settings, {
        phone, amount: order.total, reference: order.code,
        description: `Payment for ${order.code}`
      });
      order.payment.method = 'mpesa';
      order.payment.status = 'processing';
      order.payment.checkoutRequestId = push.checkoutRequestId;
      order.payment.phone = normalizePhone(phone);
      log.record(db, {
        type: 'payment.requested', actor: 'customer', target: order.code, targetId: order.id,
        summary: `M-Pesa prompt sent to ${order.payment.phone} for ${order.total}`
      });
      await persist(db);
      return json(200, { message: push.customerMessage, checkoutRequestId: push.checkoutRequestId });
    } catch (err) {
      return json(400, { error: err.message || 'Could not start the M-Pesa payment.' });
    }
  }

  /* ---- M-Pesa: the checkout polls this for the result ---- */
  if (seg[0] === 'orders' && seg[1] && seg[2] === 'payment' && method === 'GET') {
    const order = db.orders.find((o) => o.id === seg[1]);
    if (!order || order.payToken !== (url.searchParams.get('token') || '')) {
      return json(404, { error: 'Order not found.' });
    }
    // If it is still processing, ask Daraja directly in case the callback was missed.
    if (order.payment.status === 'processing' && order.payment.checkoutRequestId) {
      try {
        const q = await stkQuery(settings, order.payment.checkoutRequestId);
        if (q && q.resultCode !== undefined) {
          if (q.resultCode === '0') {
            order.payment.status = 'paid';
            order.payment.paidAt = new Date().toISOString();
          } else if (['1', '1037', '1025', '9999', '2001'].includes(q.resultCode)) {
            order.payment.status = 'failed';
            order.payment.failReason = q.resultDesc;
          }
          await persist(db);
        }
      } catch { /* leave as processing; the callback may still land */ }
    }
    return json(200, {
      status: order.payment.status, method: order.payment.method,
      receipt: order.payment.receipt, code: order.code,
      receiptUrl: `/api/orders/${order.id}/receipt?token=${order.payToken}`
    });
  }

  /* ---- M-Pesa: Safaricom calls this back (public on purpose) ---- */
  if (seg[0] === 'mpesa' && seg[1] === 'callback' && method === 'POST') {
    const cb = parseCallback(body);
    if (cb) {
      const order = db.orders.find((o) => o.payment?.checkoutRequestId === cb.checkoutRequestId);
      if (order) {
        if (cb.resultCode === '0') {
          order.payment.status = 'paid';
          order.payment.receipt = cb.receipt;
          order.payment.paidAt = new Date().toISOString();
          log.record(db, {
            type: 'payment.paid', actor: 'system', target: order.code, targetId: order.id,
            summary: `Paid ${cb.amount} by M-Pesa · ${cb.receipt}`
          });
        } else {
          order.payment.status = 'failed';
          order.payment.failReason = cb.resultDesc;
          log.record(db, {
            type: 'payment.failed', actor: 'system', target: order.code, targetId: order.id,
            summary: cb.resultDesc || 'M-Pesa payment failed'
          });
        }
        await persist(db);
        await notify(db, {
          when: settings.notifyPayment,
          subject: `${cb.resultCode === '0' ? 'Payment received' : 'Payment failed'} — ${order.code}`,
          body: mailer.orderHtml(order, settings, cb.resultCode === '0' ? 'PAYMENT RECEIVED' : 'PAYMENT FAILED')
        });
      }
    }
    // Always acknowledge, so Safaricom stops retrying.
    return json(200, { ResultCode: 0, ResultDesc: 'Accepted' });
  }

  /* ---- signing in as the shop owner ---- */
  if (seg[0] === 'login' && method === 'POST') {
    const given = str(body.password, 200);
    if (!checkAdminPassword(db, given)) {
      log.record(db, { type: 'security.denied', actor: 'system', summary: 'Someone tried the wrong admin password' });
      await persist(db);
      return json(401, { error: 'Incorrect password' });
    }
    // First sign-in after this update: save the environment password as a hash
    // so it can be changed from the panel from now on.
    if (!settings.adminPassword) {
      settings.adminPassword = hashPassword(given);
      settings.passwordIsDefault = given === '1234';
      await persist(db);
    }
    return json(200, { token: adminToken(), passwordIsDefault: Boolean(settings.passwordIsDefault) });
  }

  /* ---- everything past here needs a signed-in admin ---- */
  if (!isAuthed(req)) return json(401, { error: 'Session expired. Please sign in again.' });

  if (seg[0] === 'logout' && method === 'POST') return json(200, { ok: true });

  if (seg[0] === 'admin' && seg[1] === 'overview' && method === 'GET') {
    const threshold = num(settings.lowStockThreshold, 5);
    const paid = new Set(['confirmed', 'delivered']);
    return json(200, {
      settings: adminSettings(settings),
      categories: CATEGORIES,
      products: db.products.map(publicProduct),
      orders: db.orders,
      customers: db.customers.map(publicCustomer),
      activityUnread: log.unreadCount(db),
      stats: {
        totalProducts: db.products.length,
        activeProducts: db.products.filter((p) => p.active).length,
        outOfStock: db.products.filter((p) => p.stock === 0).length,
        lowStock: db.products.filter((p) => p.stock > 0 && p.stock <= threshold).length,
        unitsInStock: db.products.reduce((n, p) => n + p.stock, 0),
        inventoryValue: db.products.reduce((n, p) => n + salePrice(p) * p.stock, 0),
        pendingOrders: db.orders.filter((o) => o.status === 'pending').length,
        totalOrders: db.orders.length,
        totalCustomers: db.customers.length,
        revenue: db.orders.filter((o) => paid.has(o.status)).reduce((n, o) => n + o.total, 0)
      }
    });
  }

  /* ------------------------------------------------ the activity log ---- */

  if (seg[0] === 'admin' && seg[1] === 'activity' && method === 'GET') {
    const group = url.searchParams.get('group') || '';
    const entries = (db.activity || []).filter((a) => !group || a.group === group);
    // Note: a missing ?limit reads as null, and Number(null) is 0 — so default
    // it explicitly rather than through num(), which would slice to nothing.
    const limit = Number(url.searchParams.get('limit')) || 200;
    return json(200, {
      entries: entries.slice(0, limit),
      unread: log.unreadCount(db),
      groups: Object.keys(log.EVENTS).reduce((acc, k) => {
        const g = log.EVENTS[k].group;
        acc[g] = (db.activity || []).filter((a) => a.group === g).length;
        return acc;
      }, {})
    });
  }

  if (seg[0] === 'admin' && seg[1] === 'activity' && seg[2] === 'read' && method === 'POST') {
    for (const a of db.activity || []) a.read = true;
    await persist(db);
    return json(200, { ok: true, unread: 0 });
  }

  /* ---------------------------------------------------- store reports ---- */

  if (seg[0] === 'admin' && seg[1] === 'report' && method === 'GET') {
    const period = ['today', '7d', '30d'].includes(url.searchParams.get('period'))
      ? url.searchParams.get('period') : 'today';
    return json(200, { report: log.buildReport(db, period), emailReady: mailer.isConfigured(settings) });
  }

  if (seg[0] === 'admin' && seg[1] === 'report' && seg[2] === 'send' && method === 'POST') {
    const period = ['today', '7d', '30d'].includes(str(body.period, 8)) ? str(body.period, 8) : 'today';
    const report = log.buildReport(db, period);
    if (!mailer.isConfigured(settings)) {
      return json(400, {
        error: 'Add a Resend API key and a report email address in Settings → Reports first.'
      });
    }
    const result = await mailer.sendEmail(settings, {
      subject: `${settings.storeName || 'Tessora'} store report — ${period}`,
      html: mailer.reportHtml(report, settings)
    });
    if (!result.sent) {
      return json(502, { error: `Could not send the report (${result.reason}). ${result.detail || ''}`.trim() });
    }
    return json(200, { sent: true, to: mailer.reportRecipient(settings) });
  }

  /* --------------------------------------------- downloads & the books ---- */

  // Everything the shop owner can take away: the books, the stock list, the
  // order history, and a complete backup of the database.
  if (seg[0] === 'admin' && seg[1] === 'export' && seg[2] && method === 'GET') {
    const what = seg[2];
    const format = url.searchParams.get('format') || 'csv';
    const asked = url.searchParams.get('period');
    const period = Object.keys(fin.PERIOD_LABELS).includes(asked) ? asked : '30d';
    const stamp = new Date().toISOString().slice(0, 10);

    if (what === 'inventory') {
      return file(fin.inventoryCsv(db), `tessora-inventory-${stamp}.csv`);
    }
    if (what === 'orders') {
      return file(fin.ordersCsv(db), `tessora-orders-${stamp}.csv`);
    }
    if (what === 'balance-sheet') {
      const sheet = fin.buildBalanceSheet(db);
      if (format === 'json') return json(200, { sheet });
      if (format === 'html') return html(200, fin.balanceSheetHtml(sheet, settings));
      return file(fin.balanceSheetCsv(sheet, settings.currency), `tessora-balance-sheet-${stamp}.csv`);
    }
    if (what === 'financials') {
      const report = fin.buildFinancials(db, period);
      if (format === 'json') return json(200, { financials: report });
      if (format === 'html') return html(200, fin.financialsHtml(report, settings));
      return file(fin.financialsCsv(report, settings.currency), `tessora-financials-${period}-${stamp}.csv`);
    }
    if (what === 'backup') {
      // The whole database, minus the secrets that must never leave the server.
      const { adminPassword, mpesaConsumerSecret, mpesaPasskey, emailApiKey, ...safeSettings } = settings;
      const backup = {
        exportedAt: new Date().toISOString(),
        note: 'Tessora Beauty backup. Passwords and payment secrets are deliberately excluded.',
        settings: safeSettings,
        products: db.products,
        orders: db.orders,
        customers: (db.customers || []).map(publicCustomer),
        activity: db.activity,
        counters: db.counters
      };
      return file(JSON.stringify(backup, null, 2), `tessora-backup-${stamp}.json`, 'application/json');
    }
    return json(404, { error: 'Unknown export' });
  }

  /* -------------------------------------------------------- products ---- */
  if (seg[0] === 'admin' && seg[1] === 'products') {
    const id = seg[2];

    if (method === 'POST' && !id) {
      const product = normalize(body);
      for (const img of (Array.isArray(body.newImages) ? body.newImages.slice(0, 5) : [])) {
        product.images.push(await saveImage(img));
      }
      db.products.unshift(product);
      const entry = log.record(db, {
        type: 'product.created', target: product.name, targetId: product.id,
        summary: `Added at ${product.price} with ${product.stock} in stock`
      });
      await persist(db);
      await notify(db, {
        when: settings.notifyAdminChanges,
        subject: `Product added — ${product.name}`,
        body: mailer.activityHtml(entry, settings)
      });
      return json(201, { product: publicProduct(product) });
    }

    const product = db.products.find((p) => p.id === id);
    if (id && !product) return json(404, { error: 'Product not found' });

    if (method === 'PUT' && product) {
      const before = { ...product };
      const updated = normalize(body, product);
      if (Array.isArray(body.images)) {
        const kept = body.images.filter((u) => product.images.includes(u));
        product.images.filter((u) => !kept.includes(u)).forEach(dropImage);
        updated.images = kept;
      }
      for (const img of (Array.isArray(body.newImages) ? body.newImages.slice(0, 5) : [])) {
        updated.images.push(await saveImage(img));
      }
      Object.assign(product, updated);
      const changes = log.diff(before, product, PRODUCT_FIELDS);
      const entry = log.record(db, {
        type: 'product.updated', target: product.name, targetId: product.id, changes
      });
      await persist(db);
      if (changes.length) {
        await notify(db, {
          when: settings.notifyAdminChanges,
          subject: `Product edited — ${product.name}`,
          body: mailer.activityHtml(entry, settings)
        });
      }
      return json(200, { product: publicProduct(product) });
    }

    if (method === 'PATCH' && product) {
      const before = { ...product };
      if (body.stockDelta !== undefined) {
        product.stock = Math.max(0, product.stock + Math.round(num(body.stockDelta)));
      }
      if (body.stock !== undefined) product.stock = Math.max(0, Math.round(num(body.stock)));
      if (body.active !== undefined) product.active = Boolean(body.active);
      if (body.featured !== undefined) product.featured = Boolean(body.featured);
      if (body.discount !== undefined) product.discount = clamp(Math.round(num(body.discount)), 0, 95);
      if (body.costPrice !== undefined) product.costPrice = Math.max(0, Math.round(num(body.costPrice)));
      if (body.price !== undefined && Math.round(num(body.price)) > 0) {
        product.price = Math.round(num(body.price));
      }
      product.updatedAt = new Date().toISOString();

      const changes = log.diff(before, product, PRODUCT_FIELDS);
      if (changes.length) {
        // Stock moves are the everyday case, so give them their own event type
        // rather than burying them in generic edits.
        const onlyStock = changes.every((c) => c.field === 'stock');
        log.record(db, {
          type: onlyStock ? 'product.stock' : (changes.some((c) => c.field === 'price') ? 'product.price' : 'product.updated'),
          target: product.name, targetId: product.id, changes
        });
      }
      await persist(db);
      return json(200, { product: publicProduct(product) });
    }

    if (method === 'DELETE' && product) {
      product.images.forEach(dropImage);
      db.products = db.products.filter((p) => p.id !== id);
      log.record(db, {
        type: 'product.deleted', target: product.name, targetId: product.id,
        summary: `Deleted (was ${product.price}, ${product.stock} in stock)`
      });
      await persist(db);
      return json(200, { ok: true });
    }
  }

  /* ---------------------------------------------------------- orders ---- */
  if (seg[0] === 'admin' && seg[1] === 'orders' && seg[2] && method === 'PATCH') {
    const order = db.orders.find((o) => o.id === seg[2]);
    if (!order) return json(404, { error: 'Order not found' });
    const status = str(body.status, 20);
    if (!['pending', 'confirmed', 'delivered', 'cancelled'].includes(status)) {
      return json(400, { error: 'Unknown status' });
    }
    const previous = order.status;
    if (status === 'cancelled' && previous !== 'cancelled') {
      for (const item of order.items) {
        const p = db.products.find((x) => x.id === item.productId);
        if (p) p.stock += item.qty;
      }
    }
    if (previous === 'cancelled' && status !== 'cancelled') {
      for (const item of order.items) {
        const p = db.products.find((x) => x.id === item.productId);
        if (p) p.stock = Math.max(0, p.stock - item.qty);
      }
    }
    order.status = status;
    order.updatedAt = new Date().toISOString();

    const type = { confirmed: 'order.confirmed', cancelled: 'order.cancelled', delivered: 'order.delivered' }[status]
      || 'order.status';
    log.record(db, {
      type, target: order.code, targetId: order.id,
      summary: `${previous} → ${status} · ${order.customer?.name}`,
      changes: [{ field: 'status', label: 'Status', from: previous, to: status }]
    });
    await persist(db);

    await notify(db, {
      when: settings.notifyStatusChange,
      subject: `Order ${order.code} ${status}`,
      body: mailer.orderHtml(order, settings, `ORDER ${status.toUpperCase()}`)
    });

    return json(200, { order });
  }

  /* -------------------------------------------------------- settings ---- */
  if (seg[0] === 'admin' && seg[1] === 'settings' && method === 'PUT') {
    const s = settings;
    const before = { ...s };

    if (body.storeName !== undefined) s.storeName = str(body.storeName, 60) || s.storeName;
    if (body.tagline !== undefined) s.tagline = str(body.tagline, 120);
    if (body.whatsapp !== undefined) s.whatsapp = str(body.whatsapp, 20).replace(/\D/g, '');
    if (body.instagram !== undefined) s.instagram = str(body.instagram, 40).replace(/^@/, '');
    if (body.tiktok !== undefined) s.tiktok = str(body.tiktok, 40).replace(/^@/, '');
    if (body.email !== undefined) s.email = str(body.email, 120);
    if (body.location !== undefined) s.location = str(body.location, 80);
    if (body.currency !== undefined) s.currency = str(body.currency, 8) || 'KSh';
    if (body.announcement !== undefined) s.announcement = str(body.announcement, 160);
    if (body.deliveryFee !== undefined) s.deliveryFee = Math.max(0, Math.round(num(body.deliveryFee)));
    if (body.freeDeliveryOver !== undefined) s.freeDeliveryOver = Math.max(0, Math.round(num(body.freeDeliveryOver)));
    if (body.lowStockThreshold !== undefined) {
      s.lowStockThreshold = clamp(Math.round(num(body.lowStockThreshold, 5)), 1, 100);
    }

    // delivery by distance + maps
    if (body.deliveryPerKm !== undefined) s.deliveryPerKm = Math.max(0, Math.round(num(body.deliveryPerKm, DEFAULT_PER_KM)));
    if (body.deliveryBaseFee !== undefined) s.deliveryBaseFee = Math.max(0, Math.round(num(body.deliveryBaseFee)));
    if (body.storeLat !== undefined) s.storeLat = num(body.storeLat, s.storeLat);
    if (body.storeLng !== undefined) s.storeLng = num(body.storeLng, s.storeLng);
    if (body.mapsApiKey !== undefined) s.mapsApiKey = str(body.mapsApiKey, 120);

    // M-Pesa — blank means "leave the saved secret alone"
    if (body.mpesaEnabled !== undefined) s.mpesaEnabled = Boolean(body.mpesaEnabled);
    if (body.mpesaEnv !== undefined) s.mpesaEnv = ['sandbox', 'production'].includes(body.mpesaEnv) ? body.mpesaEnv : s.mpesaEnv;
    if (body.mpesaType !== undefined) s.mpesaType = ['paybill', 'till'].includes(body.mpesaType) ? body.mpesaType : s.mpesaType;
    if (body.mpesaShortcode !== undefined) s.mpesaShortcode = str(body.mpesaShortcode, 20).replace(/\D/g, '');
    if (body.mpesaTill !== undefined) s.mpesaTill = str(body.mpesaTill, 20).replace(/\D/g, '');
    if (body.mpesaConsumerKey !== undefined) s.mpesaConsumerKey = str(body.mpesaConsumerKey, 120);
    if (body.mpesaConsumerSecret) s.mpesaConsumerSecret = str(body.mpesaConsumerSecret, 120);
    if (body.mpesaPasskey) s.mpesaPasskey = str(body.mpesaPasskey, 160);
    if (body.mpesaCallbackUrl !== undefined) s.mpesaCallbackUrl = str(body.mpesaCallbackUrl, 200);

    // reports and alerts
    if (body.reportEmail !== undefined) s.reportEmail = str(body.reportEmail, 160);
    if (body.emailFrom !== undefined) s.emailFrom = str(body.emailFrom, 160);
    if (body.emailApiKey) s.emailApiKey = str(body.emailApiKey, 120);
    if (body.emailApiKey === '') s.emailApiKey = '';
    for (const k of ['notifyNewOrder', 'notifyPayment', 'notifyStatusChange', 'notifyAdminChanges']) {
      if (body[k] !== undefined) s[k] = Boolean(body[k]);
    }

    const changes = log.diff(before, s, {
      storeName: 'Store name', tagline: 'Tagline', whatsapp: 'WhatsApp', instagram: 'Instagram',
      tiktok: 'TikTok', email: 'Email', location: 'Location', currency: 'Currency',
      announcement: 'Announcement', deliveryFee: 'Flat delivery fee',
      freeDeliveryOver: 'Free delivery over', lowStockThreshold: 'Low stock alert',
      deliveryPerKm: 'Delivery per km', deliveryBaseFee: 'Delivery base fee',
      storeLat: 'Store latitude', storeLng: 'Store longitude',
      mpesaEnabled: 'M-Pesa enabled', mpesaEnv: 'M-Pesa environment',
      mpesaType: 'M-Pesa type', mpesaShortcode: 'M-Pesa shortcode', mpesaTill: 'M-Pesa till',
      reportEmail: 'Report email', notifyNewOrder: 'Alert on new order',
      notifyPayment: 'Alert on payment', notifyStatusChange: 'Alert on status change',
      notifyAdminChanges: 'Alert on every edit'
    });
    if (changes.length) log.record(db, { type: 'settings.updated', target: 'Settings', changes });

    await persist(db);
    return json(200, { settings: adminSettings(s) });
  }

  /* -------------------------------------------------------- password ---- */
  if (seg[0] === 'admin' && seg[1] === 'password' && method === 'PUT') {
    const current = str(body.currentPassword, 200);
    if (!checkAdminPassword(db, current)) {
      log.record(db, { type: 'security.denied', summary: 'Password change attempted with the wrong current password' });
      await persist(db);
      return json(401, { error: 'Your current password is not right.' });
    }
    const problem = passwordProblem(body.newPassword);
    if (problem) return json(400, { error: problem });

    settings.adminPassword = hashPassword(str(body.newPassword, 200));
    settings.passwordIsDefault = false;
    const entry = log.record(db, {
      type: 'security.password', target: 'Admin password',
      summary: 'The admin password was changed'
    });
    await persist(db);

    await notify(db, {
      when: true, // always worth telling the owner, whatever the alert settings say
      subject: 'Your Tessora admin password was changed',
      body: mailer.activityHtml(entry, settings)
    });

    // The old token stays valid for this session; signing out will need the new one.
    return json(200, { ok: true });
  }

  return json(404, { error: 'Unknown endpoint' });
}

export const config = { path: ['/api/*', '/uploads/*'] };
