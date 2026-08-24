// Tiny zero-dependency JSON datastore with atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// TESSORA_DATA_DIR lets tests (or a second shop) run against their own database.
export const DATA_DIR = process.env.TESSORA_DATA_DIR
  ? path.resolve(process.env.TESSORA_DATA_DIR)
  : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const CATEGORIES = [
  'Lip Products',
  'Makeup',
  'Skincare',
  'Body Care',
  'Perfumes & Mists',
  'Hair Care',
  'Beauty Accessories',
  'Gift Sets'
];

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  const candidate = hashPassword(password, salt);
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function defaults() {
  return {
    settings: {
      storeName: 'Tessora Beauty',
      tagline: 'Your Beauty. Your Aura.',
      whatsapp: '254700000000',
      instagram: 'tessorabeauty',
      tiktok: 'tessorabeauty',
      email: '',
      location: 'Nairobi, Kenya',
      currency: 'KSh',
      deliveryFee: 250,
      freeDeliveryOver: 5000,
      lowStockThreshold: 5,
      announcement: 'Free delivery within Nairobi on orders over KSh 5,000',
      adminPassword: hashPassword('1234'),
      // The shop owner chose this password deliberately, so the admin panel does not
      // nag about it. Set a longer one in Admin -> Settings before going public.
      passwordIsDefault: false
    },
    products: [],
    orders: [],
    counters: { order: 1000 }
  };
}

let state = null;
let freshInstall = false;

// True when this run created the database from scratch (so the startup banner
// can safely print the starting password).
export const isFreshInstall = () => freshInstall;

export function load() {
  if (state) return state;
  // clear temp files left behind if a previous run was killed mid-write
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.startsWith('db.json.') && f.endsWith('.tmp')) {
      fs.rmSync(path.join(DATA_DIR, f), { force: true });
    }
  }
  try {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // merge any newly added settings keys
    state.settings = { ...defaults().settings, ...state.settings };
    state.products ||= [];
    state.orders ||= [];
    state.counters ||= { order: 1000 };
  } catch {
    state = defaults();
    freshInstall = true;
    save();
  }
  return state;
}

let writeTimer = null;
export function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 25);
}

export function saveNow() {
  clearTimeout(writeTimer);
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const db = new Proxy({}, {
  get: (_t, key) => load()[key],
  set: (_t, key, value) => { load()[key] = value; save(); return true; }
});

export function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

export function nextOrderCode() {
  const s = load();
  s.counters.order += 1;
  save();
  return `TB-${s.counters.order}`;
}
