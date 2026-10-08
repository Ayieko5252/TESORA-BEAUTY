// Tessora Beauty - zero-dependency HTTP server (API + static files).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  db, saveNow, newId, nextOrderCode, hashPassword, verifyPassword, isFreshInstall,
  CATEGORIES, UPLOAD_DIR
} from './db.js';
import { stkPush, stkQuery, parseCallback, normalizePhone, isConfigured as mpesaConfigured } from './mpesa.js';
import { quoteDelivery } from './lib/pricing.js';
import { receiptHtml } from './lib/receipt.js';
import * as fin from './lib/finance.js';
import * as log from './lib/activity.js';
import * as mailer from './lib/email.js';
import {
  hashPassword as hashPw, verifyPassword as verifyPw, passwordProblem,
  normalizeEmail, isEmail, publicCustomer
} from './lib/auth.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 12 * 1024 * 1024; // 12MB - covers base64 image uploads

/* ------------------------------------------------------------------ auth */
const sessions = new Map(); // token -> expiry
const SESSION_TTL = 1000 * 60 * 60 * 8;

function issueToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function isAuthed(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  sessions.set(token, Date.now() + SESSION_TTL); // sliding expiry
  return true;
}

/* --- customer sessions, kept separate from the shop owner's --- */
const customerSessions = new Map(); // token -> { id, expires }
const CUSTOMER_TTL = 1000 * 60 * 60 * 24 * 30;

function issueCustomerToken(id) {
  const token = crypto.randomBytes(24).toString('base64url');
  customerSessions.set(token, { id, expires: Date.now() + CUSTOMER_TTL });
  return token;
}

/** The signed-in shopper for this request, or null. */
function currentCustomer(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = customerSessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { customerSessions.delete(token); return null; }
  return (db.customers || []).find((c) => c.id === session.id) || null;
}

/**
 * Email the shop owner about something, if they asked for that alert.
 * Fire-and-forget: the event is already in the activity log, which is the
 * record that matters, so a mail failure must never fail the request.
 */
function notifyOwner({ when, subject, body }) {
  if (!when) return;
  const settings = db.settings;
  if (!mailer.isConfigured(settings)) return;
  mailer.sendEmail(settings, { subject, html: body }).catch(() => {});
}

// throttle login attempts per IP
const attempts = new Map();
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return rec.count >= 8;
}
function noteAttempt(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const rec = attempts.get(ip) || { count: 0, first: Date.now() };
  rec.count += 1;
  attempts.set(ip, rec);
}

/* ----------------------------------------------------------------- utils */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function salePrice(p) {
  const discount = clamp(num(p.discount), 0, 95);
  return Math.round(num(p.price) * (1 - discount / 100));
}

// Named fields only, never a spread. costPrice is what the owner pays her
// supplier, and spreading the record published her margin to anyone who
// opened the storefront. Kept identical to the same list in the Netlify
// function, so the two backends cannot drift apart on this.
const PUBLIC_PRODUCT_FIELDS = [
  'id', 'name', 'slug', 'category', 'brand', 'description',
  'price', 'discount', 'stock', 'sku', 'images', 'featured', 'active',
  'createdAt', 'updatedAt'
];
function publicProduct(p) {
  const out = { salePrice: salePrice(p) };
  for (const k of PUBLIC_PRODUCT_FIELDS) if (k in p) out[k] = p[k];
  return out;
}

/** Everything, cost price included. Only ever used behind the admin gate. */
function adminProduct(p) {
  return { ...p, salePrice: salePrice(p) };
}

/* ---------------------------------------------------------- settings view */
// Only these settings are ever sent to the public storefront. M-Pesa secrets,
// the passkey and the admin password are deliberately NOT in this list.
const PUBLIC_SETTING_KEYS = [
  'storeName', 'tagline', 'whatsapp', 'instagram', 'tiktok', 'email', 'location',
  'currency', 'announcement', 'deliveryFee', 'freeDeliveryOver', 'lowStockThreshold',
  'deliveryPerKm', 'deliveryBaseFee', 'storeLat', 'storeLng', 'mapsApiKey', 'googleClientId'
];
function publicSettings(s) {
  const out = {};
  for (const k of PUBLIC_SETTING_KEYS) out[k] = s[k];
  out.mpesaEnabled = Boolean(s.mpesaEnabled) && mpesaConfigured(s); // only advertise M-Pesa when it truly works
  return out;
}
// The admin panel sees everything except the password hash, but with secrets masked
// so they are never re-sent to the browser after being saved once.
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

// The product fields worth recording in the activity log, with the labels the
// admin panel and the emailed report show.
const PRODUCT_FIELDS = {
  name: 'Name', category: 'Category', brand: 'Brand', price: 'Price',
  costPrice: 'Cost price',
  discount: 'Discount %', stock: 'Stock', sku: 'SKU',
  active: 'Visible', featured: 'Bestseller', description: 'Description'
};

/* --------------------------------------------------------------- distance */
// Work out the delivery fee for an order. Free over the threshold; otherwise
// per-km from the store when we have coordinates, else the flat fee.
// Delegates to lib/pricing.js so the local server and the Netlify function
// quote exactly the same fee and the same estimated delivery time.
async function computeDelivery(settings, subtotal, coords) {
  const hasCoords = coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng);
  return quoteDelivery(settings, subtotal, hasCoords ? coords : null);
}

/* --------------------------------------------------------------- uploads */
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

function saveDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('Unsupported image format');
  const ext = IMAGE_TYPES[m[1]];
  if (!ext) throw new Error('Images must be PNG, JPG, WEBP or GIF');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) throw new Error('Image is larger than 6MB');
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return `/uploads/${name}`;
}

function deleteUpload(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  fs.rm(file, { force: true }, () => {});
}

/* ------------------------------------------------------------ static file */
function serveStatic(req, res, urlPath) {
  let baseDir = PUBLIC_DIR;
  let rel = urlPath;

  if (urlPath.startsWith('/uploads/')) {
    baseDir = UPLOAD_DIR;
    rel = urlPath.slice('/uploads'.length);
  }

  let filePath = path.join(baseDir, decodeURIComponent(rel));
  if (!filePath.startsWith(baseDir)) return sendJSON(res, 403, { error: 'Forbidden' });

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    // pretty urls: /admin -> /admin.html
    if (fs.existsSync(`${filePath}.html`)) filePath = `${filePath}.html`;
    else return notFound(res);
  }

  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'ETag': etag,
    'Cache-Control': urlPath.startsWith('/uploads/') ? 'public, max-age=604800' : 'no-cache'
  });
  fs.createReadStream(filePath).pipe(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/* -------------------------------------------------------------- products */
function normalizeProduct(input, existing = {}) {
  const name = str(input.name ?? existing.name, 120);
  if (!name) throw new Error('Product name is required');

  const price = Math.round(num(input.price ?? existing.price, 0));
  if (price <= 0) throw new Error('Price must be greater than 0');

  const stock = Math.max(0, Math.round(num(input.stock ?? existing.stock, 0)));
  const discount = clamp(Math.round(num(input.discount ?? existing.discount, 0)), 0, 95);
  const category = CATEGORIES.includes(input.category) ? input.category : (existing.category || CATEGORIES[0]);

  return {
    id: existing.id || newId(),
    name,
    slug: slugify(name),
    category,
    brand: str(input.brand ?? existing.brand, 60),
    description: str(input.description ?? existing.description, 1500),
    price,
    // What you paid for it. Optional, but without it the shop cannot work out
    // profit, so the financial statements say so rather than guessing.
    costPrice: Math.max(0, Math.round(num(input.costPrice ?? existing.costPrice, 0))),
    discount,
    stock,
    sku: str(input.sku ?? existing.sku, 40) || `TB-${slugify(name).slice(0, 12).toUpperCase()}`,
    images: Array.isArray(existing.images) ? existing.images : [],
    featured: Boolean(input.featured ?? existing.featured ?? false),
    active: input.active === undefined ? (existing.active ?? true) : Boolean(input.active),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ API */
async function api(req, res, url) {
  const route = url.pathname.split('/').filter(Boolean).slice(1); // drop 'api'
  const method = req.method;
  const settings = db.settings;

  /* ---- public ---- */
  if (route[0] === 'storefront' && method === 'GET') {
    const products = db.products.filter((p) => p.active).map(publicProduct);
    return sendJSON(res, 200, { settings: publicSettings(settings), categories: CATEGORIES, products });
  }

  /* ============================================== customer accounts ==== */

  if (route[0] === 'account' && route[1] === 'register' && method === 'POST') {
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const name = str(body.name, 80);
    const phone = str(body.phone, 30);
    if (!name) return sendJSON(res, 400, { error: 'Please enter your name.' });
    if (!isEmail(email)) return sendJSON(res, 400, { error: 'Please enter a valid email address.' });
    if (!phone) return sendJSON(res, 400, { error: 'Please enter your phone number.' });
    const problem = passwordProblem(body.password);
    if (problem) return sendJSON(res, 400, { error: problem });
    if (db.customers.some((c) => c.email === email)) {
      return sendJSON(res, 409, { error: 'You already have an account with that email, please sign in.' });
    }

    const customer = {
      id: newId(), name, email, phone,
      password: hashPw(body.password),
      address: {
        location: str(body.location, 160),
        lat: body.lat === undefined || body.lat === null ? null : num(body.lat),
        lng: body.lng === undefined || body.lng === null ? null : num(body.lng)
      },
      createdAt: new Date().toISOString()
    };
    db.customers.push(customer);
    log.record(db, {
      type: 'account.created', actor: 'customer', target: name, targetId: customer.id,
      summary: `${name} (${email}) created an account`
    });
    saveNow();
    return sendJSON(res, 201, { token: issueCustomerToken(customer.id), customer: publicCustomer(customer) });
  }

  if (route[0] === 'account' && route[1] === 'login' && method === 'POST') {
    const body = await readBody(req);
    const customer = db.customers.find((c) => c.email === normalizeEmail(body.email));
    // The same message either way, so this cannot be used to discover who
    // has an account here.
    if (!customer || !verifyPw(str(body.password, 200), customer.password)) {
      return sendJSON(res, 401, { error: 'That email and password do not match.' });
    }
    return sendJSON(res, 200, { token: issueCustomerToken(customer.id), customer: publicCustomer(customer) });
  }

  if (route[0] === 'account' && route[1] === 'me') {
    const me = currentCustomer(req);
    if (!me) return sendJSON(res, 401, { error: 'Please sign in again.' });

    if (method === 'GET') {
      return sendJSON(res, 200, {
        customer: publicCustomer(me),
        orders: db.orders.filter((o) => o.customerId === me.id)
      });
    }

    if (method === 'PUT') {
      const body = await readBody(req);
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
        if (problem) return sendJSON(res, 400, { error: problem });
        if (!verifyPw(str(body.currentPassword, 200), me.password)) {
          return sendJSON(res, 401, { error: 'Your current password is not right.' });
        }
        me.password = hashPw(body.password);
      }
      saveNow();
      return sendJSON(res, 200, { customer: publicCustomer(me) });
    }
  }

  // Live delivery quote for the checkout: given a dropped pin, return the fee.
  if (route[0] === 'delivery' && route[1] === 'quote' && method === 'POST') {
    const body = await readBody(req);
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const subtotal = Math.max(0, Math.round(num(body.subtotal, 0)));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return sendJSON(res, 400, { error: 'Please choose a delivery point on the map.' });
    }
    const quote = await computeDelivery(settings, subtotal, { lat, lng });
    return sendJSON(res, 200, quote);
  }

  if (route[0] === 'orders' && method === 'POST') {
    const body = await readBody(req);
    const lat = Number(body?.customer?.lat);
    const lng = Number(body?.customer?.lng);
    const customer = {
      name: str(body?.customer?.name, 80),
      phone: str(body?.customer?.phone, 30),
      location: str(body?.customer?.location, 160),
      notes: str(body?.customer?.notes, 500),
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null
    };
    // Phone number AND delivery location are both required.
    if (!customer.name) return sendJSON(res, 400, { error: 'Please enter your full name.' });
    if (!customer.phone) return sendJSON(res, 400, { error: 'A phone number is required.' });
    if (!customer.location) return sendJSON(res, 400, { error: 'A delivery location is required.' });

    const cart = Array.isArray(body?.items) ? body.items.slice(0, 50) : [];
    if (!cart.length) return sendJSON(res, 400, { error: 'Your cart is empty' });

    const products = db.products;
    const items = [];
    for (const line of cart) {
      const product = products.find((p) => p.id === line.id);
      if (!product || !product.active) {
        return sendJSON(res, 400, { error: 'A product in your cart is no longer available' });
      }
      const qty = clamp(Math.round(num(line.qty, 1)), 1, 99);
      if (product.stock < qty) {
        return sendJSON(res, 409, {
          error: `Only ${product.stock} left of ${product.name}`,
          productId: product.id, stock: product.stock
        });
      }
      items.push({
        productId: product.id, name: product.name, sku: product.sku,
        price: salePrice(product), qty, image: product.images[0] || ''
      });
    }

    const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    const delivery = await computeDelivery(settings, subtotal,
      customer.lat !== null ? { lat: customer.lat, lng: customer.lng } : null);

    // The shop is paid up front by M-Pesa, there is no cash on delivery.
    // If M-Pesa is not configured yet the order is still taken and recorded as
    // awaiting payment, so trading never stops; it is simply not marked paid.
    const mpesaLive = Boolean(settings.mpesaEnabled) && mpesaConfigured(settings);

    const buyer = currentCustomer(req);
    const order = {
      id: newId(), code: nextOrderCode(),
      customerId: buyer?.id || null,
      customer, items,
      subtotal,
      deliveryFee: delivery.fee,
      distanceKm: delivery.distanceKm,
      delivery,                    // the full breakdown the receipt shows
      total: subtotal + delivery.fee,
      status: 'pending',
      payToken: newId(), // lets the buyer check their own payment without logging in
      payment: {
        method: 'mpesa',
        status: 'unpaid',
        mpesaReady: mpesaLive,
        checkoutRequestId: '', receipt: '', paidAt: null
      },
      createdAt: new Date().toISOString()
    };

    for (const item of items) {
      const product = products.find((p) => p.id === item.productId);
      product.stock = Math.max(0, product.stock - item.qty);
    }
    db.orders.unshift(order);
    log.record(db, {
      type: 'order.placed', actor: 'customer', target: order.code, targetId: order.id,
      summary: `${customer.name} ordered ${items.length} item${items.length === 1 ? '' : 's'}, ${order.total}`
    });
    saveNow();
    notifyOwner({
      when: settings.notifyNewOrder,
      subject: `New order ${order.code}, ${settings.currency || 'KSh'} ${order.total}`,
      body: mailer.orderHtml(order, settings, 'NEW ORDER')
    });
    return sendJSON(res, 201, { order });
  }

  /* ---- the receipt, as a page or as data ---- */
  if (route[0] === 'orders' && route[1] && route[2] === 'receipt' && method === 'GET') {
    const order = db.orders.find((o) => o.id === route[1]);
    const token = url.searchParams.get('token') || '';
    const me = currentCustomer(req);
    const allowed = order
      && (order.payToken === token || (me && order.customerId === me.id) || isAuthed(req));
    if (!allowed) return sendJSON(res, 404, { error: 'Receipt not found.' });
    if (url.searchParams.get('format') === 'json') return sendJSON(res, 200, { order, settings: publicSettings(settings) });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(receiptHtml(order, settings));
  }

  /* ---- M-Pesa: start a payment for an order the customer just placed ---- */
  if (route[0] === 'mpesa' && route[1] === 'stkpush' && method === 'POST') {
    const body = await readBody(req);
    const order = db.orders.find((o) => o.id === str(body.orderId, 60));
    if (!order || order.payToken !== str(body.payToken, 60)) {
      return sendJSON(res, 404, { error: 'Order not found.' });
    }
    if (!settings.mpesaEnabled || !mpesaConfigured(settings)) {
      return sendJSON(res, 400, {
        error: 'M-Pesa checkout is not switched on yet. Your order is saved, '
          + 'send it on WhatsApp and we will confirm payment with you.'
      });
    }
    if (order.payment.status === 'paid') return sendJSON(res, 200, { alreadyPaid: true });

    const phone = str(body.phone, 20) || order.customer.phone;
    try {
      const push = await stkPush(settings, {
        phone, amount: order.total, reference: order.code,
        description: `Payment for ${order.code}`
      });
      order.payment.method = 'mpesa';
      order.payment.status = 'processing';
      order.payment.checkoutRequestId = push.checkoutRequestId;
      order.payment.phone = normalizePhone(phone);
      saveNow();
      return sendJSON(res, 200, { message: push.customerMessage, checkoutRequestId: push.checkoutRequestId });
    } catch (err) {
      return sendJSON(res, 400, { error: err.message || 'Could not start the M-Pesa payment.' });
    }
  }

  /* ---- M-Pesa: the customer's checkout polls this for the result ---- */
  if (route[0] === 'orders' && route[2] === 'payment' && method === 'GET') {
    const order = db.orders.find((o) => o.id === route[1]);
    if (!order || order.payToken !== (url.searchParams.get('token') || '')) {
      return sendJSON(res, 404, { error: 'Order not found.' });
    }
    // If still processing, ask Daraja directly in case the callback was missed.
    if (order.payment.status === 'processing' && order.payment.checkoutRequestId) {
      try {
        const q = await stkQuery(settings, order.payment.checkoutRequestId);
        if (q && q.resultCode !== undefined) {
          if (q.resultCode === '0') { order.payment.status = 'paid'; order.payment.paidAt = new Date().toISOString(); }
          else if (q.resultCode !== '1032' && q.resultCode !== '') { /* keep processing on cancel-in-progress */ }
          if (['1', '1037', '1025', '9999', '2001'].includes(q.resultCode)) order.payment.status = 'failed';
          saveNow();
        }
      } catch { /* leave as processing; the callback may still land */ }
    }
    return sendJSON(res, 200, {
      status: order.payment.status, method: order.payment.method,
      receipt: order.payment.receipt, code: order.code
    });
  }

  /* ---- M-Pesa: Safaricom calls this back (no auth, must be public) ---- */
  if (route[0] === 'mpesa' && route[1] === 'callback' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const cb = parseCallback(body);
    if (cb) {
      const order = db.orders.find((o) => o.payment?.checkoutRequestId === cb.checkoutRequestId);
      if (order) {
        if (cb.resultCode === '0') {
          order.payment.status = 'paid';
          order.payment.receipt = cb.receipt;
          order.payment.paidAt = new Date().toISOString();
        } else {
          order.payment.status = 'failed';
          order.payment.failReason = cb.resultDesc;
        }
        saveNow();
      }
    }
    // Always acknowledge so Safaricom stops retrying.
    return sendJSON(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
  }

  /* ---- auth ---- */
  if (route[0] === 'login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (tooManyAttempts(ip)) {
      return sendJSON(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const body = await readBody(req);
    const ok = verifyPassword(str(body.password, 200), settings.adminPassword);
    noteAttempt(ip, ok);
    if (!ok) return sendJSON(res, 401, { error: 'Incorrect password' });
    return sendJSON(res, 200, { token: issueToken(), passwordIsDefault: Boolean(settings.passwordIsDefault) });
  }

  /* ---- everything below requires auth ---- */
  if (!isAuthed(req)) return sendJSON(res, 401, { error: 'Session expired. Please sign in again.' });

  if (route[0] === 'logout' && method === 'POST') {
    sessions.delete((req.headers.authorization || '').slice(7));
    return sendJSON(res, 200, { ok: true });
  }

  if (route[0] === 'admin' && route[1] === 'overview' && method === 'GET') {
    const products = db.products;
    const orders = db.orders;
    const threshold = num(settings.lowStockThreshold, 5);
    const paidStatuses = new Set(['confirmed', 'delivered']);
    return sendJSON(res, 200, {
      settings: adminSettings(settings),
      categories: CATEGORIES,
      products: products.map(adminProduct),
      orders,
      customers: (db.customers || []).map(publicCustomer),
      activityUnread: log.unreadCount(db),
      stats: {
        totalCustomers: (db.customers || []).length,
        totalProducts: products.length,
        activeProducts: products.filter((p) => p.active).length,
        outOfStock: products.filter((p) => p.stock === 0).length,
        lowStock: products.filter((p) => p.stock > 0 && p.stock <= threshold).length,
        unitsInStock: products.reduce((s, p) => s + p.stock, 0),
        inventoryValue: products.reduce((s, p) => s + salePrice(p) * p.stock, 0),
        pendingOrders: orders.filter((o) => o.status === 'pending').length,
        totalOrders: orders.length,
        revenue: orders.filter((o) => paidStatuses.has(o.status)).reduce((s, o) => s + o.total, 0)
      }
    });
  }

  /* ------------------------------------------------ the activity log ---- */

  if (route[0] === 'admin' && route[1] === 'activity' && method === 'GET') {
    const group = url.searchParams.get('group') || '';
    const entries = (db.activity || []).filter((a) => !group || a.group === group);
    // A missing ?limit reads as null and Number(null) is 0, so default it here
    // rather than through num(), which would slice the log down to nothing.
    const limit = Number(url.searchParams.get('limit')) || 200;
    return sendJSON(res, 200, {
      entries: entries.slice(0, limit),
      unread: log.unreadCount(db),
      groups: Object.keys(log.EVENTS).reduce((acc, k) => {
        const g = log.EVENTS[k].group;
        acc[g] = (db.activity || []).filter((a) => a.group === g).length;
        return acc;
      }, {})
    });
  }

  if (route[0] === 'admin' && route[1] === 'activity' && route[2] === 'read' && method === 'POST') {
    for (const a of db.activity || []) a.read = true;
    saveNow();
    return sendJSON(res, 200, { ok: true, unread: 0 });
  }

  /* ---------------------------------------------------- store reports ---- */

  if (route[0] === 'admin' && route[1] === 'report' && method === 'GET') {
    const asked = url.searchParams.get('period');
    const period = ['today', '7d', '30d'].includes(asked) ? asked : 'today';
    return sendJSON(res, 200, {
      report: log.buildReport(db, period),
      emailReady: mailer.isConfigured(settings)
    });
  }

  if (route[0] === 'admin' && route[1] === 'report' && route[2] === 'send' && method === 'POST') {
    const body = await readBody(req);
    const asked = str(body.period, 8);
    const period = ['today', '7d', '30d'].includes(asked) ? asked : 'today';
    if (!mailer.isConfigured(settings)) {
      return sendJSON(res, 400, {
        error: 'Add a Resend API key and a report email address in Settings → Reports first.'
      });
    }
    const result = await mailer.sendEmail(settings, {
      subject: `${settings.storeName || 'Tessora'} store report, ${period}`,
      html: mailer.reportHtml(log.buildReport(db, period), settings)
    });
    if (!result.sent) {
      return sendJSON(res, 502, { error: `Could not send the report (${result.reason}). ${result.detail || ''}`.trim() });
    }
    return sendJSON(res, 200, { sent: true, to: mailer.reportRecipient(settings) });
  }

  /* --------------------------------------------- downloads & the books ---- */

  // Everything the shop owner can take away: the books, the stock list, the
  // order history, and a complete backup of the database.
  if (route[0] === 'admin' && route[1] === 'export' && route[2] && method === 'GET') {
    const what = route[2];
    const format = url.searchParams.get('format') || 'csv';
    const asked = url.searchParams.get('period');
    const period = Object.keys(fin.PERIOD_LABELS).includes(asked) ? asked : '30d';
    const stamp = new Date().toISOString().slice(0, 10);

    // The BOM makes Excel open UTF-8 CSVs with accents intact.
    const sendFile = (body, filename, type = 'text/csv; charset=utf-8') => {
      const payload = type.startsWith('text/csv') ? `﻿${body}` : body;
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store'
      });
      return res.end(payload);
    };
    const sendHtml = (body) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(body);
    };

    if (what === 'inventory') return sendFile(fin.inventoryCsv(db), `tessora-inventory-${stamp}.csv`);
    if (what === 'orders') return sendFile(fin.ordersCsv(db), `tessora-orders-${stamp}.csv`);

    if (what === 'balance-sheet') {
      const sheet = fin.buildBalanceSheet(db);
      if (format === 'json') return sendJSON(res, 200, { sheet });
      if (format === 'html') return sendHtml(fin.balanceSheetHtml(sheet, settings));
      return sendFile(fin.balanceSheetCsv(sheet, settings.currency), `tessora-balance-sheet-${stamp}.csv`);
    }
    if (what === 'financials') {
      const report = fin.buildFinancials(db, period);
      if (format === 'json') return sendJSON(res, 200, { financials: report });
      if (format === 'html') return sendHtml(fin.financialsHtml(report, settings));
      return sendFile(fin.financialsCsv(report, settings.currency), `tessora-financials-${period}-${stamp}.csv`);
    }
    if (what === 'backup') {
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
      return sendFile(JSON.stringify(backup, null, 2), `tessora-backup-${stamp}.json`, 'application/json');
    }
    return sendJSON(res, 404, { error: 'Unknown export' });
  }

  if (route[0] === 'admin' && route[1] === 'products') {
    const id = route[2];

    if (method === 'POST' && !id) {
      const body = await readBody(req);
      const product = normalizeProduct(body);
      for (const img of (Array.isArray(body.newImages) ? body.newImages.slice(0, 5) : [])) {
        product.images.push(saveDataUrl(img));
      }
      db.products.unshift(product);
      const added = log.record(db, {
        type: 'product.created', target: product.name, targetId: product.id,
        summary: `Added at ${product.price} with ${product.stock} in stock`
      });
      saveNow();
      notifyOwner({
        when: settings.notifyAdminChanges,
        subject: `Product added, ${product.name}`,
        body: mailer.activityHtml(added, settings)
      });
      return sendJSON(res, 201, { product: publicProduct(product) });
    }

    const product = db.products.find((p) => p.id === id);
    if (id && !product) return sendJSON(res, 404, { error: 'Product not found' });

    if (method === 'PUT' && product) {
      const body = await readBody(req);
      const before = { ...product };
      const updated = normalizeProduct(body, product);
      if (Array.isArray(body.images)) {
        const kept = body.images.filter((u) => product.images.includes(u));
        product.images.filter((u) => !kept.includes(u)).forEach(deleteUpload);
        updated.images = kept;
      }
      for (const img of (Array.isArray(body.newImages) ? body.newImages.slice(0, 5) : [])) {
        updated.images.push(saveDataUrl(img));
      }
      Object.assign(product, updated);
      const changes = log.diff(before, product, PRODUCT_FIELDS);
      const edited = log.record(db, {
        type: 'product.updated', target: product.name, targetId: product.id, changes
      });
      saveNow();
      if (changes.length) {
        notifyOwner({
          when: settings.notifyAdminChanges,
          subject: `Product edited, ${product.name}`,
          body: mailer.activityHtml(edited, settings)
        });
      }
      return sendJSON(res, 200, { product: publicProduct(product) });
    }

    if (method === 'PATCH' && product) { // quick stock / status tweaks
      const body = await readBody(req);
      const before = { ...product };
      if (body.stockDelta !== undefined) {
        product.stock = Math.max(0, product.stock + Math.round(num(body.stockDelta)));
      }
      if (body.stock !== undefined) product.stock = Math.max(0, Math.round(num(body.stock)));
      if (body.active !== undefined) product.active = Boolean(body.active);
      if (body.featured !== undefined) product.featured = Boolean(body.featured);
      if (body.discount !== undefined) product.discount = clamp(Math.round(num(body.discount)), 0, 95);
      if (body.costPrice !== undefined) product.costPrice = Math.max(0, Math.round(num(body.costPrice)));
      if (body.price !== undefined) {
        const price = Math.round(num(body.price));
        if (price > 0) product.price = price;
      }
      product.updatedAt = new Date().toISOString();
      const changes = log.diff(before, product, PRODUCT_FIELDS);
      if (changes.length) {
        // Stock moves are the everyday case, so they get their own event type
        // rather than being buried among generic edits.
        const onlyStock = changes.every((c) => c.field === 'stock');
        log.record(db, {
          type: onlyStock
            ? 'product.stock'
            : (changes.some((c) => c.field === 'price') ? 'product.price' : 'product.updated'),
          target: product.name, targetId: product.id, changes
        });
      }
      saveNow();
      return sendJSON(res, 200, { product: publicProduct(product) });
    }

    if (method === 'DELETE' && product) {
      product.images.forEach(deleteUpload);
      db.products = db.products.filter((p) => p.id !== id);
      log.record(db, {
        type: 'product.deleted', target: product.name, targetId: product.id,
        summary: `Deleted (was ${product.price}, ${product.stock} in stock)`
      });
      saveNow();
      return sendJSON(res, 200, { ok: true });
    }
  }

  if (route[0] === 'admin' && route[1] === 'orders' && route[2] && method === 'PATCH') {
    const order = db.orders.find((o) => o.id === route[2]);
    if (!order) return sendJSON(res, 404, { error: 'Order not found' });
    const body = await readBody(req);
    const status = str(body.status, 20);
    if (!['pending', 'confirmed', 'delivered', 'cancelled'].includes(status)) {
      return sendJSON(res, 400, { error: 'Unknown status' });
    }

    const previous = order.status;

    // give stock back when an order is cancelled (only once)
    if (status === 'cancelled' && order.status !== 'cancelled') {
      for (const item of order.items) {
        const product = db.products.find((p) => p.id === item.productId);
        if (product) product.stock += item.qty;
      }
    }
    // take stock again if a cancelled order is reopened
    if (order.status === 'cancelled' && status !== 'cancelled') {
      for (const item of order.items) {
        const product = db.products.find((p) => p.id === item.productId);
        if (product) product.stock = Math.max(0, product.stock - item.qty);
      }
    }
    order.status = status;
    order.updatedAt = new Date().toISOString();
    log.record(db, {
      type: { confirmed: 'order.confirmed', cancelled: 'order.cancelled', delivered: 'order.delivered' }[status]
        || 'order.status',
      target: order.code, targetId: order.id,
      summary: `${previous} → ${status} · ${order.customer?.name}`,
      changes: [{ field: 'status', label: 'Status', from: previous, to: status }]
    });
    saveNow();
    notifyOwner({
      when: settings.notifyStatusChange,
      subject: `Order ${order.code} ${status}`,
      body: mailer.orderHtml(order, settings, `ORDER ${status.toUpperCase()}`)
    });
    return sendJSON(res, 200, { order });
  }

  if (route[0] === 'admin' && route[1] === 'settings' && method === 'PUT') {
    const body = await readBody(req);
    const s = db.settings;
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
    if (body.lowStockThreshold !== undefined) s.lowStockThreshold = clamp(Math.round(num(body.lowStockThreshold, 5)), 1, 100);

    // ---- delivery-by-distance + maps ----
    if (body.deliveryPerKm !== undefined) s.deliveryPerKm = Math.max(0, Math.round(num(body.deliveryPerKm, 15)));
    if (body.deliveryBaseFee !== undefined) s.deliveryBaseFee = Math.max(0, Math.round(num(body.deliveryBaseFee, 0)));
    if (body.storeLat !== undefined) s.storeLat = num(body.storeLat, s.storeLat);
    if (body.storeLng !== undefined) s.storeLng = num(body.storeLng, s.storeLng);
    if (body.mapsApiKey !== undefined) s.mapsApiKey = str(body.mapsApiKey, 120);

    // ---- M-Pesa ----
    if (body.mpesaEnabled !== undefined) s.mpesaEnabled = Boolean(body.mpesaEnabled);
    if (body.mpesaEnv !== undefined) s.mpesaEnv = ['sandbox', 'production'].includes(body.mpesaEnv) ? body.mpesaEnv : s.mpesaEnv;
    if (body.mpesaType !== undefined) s.mpesaType = ['paybill', 'till'].includes(body.mpesaType) ? body.mpesaType : s.mpesaType;
    if (body.mpesaShortcode !== undefined) s.mpesaShortcode = str(body.mpesaShortcode, 20).replace(/\D/g, '');
    if (body.mpesaTill !== undefined) s.mpesaTill = str(body.mpesaTill, 20).replace(/\D/g, '');
    if (body.mpesaConsumerKey !== undefined) s.mpesaConsumerKey = str(body.mpesaConsumerKey, 120);
    if (body.mpesaCallbackUrl !== undefined) s.mpesaCallbackUrl = str(body.mpesaCallbackUrl, 200);
    // Secrets: only overwrite when a non-empty value is supplied, so re-saving the
    // form (which never receives them back) doesn't wipe them.
    if (body.mpesaConsumerSecret) s.mpesaConsumerSecret = str(body.mpesaConsumerSecret, 120);
    if (body.mpesaPasskey) s.mpesaPasskey = str(body.mpesaPasskey, 120);

    // ---- reports and alerts ----
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
      mpesaEnabled: 'M-Pesa enabled', mpesaEnv: 'M-Pesa environment', mpesaType: 'M-Pesa type',
      mpesaShortcode: 'M-Pesa shortcode', mpesaTill: 'M-Pesa till',
      reportEmail: 'Report email', notifyNewOrder: 'Alert on new order',
      notifyPayment: 'Alert on payment', notifyStatusChange: 'Alert on status change',
      notifyAdminChanges: 'Alert on every edit'
    });
    if (changes.length) log.record(db, { type: 'settings.updated', target: 'Settings', changes });

    saveNow();
    return sendJSON(res, 200, { settings: adminSettings(s) });
  }

  if (route[0] === 'admin' && route[1] === 'password' && method === 'PUT') {
    const body = await readBody(req);
    const current = str(body.currentPassword, 200);
    const next = str(body.newPassword, 200);
    if (!verifyPassword(current, db.settings.adminPassword)) {
      log.record(db, {
        type: 'security.denied',
        summary: 'Password change attempted with the wrong current password'
      });
      saveNow();
      return sendJSON(res, 401, { error: 'Your current password is not right.' });
    }
    const problem = passwordProblem(next);
    if (problem) return sendJSON(res, 400, { error: problem });

    db.settings.adminPassword = hashPassword(next);
    db.settings.passwordIsDefault = false;
    const entry = log.record(db, {
      type: 'security.password', target: 'Admin password',
      summary: 'The admin password was changed'
    });
    saveNow();
    // Always worth telling the owner, whatever the alert settings say.
    notifyOwner({
      when: true,
      subject: 'Your Tessora admin password was changed',
      body: mailer.activityHtml(entry, settings)
    });
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: 'Unknown endpoint' });
}

/* --------------------------------------------------------------- server */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (url.pathname.startsWith('/api/')) {
    try {
      await api(req, res, url);
    } catch (err) {
      if (!res.headersSent) sendJSON(res, 400, { error: err.message || 'Request failed' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  try { serveStatic(req, res, pathname); }
  catch { notFound(res); }
});

server.listen(PORT, () => {
  const s = db.settings;
  console.log(`\n  ${s.storeName} is running`);
  console.log(`  Storefront : http://localhost:${PORT}`);
  console.log(`  Admin      : http://localhost:${PORT}/admin`);
  console.log(isFreshInstall() ? '  Admin password: 1234\n' : '');
});

process.on('SIGINT', () => { saveNow(); process.exit(0); });
