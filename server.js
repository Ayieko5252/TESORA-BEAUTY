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

function publicProduct(p) {
  return { ...p, salePrice: salePrice(p) };
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
    const { adminPassword, passwordIsDefault, ...safeSettings } = settings;
    return sendJSON(res, 200, { settings: safeSettings, categories: CATEGORIES, products });
  }

  if (route[0] === 'orders' && method === 'POST') {
    const body = await readBody(req);
    const customer = {
      name: str(body?.customer?.name, 80),
      phone: str(body?.customer?.phone, 30),
      location: str(body?.customer?.location, 160),
      notes: str(body?.customer?.notes, 500)
    };
    if (!customer.name || !customer.phone) {
      return sendJSON(res, 400, { error: 'Name and phone number are required' });
    }
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
    const freeOver = num(settings.freeDeliveryOver, 0);
    const deliveryFee = freeOver > 0 && subtotal >= freeOver ? 0 : num(settings.deliveryFee, 0);
    const order = {
      id: newId(), code: nextOrderCode(), customer, items,
      subtotal, deliveryFee, total: subtotal + deliveryFee,
      status: 'pending', createdAt: new Date().toISOString()
    };

    for (const item of items) {
      const product = products.find((p) => p.id === item.productId);
      product.stock = Math.max(0, product.stock - item.qty);
    }
    db.orders.unshift(order);
    saveNow();
    return sendJSON(res, 201, { order });
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
    const { adminPassword, ...safeSettings } = settings;
    return sendJSON(res, 200, {
      settings: safeSettings,
      categories: CATEGORIES,
      products: products.map(publicProduct),
      orders,
      stats: {
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

  if (route[0] === 'admin' && route[1] === 'products') {
    const id = route[2];

    if (method === 'POST' && !id) {
      const body = await readBody(req);
      const product = normalizeProduct(body);
      for (const img of (Array.isArray(body.newImages) ? body.newImages.slice(0, 5) : [])) {
        product.images.push(saveDataUrl(img));
      }
      db.products.unshift(product);
      saveNow();
      return sendJSON(res, 201, { product: publicProduct(product) });
    }

    const product = db.products.find((p) => p.id === id);
    if (id && !product) return sendJSON(res, 404, { error: 'Product not found' });

    if (method === 'PUT' && product) {
      const body = await readBody(req);
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
      saveNow();
      return sendJSON(res, 200, { product: publicProduct(product) });
    }

    if (method === 'PATCH' && product) { // quick stock / status tweaks
      const body = await readBody(req);
      if (body.stockDelta !== undefined) {
        product.stock = Math.max(0, product.stock + Math.round(num(body.stockDelta)));
      }
      if (body.stock !== undefined) product.stock = Math.max(0, Math.round(num(body.stock)));
      if (body.active !== undefined) product.active = Boolean(body.active);
      if (body.featured !== undefined) product.featured = Boolean(body.featured);
      if (body.discount !== undefined) product.discount = clamp(Math.round(num(body.discount)), 0, 95);
      if (body.price !== undefined) {
        const price = Math.round(num(body.price));
        if (price > 0) product.price = price;
      }
      product.updatedAt = new Date().toISOString();
      saveNow();
      return sendJSON(res, 200, { product: publicProduct(product) });
    }

    if (method === 'DELETE' && product) {
      product.images.forEach(deleteUpload);
      db.products = db.products.filter((p) => p.id !== id);
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
    saveNow();
    return sendJSON(res, 200, { order });
  }

  if (route[0] === 'admin' && route[1] === 'settings' && method === 'PUT') {
    const body = await readBody(req);
    const s = db.settings;
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
    saveNow();
    const { adminPassword, ...safe } = s;
    return sendJSON(res, 200, { settings: safe });
  }

  if (route[0] === 'admin' && route[1] === 'password' && method === 'PUT') {
    const body = await readBody(req);
    const current = str(body.currentPassword, 200);
    const next = str(body.newPassword, 200);
    if (!verifyPassword(current, db.settings.adminPassword)) {
      return sendJSON(res, 401, { error: 'Current password is incorrect' });
    }
    if (next.length < 4) return sendJSON(res, 400, { error: 'New password must be at least 4 characters' });
    db.settings.adminPassword = hashPassword(next);
    db.settings.passwordIsDefault = false;
    saveNow();
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
