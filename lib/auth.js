// Tessora Beauty, password hashing and signed session tokens.
// Shared by the local Node server and the Netlify function so an account
// created in one place still works in the other.
import crypto from 'node:crypto';

/* ------------------------------------------------------------- passwords */

/**
 * Hash a password with PBKDF2-SHA256. Returns "salt:hash", the same shape the
 * shop has always stored, so existing admin passwords keep working.
 */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

/** Constant-time check of a password against a stored "salt:hash". */
export function verifyPassword(password, stored) {
  if (!stored || !String(stored).includes(':')) return false;
  const [salt] = String(stored).split(':');
  const candidate = hashPassword(password, salt);
  const a = Buffer.from(candidate);
  const b = Buffer.from(String(stored));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Why a password is not good enough, or '' when it is fine.
 * Deliberately gentle: length is what actually matters.
 */
export function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Use at least 8 characters.';
  if (/^\d+$/.test(p)) return 'Use more than just numbers, add a letter or two.';
  if (['12345678', 'password', 'qwertyui', 'tessora1'].includes(p.toLowerCase())) {
    return 'That password is too easy to guess.';
  }
  return '';
}

/* ---------------------------------------------------------------- tokens */

const sign = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('base64url');

const equal = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Issue a signed token. `subject` is 'admin' for the shop owner, or the
 * customer's id for a shopper. Tokens carry their own expiry and are verified
 * with an HMAC, so nothing has to be remembered between requests, which is
 * what makes them work on Netlify, where every request is a fresh process.
 */
export function issueToken(secret, subject, ttlMs = 8 * 60 * 60 * 1000) {
  const payload = `${subject}.${Date.now() + ttlMs}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** Read a token back. Returns the subject, or '' if it is invalid or expired. */
export function readToken(secret, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return '';
  const [subject, expires, mac] = parts;
  if (!equal(mac, sign(secret, `${subject}.${expires}`))) return '';
  if (!(Number(expires) > Date.now())) return '';
  return subject;
}

/** Pull the bearer token out of an Authorization header value. */
export function bearer(header) {
  const h = String(header || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/* ------------------------------------------------------------- customers */

export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase().slice(0, 160);

export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(v));

/** The customer record as the browser is allowed to see it, never the hash. */
export function publicCustomer(c) {
  if (!c) return null;
  const { password, ...rest } = c;
  return rest;
}
