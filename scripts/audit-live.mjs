// A sweep of the live shop: what is reachable, what it gives away, and
// whether everything that should be shut is shut.
//
//   node scripts/audit-live.mjs
//
// Read-only. It places no orders, writes nothing, and changes no settings.
// Safe to run against the real shop at any time, and worth running after
// every deploy, because the leak this was written for looked like nothing
// at all in the code that caused it.

const SITE = process.env.SHOP_URL || 'https://tessorabeauty.co.ke';

let pass = 0, fail = 0, warn = 0;
const ok = (l, d = '') => { pass++; console.log(`  ok   ${l}${d ? ` — ${d}` : ''}`); };
const bad = (l, d = '') => { fail++; console.log(`  FAIL ${l}${d ? ` — ${d}` : ''}`); };
const note = (l, d = '') => { warn++; console.log(`  note ${l}${d ? ` — ${d}` : ''}`); };
const check = (l, cond, d = '') => (cond ? ok(l) : bad(l, d));
const section = (s) => console.log(`\n=== ${s} ===`);

const get = async (path, opts = {}) => {
  const res = await fetch(`${SITE}${path}`, { redirect: 'manual', ...opts });
  const text = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text };
};

/* Anything in here appearing in a public response is a real problem. */
const SECRETS = [
  'costPrice', 'adminPassword', 'tokenSecret', 'emailApiKey',
  'mpesaPasskey', 'mpesaConsumerSecret', 'mpesaConsumerKey',
  'passwordIsDefault', 'reportEmail', 'mpesaCallbackUrl'
];

console.log(`\nAuditing ${SITE}\n${'='.repeat(46)}`);

/* ------------------------------------------------- what the public sees */
section('the public API gives nothing private away');
const front = await get('/api/storefront');
check('storefront responds', front.status === 200, `status ${front.status}`);
let data = null;
try { data = JSON.parse(front.text); } catch { bad('storefront returns JSON'); }

if (data) {
  const leaked = SECRETS.filter((k) => front.text.includes(k));
  check('no private field anywhere in the payload', leaked.length === 0, leaked.join(', '));
  check('no orders', !('orders' in data));
  check('no customers', !('customers' in data));
  check('no activity log', !('activity' in data));
  check('every product still has a sale price',
    (data.products || []).every((p) => 'salePrice' in p));
  ok(`${(data.products || []).length} products, ${Object.keys(data.settings || {}).length} settings published`);
}

/* ------------------------------------------------ server-rendered pages */
section('the pages search engines read');
const sitemap = await get('/sitemap.xml');
check('sitemap responds', sitemap.status === 200, `status ${sitemap.status}`);
const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
ok(`${locs.length} addresses listed`);

// Sample a few product pages rather than all of them, and look for secrets.
const productUrls = locs.filter((u) => u.includes('/p/')).slice(0, 5);
let pageLeaks = [];
for (const u of productUrls) {
  const r = await get(u.replace(SITE, ''));
  if (r.status !== 200) { bad(`${u} responds`, `status ${r.status}`); continue; }
  const found = SECRETS.filter((k) => r.text.includes(k));
  if (found.length) pageLeaks.push(`${u}: ${found.join(',')}`);
}
check(`${productUrls.length} product pages give nothing private away`,
  pageLeaks.length === 0, pageLeaks.join(' | '));

/* --------------------------------------------- what must stay shut */
section('nothing private is reachable without signing in');
for (const ep of [
  '/api/admin/overview', '/api/admin/activity', '/api/admin/report',
  '/api/admin/export/backup', '/api/admin/export/orders', '/api/admin/export/inventory',
  '/api/admin/export/balance-sheet', '/api/admin/export/financials'
]) {
  const r = await get(ep);
  check(`${ep} refuses`, r.status === 401, `status ${r.status}`);
}

for (const [method, ep] of [['PUT', '/api/admin/settings'], ['PUT', '/api/admin/password'],
  ['PATCH', '/api/admin/orders/x'], ['POST', '/api/admin/products']]) {
  const r = await get(ep, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check(`${method} ${ep} refuses`, r.status === 401 || r.status === 404, `status ${r.status}`);
}

section('a forged session is rejected');
// The old public fallback secret, which anyone reading the source once knew.
const crypto = await import('node:crypto');
const body = Buffer.from(JSON.stringify({ sub: 'admin', exp: Date.now() + 9e6 })).toString('base64url');
const sig = crypto.createHmac('sha256', 'tessora-dev-secret').update(body).digest('base64url');
const forged = await get('/api/admin/overview', { headers: { Authorization: `Bearer ${body}.${sig}` } });
check('a token signed with the old fallback secret is refused', forged.status === 401, `status ${forged.status}`);

section('a receipt needs its own token');
const noToken = await get('/api/orders/anything/receipt');
check('a receipt without a token is not served', noToken.status === 404, `status ${noToken.status}`);

/* ------------------------------------------------- forgotten passwords */
section('password reset is live and says nothing it should not');
const forgotUnknown = await get('/api/account/forgot', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'definitely-not-a-customer@example.com' })
});
check('asking about an unknown address is accepted', forgotUnknown.status === 200, `status ${forgotUnknown.status}`);
check('and does not say whether the account exists',
  !/no account|not found|unknown|does not exist/i.test(forgotUnknown.text),
  forgotUnknown.text.slice(0, 120));

/* ------------------------------------------------------------ headers */
section('browser protections');
const home = await get('/');
const h = home.headers;
check('HSTS', /max-age=\d+/.test(h.get('strict-transport-security') || ''), h.get('strict-transport-security') || 'missing');
check('no MIME sniffing', (h.get('x-content-type-options') || '') === 'nosniff');
check('a content security policy is set', Boolean(h.get('content-security-policy')));
check('referrers do not carry the query string',
  /strict-origin/.test(h.get('referrer-policy') || ''), h.get('referrer-policy') || 'missing');

const adminHead = await get('/admin');
check('the admin panel asks not to be indexed',
  /noindex/.test(adminHead.headers.get('x-robots-tag') || ''),
  adminHead.headers.get('x-robots-tag') || 'missing');

section('the shop itself works');
for (const p of ['/', '/admin', '/sitemap.xml', '/robots.txt']) {
  const r = await get(p);
  check(`${p}`, r.status === 200, `status ${r.status}`);
}

/* ------------------------------------------------------------- summary */
console.log(`\n${'='.repeat(46)}`);
console.log(`${pass} passed, ${fail} failed${warn ? `, ${warn} to look at` : ''}\n`);
process.exit(fail ? 1 : 0);
