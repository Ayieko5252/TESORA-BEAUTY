// Add the DNS records Zoho Mail needs, to the Netlify-hosted zone.
//
// The shop's own two records are left alone: this only ever adds. Run it again
// safely, it skips anything already present.
//
//   node scripts/add-zoho-dns.mjs            show what would change
//   node scripts/add-zoho-dns.mjs --apply    make the change
//
// The domain-verification record is unique to the owner's Zoho account, so it
// is passed in rather than guessed:
//   node scripts/add-zoho-dns.mjs --apply --verify zb****************

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZONE = '6ac4f2a8e58fd0d539fdb8f1';
const DOMAIN = 'tessorabeauty.co.ke';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const verifyValue = (() => {
  const i = args.indexOf('--verify');
  return i >= 0 ? args[i + 1] : '';
})();

/**
 * The REST API directly, rather than through the CLI: Node on Windows will not
 * spawn a .cmd, and routing the JSON through a shell strips its quotes.
 *
 * The token is the one the Netlify CLI already holds. It is read into memory
 * and used; it is never printed, logged or written anywhere.
 */
function token() {
  if (process.env.NETLIFY_AUTH_TOKEN) return process.env.NETLIFY_AUTH_TOKEN;
  const candidates = [
    join(process.env.APPDATA || '', 'netlify', 'Config', 'config.json'),
    join(homedir(), '.netlify', 'config.json'),
    join(homedir(), '.config', 'netlify', 'config.json')
  ];
  for (const path of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      const users = cfg.users || {};
      for (const u of Object.values(users)) {
        const t = u && u.auth && u.auth.token;
        if (t) return t;
      }
    } catch { /* try the next one */ }
  }
  throw new Error('No Netlify token found. Run "netlify login", or set NETLIFY_AUTH_TOKEN.');
}

const TOKEN = token();
const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

/* Zoho's global (zoho.com) mail servers. If the account ends up on the EU or
   India datacentre these become mx.zoho.eu / mx.zoho.in and so on. */
const wanted = [
  { type: 'MX', hostname: DOMAIN, value: 'mx.zoho.com', priority: 10, ttl: 3600 },
  { type: 'MX', hostname: DOMAIN, value: 'mx2.zoho.com', priority: 20, ttl: 3600 },
  { type: 'MX', hostname: DOMAIN, value: 'mx3.zoho.com', priority: 50, ttl: 3600 },
  // Says Zoho is allowed to send as this domain, so replies are not spam.
  { type: 'TXT', hostname: DOMAIN, value: 'v=spf1 include:zoho.com ~all', ttl: 3600 },
  // p=none only watches; it never causes a message to be rejected.
  { type: 'TXT', hostname: `_dmarc.${DOMAIN}`, value: `v=DMARC1; p=none; rua=mailto:care@${DOMAIN}`, ttl: 3600 }
];

if (verifyValue) {
  wanted.unshift({ type: 'TXT', hostname: DOMAIN, value: verifyValue, ttl: 3600 });
}

const existing = await api(`/dns_zones/${ZONE}/dns_records`);
console.log(`zone ${DOMAIN}: ${existing.length} records already there\n`);

const same = (a, b) =>
  a.type === b.type
  && a.hostname.replace(/\.$/, '') === b.hostname.replace(/\.$/, '')
  && String(a.value).replace(/^"|"$/g, '') === String(b.value).replace(/^"|"$/g, '');

let added = 0;
for (const rec of wanted) {
  if (existing.some((e) => same(e, rec))) {
    console.log(`  already there  ${rec.type.padEnd(4)} ${rec.hostname}  ${rec.value}`);
    continue;
  }
  if (!apply) {
    console.log(`  would add      ${rec.type.padEnd(4)} ${rec.hostname}  ${rec.value}${rec.priority != null ? `  (priority ${rec.priority})` : ''}`);
    continue;
  }
  await api(`/dns_zones/${ZONE}/dns_records`, { method: 'POST', body: rec });
  added += 1;
  console.log(`  added          ${rec.type.padEnd(4)} ${rec.hostname}  ${rec.value}${rec.priority != null ? `  (priority ${rec.priority})` : ''}`);
}

console.log(apply ? `\n${added} record(s) added.` : '\nNothing changed. Re-run with --apply.');
