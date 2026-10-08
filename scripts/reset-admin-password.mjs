// Break glass: set the admin password from this computer.
//
//   node scripts/reset-admin-password.mjs "the new password"
//
// For the case the emailed reset cannot cover: locked out of the admin panel
// with no working email, or before Resend is configured. It writes straight
// to the shop's data store using the Netlify credentials already on this
// machine, so it needs no password to begin with and no deploy.
//
// Whoever can run this already controls the shop's hosting account, so it
// grants nothing they did not have. Keep it that way: it is only as safe as
// the laptop it runs on.
//
// Type the password as the argument yourself. It is never generated here and
// never printed back, so it does not end up in a terminal log or a screenshot.

import { getStore } from '@netlify/blobs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
// The shop's own hashing, imported rather than copied. A second version of
// this written from memory produced the wrong format and would have locked
// the owner out of her own shop while reporting success.
import { hashPassword } from '../lib/auth.js';

const SITE_ID = '5e408354-2c07-4f60-bd84-f11772cf14b6';

const password = process.argv[2];
if (!password) {
  console.error('\n  Give the new password as an argument:');
  console.error('    node scripts/reset-admin-password.mjs "your new password"\n');
  process.exit(1);
}
if (String(password).length < 8) {
  console.error('\n  Too short. Use at least 8 characters.\n');
  process.exit(1);
}

function token() {
  if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN;
  for (const path of [
    join(process.env.APPDATA || '', 'netlify', 'Config', 'config.json'),
    join(homedir(), '.netlify', 'config.json'),
    join(homedir(), '.config', 'netlify', 'config.json')
  ]) {
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      for (const u of Object.values(cfg.users || {})) if (u?.auth?.token) return u.auth.token;
    } catch { /* next */ }
  }
  throw new Error('No Netlify token. Run "netlify login", or set NETLIFY_AUTH_TOKEN.');
}

const store = getStore({
  name: 'tessora-shop', consistency: 'strong', siteID: SITE_ID, token: token()
});

const db = await store.get('db', { type: 'json' });
if (!db) { console.error('Could not read the shop data.'); process.exit(1); }

db.settings = db.settings || {};
db.settings.adminPassword = hashPassword(password);
db.settings.passwordIsDefault = false;
// Changing the password changes the session stamp, so every signed-in admin
// session dies with it. That is the point: if someone else was in, they are out.
db.activity = db.activity || [];
db.activity.unshift({
  id: crypto.randomBytes(9).toString('base64url'),
  type: 'settings.updated',
  actor: 'owner',
  label: 'Settings updated',
  target: 'Admin password',
  summary: 'Admin password reset from the shop computer using the recovery script',
  at: new Date().toISOString()
});

await store.setJSON('db', db);

console.log('\n  Admin password changed.');
console.log('  Every signed-in admin session has been ended.');
console.log('  Sign in at https://tessorabeauty.co.ke/admin with the new password.\n');
