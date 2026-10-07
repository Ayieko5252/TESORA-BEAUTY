// Add the DNS records Resend needs in order to send as this domain.
//
//   node scripts/add-resend-dns.mjs            show what would change
//   node scripts/add-resend-dns.mjs --apply    make the change
//
// Two things this deliberately does NOT do.
//
// It does not add Resend's inbound MX record. Resend offers to receive mail
// for the domain as well as send it, and its MX record sits at the root, the
// same place Zoho's does. Adding it would quietly take delivery away from the
// mailboxes and nothing would say so. Zoho receives; Resend only sends.
//
// It does not touch SPF. Resend authorises sending through the two CNAMEs
// below rather than through a root SPF record, so the single SPF record the
// domain is allowed to have stays Zoho's. Two SPF records is the commonest
// reason business mail is marked as spam.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZONE = '6ac4f2a8e58fd0d539fdb8f1';
const DOMAIN = 'tessorabeauty.co.ke';
const apply = process.argv.includes('--apply');

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
      for (const u of Object.values(cfg.users || {})) {
        if (u?.auth?.token) return u.auth.token;
      }
    } catch { /* next */ }
  }
  throw new Error('No Netlify token found.');
}

const TOKEN = token();
const api = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`https://api.netlify.com/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

const DKIM = 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDQPeaVxJpC6ilj74QJjvcw984VcV6PFewf39S7pmOFOVDc3Utchl6EtvpZqSEjdA3pm0O8bbe5aqmOl0Vx+81hbzhExhQNydNQnfbSQrywQ7DfxmwdyCnrOiCDxLhtxjuGdidELoDWCbMc61Y9R2/Hc5j6Qpxl+cR0ZC1IoliUtwIDAQAB';

const wanted = [
  // proves a message really came from this domain and was not altered
  { type: 'TXT', hostname: `resend._domainkey.${DOMAIN}`, value: DKIM, ttl: 3600 },
  // the paths Resend sends through, which is what authorises it in place of SPF
  { type: 'CNAME', hostname: `rsend.${DOMAIN}`, value: 'rsend-euw1.forge.rmta.net', ttl: 3600 },
  { type: 'CNAME', hostname: `send.${DOMAIN}`, value: 'send.forge.rmta.net', ttl: 3600 }
];

const existing = await api(`/dns_zones/${ZONE}/dns_records`);

/* Guard: if a root MX ever appears that is not Zoho's, say so loudly. It would
   mean incoming mail had been pointed somewhere other than the mailboxes. */
const rootMx = existing.filter((r) => r.type === 'MX' && r.hostname.replace(/\.$/, '') === DOMAIN);
const strayMx = rootMx.filter((r) => !/zoho\.com$/i.test(String(r.value).replace(/\.$/, '')));
if (strayMx.length) {
  console.log('\n  WARNING: a root MX record points somewhere other than Zoho:');
  strayMx.forEach((r) => console.log(`    ${r.value}`));
  console.log('  Incoming mail may not be reaching the mailboxes.\n');
}

console.log(`zone ${DOMAIN}: ${existing.length} records already there\n`);

const same = (a, b) =>
  a.type === b.type
  && a.hostname.replace(/\.$/, '') === b.hostname.replace(/\.$/, '')
  && String(a.value).replace(/^"|"$/g, '').replace(/\.$/, '') === String(b.value).replace(/^"|"$/g, '').replace(/\.$/, '');

let added = 0;
for (const rec of wanted) {
  if (existing.some((e) => same(e, rec))) {
    console.log(`  already there  ${rec.type.padEnd(5)} ${rec.hostname}`);
    continue;
  }
  if (!apply) {
    console.log(`  would add      ${rec.type.padEnd(5)} ${rec.hostname}  ->  ${String(rec.value).slice(0, 48)}${String(rec.value).length > 48 ? '…' : ''}`);
    continue;
  }
  await api(`/dns_zones/${ZONE}/dns_records`, { method: 'POST', body: rec });
  added += 1;
  console.log(`  added          ${rec.type.padEnd(5)} ${rec.hostname}`);
}

/* The SPF record must stay single, and must stay Zoho's. */
const spf = existing.filter((r) => r.type === 'TXT' && /^"?v=spf1/.test(String(r.value)));
console.log(`\n  SPF records: ${spf.length} ${spf.length === 1 ? '(correct)' : '(PROBLEM, there must be exactly one)'}`);
console.log(`  Zoho MX left alone: ${rootMx.length} record(s)`);
console.log(apply ? `\n${added} record(s) added.` : '\nNothing changed. Re-run with --apply.');
