// Take a backup of the live shop, and put it back when something goes wrong.
//
//   node scripts/backup.mjs                    save a backup
//   node scripts/backup.mjs --list             show what has been saved
//   node scripts/backup.mjs --verify <file>    check a file is restorable
//   node scripts/backup.mjs --restore <file>   put it back
//
// This talks to Netlify Blobs directly rather than through the shop's API, so
// it needs no admin password and keeps working if the site itself is broken,
// which is when a backup matters most.
//
// Backups hold customer names, phone numbers and delivery addresses. They are
// written to backups/, which is in .gitignore, and must stay out of Git.

import { getStore } from '@netlify/blobs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SITE_ID = '5e408354-2c07-4f60-bd84-f11772cf14b6';
const DIR = new URL('../backups/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

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

const store = () => getStore({
  name: 'tessora-shop', consistency: 'strong',
  siteID: SITE_ID, token: token()
});

/** What a usable backup has to contain. A file missing any of this is not one. */
function problemsWith(db) {
  const bad = [];
  if (!db || typeof db !== 'object') return ['not a JSON object'];
  if (!Array.isArray(db.products)) bad.push('products is not a list');
  if (!Array.isArray(db.orders)) bad.push('orders is not a list');
  if (!db.settings || typeof db.settings !== 'object') bad.push('settings missing');
  if (!db.counters || typeof db.counters.order !== 'number') bad.push('order counter missing');
  // A backup with no products is almost certainly a mistake, not an empty shop.
  if (Array.isArray(db.products) && db.products.length === 0) bad.push('no products in it');
  return bad;
}

const summarise = (db) => [
  `${(db.products || []).length} products`,
  `${(db.orders || []).length} orders`,
  `${(db.customers || []).length} customers`,
  `${(db.activity || []).length} activity entries`,
  `order counter at ${db.counters?.order}`
].join(', ');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] || true) : null;
};

/* ------------------------------------------------------------------ list */
if (args.includes('--list')) {
  let files = [];
  try { files = readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
  if (!files.length) { console.log('No backups yet. Run: node scripts/backup.mjs'); process.exit(0); }
  console.log(`\n${files.length} backup(s) in backups/\n`);
  for (const f of files.sort().reverse()) {
    const path = join(DIR, f);
    const kb = Math.round(statSync(path).size / 1024);
    let note = '';
    try { note = summarise(JSON.parse(readFileSync(path, 'utf8'))); } catch { note = 'UNREADABLE'; }
    console.log(`  ${f}  ${String(kb).padStart(5)} KB  ${note}`);
  }
  console.log('');
  process.exit(0);
}

/* ---------------------------------------------------------------- verify */
const verifyFile = flag('--verify');
if (typeof verifyFile === 'string') {
  const path = verifyFile.includes('/') || verifyFile.includes('\\') ? verifyFile : join(DIR, verifyFile);
  let db;
  try { db = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { console.error(`  cannot read it: ${e.message}`); process.exit(1); }
  const bad = problemsWith(db);
  if (bad.length) {
    console.error(`\n  NOT restorable:\n${bad.map((b) => `    - ${b}`).join('\n')}\n`);
    process.exit(1);
  }
  console.log(`\n  restorable: ${summarise(db)}\n`);
  process.exit(0);
}

/* --------------------------------------------------------------- restore */
const restoreFile = flag('--restore');
if (typeof restoreFile === 'string') {
  const path = restoreFile.includes('/') || restoreFile.includes('\\') ? restoreFile : join(DIR, restoreFile);
  const db = JSON.parse(readFileSync(path, 'utf8'));
  const bad = problemsWith(db);
  if (bad.length) {
    console.error(`\n  Refusing to restore:\n${bad.map((b) => `    - ${b}`).join('\n')}\n`);
    process.exit(1);
  }

  const s = store();
  const live = await s.get('db', { type: 'json' });

  // Snapshot what is there now, first. Restoring over a live shop is the one
  // operation that can lose real orders, so it is never the only copy.
  if (live) {
    mkdirSync(DIR, { recursive: true });
    const safety = join(DIR, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(safety, JSON.stringify(live, null, 2));
    console.log(`  current shop saved first: ${safety}`);
    console.log(`    it held: ${summarise(live)}`);
  }

  // Secrets are stripped from a backup on the way out, so they must be carried
  // over from the live shop rather than wiped by the restore.
  const keep = ['adminPassword', 'tokenSecret', 'mpesaConsumerSecret', 'mpesaPasskey', 'emailApiKey'];
  const settings = { ...db.settings };
  for (const k of keep) if (live?.settings?.[k] !== undefined) settings[k] = live.settings[k];

  await s.setJSON('db', { ...db, settings });
  console.log(`\n  restored: ${summarise(db)}`);
  console.log('  passwords and payment secrets were kept from the live shop, not the file.\n');
  process.exit(0);
}

/* ---------------------------------------------------------------- backup */
const s = store();
const db = await s.get('db', { type: 'json' });
if (!db) { console.error('Nothing in the store to back up.'); process.exit(1); }

const bad = problemsWith(db);
if (bad.length) {
  console.error(`\n  The live shop looks wrong, refusing to save a bad backup over a good one:`);
  console.error(bad.map((b) => `    - ${b}`).join('\n'));
  process.exit(1);
}

mkdirSync(DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(DIR, `tessora-${stamp}.json`);
writeFileSync(out, JSON.stringify(db, null, 2));

console.log(`\n  saved ${out}`);
console.log(`  ${summarise(db)}`);

// A backup nobody has read back is a guess. Read it from disk and check it.
const readBack = JSON.parse(readFileSync(out, 'utf8'));
const stillBad = problemsWith(readBack);
console.log(stillBad.length
  ? `  WARNING, the file on disk is not restorable: ${stillBad.join(', ')}`
  : '  checked: the file reads back and is restorable');
console.log('');
