// Tell the search engines that take submissions directly.
//
// IndexNow is a small open protocol: you host a key file on the site, then post
// a list of addresses, and the engines that speak it (Bing, Yandex, Seznam,
// Naver, and so Ecosia and DuckDuckGo downstream of Bing) fetch them. There is
// no account and no sign-in, which is the whole point of it.
//
// Google does not take part. Google is reached through Search Console, which
// needs the shop owner's own sign-in, and is written up in GO-LIVE.md.
//
// Run it after adding or changing products:
//   node scripts/submit-indexnow.mjs
//
// It reads the live sitemap, so it always submits what the shop actually has.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = process.env.SHOP_HOST || 'tessorabeauty.co.ke';
const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** The key is whichever bare hex .txt file sits at the root of the site. */
function findKey() {
  const file = readdirSync(PUBLIC_DIR).find((f) => /^[0-9a-f]{8,128}\.txt$/.test(f));
  if (!file) throw new Error('No IndexNow key file in public/. Create one before running this.');
  const key = readFileSync(join(PUBLIC_DIR, file), 'utf8').trim();
  if (key !== file.replace(/\.txt$/, '')) {
    throw new Error(`${file} must contain exactly its own name without the extension.`);
  }
  return key;
}

async function urlsFromSitemap() {
  const res = await fetch(`https://${HOST}/sitemap.xml`);
  if (!res.ok) throw new Error(`sitemap.xml returned ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

const key = findKey();
const urlList = await urlsFromSitemap();
console.log(`key file  https://${HOST}/${key}.txt`);
console.log(`submitting ${urlList.length} addresses`);

// Confirm the key is actually reachable first: a submission is rejected
// outright if the engine cannot fetch it, and the error it gives is unhelpful.
const probe = await fetch(`https://${HOST}/${key}.txt`);
const probed = (await probe.text()).trim();
if (!probe.ok || probed !== key) {
  console.error(`The key file is not live yet (status ${probe.status}). Deploy, then run this again.`);
  process.exit(1);
}
console.log('key file is live and correct');

// IndexNow takes up to 10,000 in one post; the shop is nowhere near that.
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${key}.txt`, urlList })
});

const body = await res.text();
console.log(`\nIndexNow replied ${res.status} ${res.statusText}`);
if (body) console.log(body.slice(0, 400));

// 200 accepted, 202 accepted but the key is still being checked.
if (res.status === 200 || res.status === 202) {
  console.log(`\n${urlList.length} addresses submitted.`);
} else {
  console.error('\nNot accepted. Nothing is broken on the site; try again later.');
  process.exit(1);
}
