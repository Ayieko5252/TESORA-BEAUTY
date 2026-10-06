// Tessora Beauty, the addresses search engines can reach.
//
//   /p/<slug>        one product, rendered on the server
//   /shop/<slug>     one category
//   /sitemap.xml     built from the live catalogue
//
// The shop itself stays a single page in the browser. These are the same
// products served as real documents, so a search for "matte lip gloss Nairobi"
// has something to find. They read the same blob store the API writes to, so a
// product added in the admin panel has a page the moment it is saved.

import { getStore } from '@netlify/blobs';
import {
  productPageHtml, categoryPageHtml, sitemapXml,
  productSlug, slugify
} from '../../lib/seo.js';

const data = () => getStore({ name: 'tessora-shop', consistency: 'strong' });

const html = (status, body, extra = {}) => new Response(body, {
  status,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    // A product page is cheap to rebuild and changes with stock, so it is kept
    // briefly and revalidated. Search engines still get a fresh page.
    'Cache-Control': 'public, max-age=0, must-revalidate',
    ...extra
  }
});

const notFound = (settings) => html(404, `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found | ${settings.storeName || 'Tessora Beauty'}</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="/css/styles.css">
</head>
<body class="seo-page"><main class="seo-wrap seo-wrap--mid">
<h1 class="seo-h1">We could not find that</h1>
<p class="seo-lead">It may have sold out and been taken down. Everything we have is in the shop.</p>
<a class="btn btn--gold" href="/">Back to the shop</a>
</main></body></html>`);

export default async function handler(req) {
  const url = new URL(req.url);
  // Netlify rewrites to /.netlify/functions/pages/<rest>; the redirect also
  // passes the original path, so both shapes resolve the same way.
  const path = url.pathname.replace(/^\/\.netlify\/functions\/pages/, '') || '/';
  const seg = path.split('/').filter(Boolean);

  let db;
  try {
    db = await data().get('db', { type: 'json' });
  } catch {
    db = null;
  }
  const settings = (db && db.settings) || {};
  const products = ((db && db.products) || []).filter((p) => p.active !== false);

  /* ---- the sitemap ---- */
  if (path === '/sitemap.xml' || seg[0] === 'sitemap.xml') {
    return new Response(sitemapXml(products, settings), {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  }

  /* ---- one product ---- */
  if (seg[0] === 'p' && seg[1]) {
    const want = decodeURIComponent(seg[1]).toLowerCase();
    const product = products.find((p) => productSlug(p).toLowerCase() === want)
      || products.find((p) => p.id === want);
    if (!product) return notFound(settings);

    const related = products
      .filter((p) => p.id !== product.id && p.category === product.category)
      .slice(0, 4);
    return html(200, productPageHtml(product, settings, related));
  }

  /* ---- one category ---- */
  if (seg[0] === 'shop' && seg[1]) {
    const want = decodeURIComponent(seg[1]).toLowerCase();
    const match = products.filter((p) => slugify(p.category) === want);
    if (!match.length) return notFound(settings);
    return html(200, categoryPageHtml(match[0].category, match, settings));
  }

  return notFound(settings);
}
