// Tessora Beauty, the pages search engines can actually read.
//
// The shop itself is one page that builds its catalogue in the browser. That is
// right for a shopper and useless for Google: a product that has no address of
// its own can never be a search result. So every product also gets a real page
// at /p/<slug>, rendered on the server, with the name, the picture, the price,
// the description and Product structured data. The page is a genuine page, not
// a doorway: it shows the product and takes you straight into the shop with it
// open.
//
// Zero dependencies, same as the rest of lib/.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const salePrice = (p) =>
  Math.round(num(p.price) * (1 - clamp(num(p.discount), 0, 95) / 100));

/** A url-safe name. Falls back to the id so a page always has an address. */
export const slugify = (s) => String(s || '')
  .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);

export const productSlug = (p) => p.slug || slugify(p.name) || p.id;

export const siteUrl = (settings) =>
  String(settings?.siteUrl || 'https://tessorabeauty.co.ke').replace(/\/+$/, '');

export const productUrl = (p, settings) => `${siteUrl(settings)}/p/${productSlug(p)}`;
export const categoryUrl = (category, settings) => `${siteUrl(settings)}/shop/${slugify(category)}`;

/** Absolute, because a share card or a rich result cannot follow a relative one. */
const absolute = (src, settings) => {
  const s = String(src || '');
  if (!s) return `${siteUrl(settings)}/assets/share-card.jpg`;
  if (/^https?:\/\//i.test(s)) return s;
  return `${siteUrl(settings)}${s.startsWith('/') ? '' : '/'}${s}`;
};

const money = (n, currency = 'KSh') =>
  `${currency} ${Math.round(num(n)).toLocaleString('en-KE')}`;

/** One short paragraph for the search result snippet. */
const metaDescription = (p, settings) => {
  const bits = [
    p.description && String(p.description).replace(/\s+/g, ' ').trim(),
    `${p.name} by ${p.brand || settings.storeName || 'Tessora Beauty'}`,
    `${money(salePrice(p), settings.currency)}.`,
    'Authentic beauty products delivered across Kenya from Nairobi.'
  ].filter(Boolean);
  return bits.join(' ').slice(0, 300);
};

/* ----------------------------------------------------------- the page shell */

const head = (settings, {
  title, description, canonical, image, jsonLd, robots
}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${robots ? `<meta name="robots" content="${esc(robots)}">` : ''}
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta name="theme-color" content="#12100f">
<meta property="og:type" content="product">
<meta property="og:site_name" content="${esc(settings.storeName || 'Tessora Beauty')}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:locale" content="en_KE">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600&family=Jost:wght@300;400;500;600&display=swap">
<link rel="stylesheet" href="/css/styles.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>`;

const siteHeader = (settings) => `
<header class="seo-head">
  <a class="seo-brand" href="/">
    <img src="/assets/logo.svg" alt="" width="34" height="34">
    <span>${esc(settings.storeName || 'Tessora Beauty')}</span>
  </a>
  <a class="btn btn--dark btn--sm" href="/#shop">Shop all products</a>
</header>`;

const siteFooter = (settings) => `
<footer class="seo-foot">
  <div class="seo-foot__name">${esc(String(settings.storeName || 'Tessora Beauty').toUpperCase())}</div>
  <p>${esc(settings.tagline || 'Your Beauty. Your Aura.')}</p>
  <p>
    ${settings.location ? esc(settings.location) + ' · ' : ''}
    Delivery across Kenya · Paid by M-Pesa
  </p>
  <p>
    <a href="/">The shop</a> ·
    <a href="/#categories">Categories</a> ·
    <a href="/#about">About</a>
    ${settings.email ? ` · <a href="mailto:${esc(settings.email)}">${esc(settings.email)}</a>` : ''}
  </p>
</footer>`;

/* ------------------------------------------------------------ the product */

export function productJsonLd(p, settings) {
  const price = salePrice(p);
  const url = productUrl(p, settings);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    description: String(p.description || metaDescription(p, settings)).slice(0, 500),
    image: (p.images || []).length
      ? p.images.slice(0, 5).map((i) => absolute(i, settings))
      : [absolute('', settings)],
    sku: p.sku || p.id,
    ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}),
    ...(p.category ? { category: p.category } : {}),
    url,
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'KES',
      price: String(price),
      availability: num(p.stock) > 0
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller: { '@type': 'Organization', name: settings.storeName || 'Tessora Beauty' }
    }
  };
}

const breadcrumbs = (p, settings) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Shop', item: `${siteUrl(settings)}/` },
    ...(p.category
      ? [{ '@type': 'ListItem', position: 2, name: p.category, item: categoryUrl(p.category, settings) }]
      : []),
    { '@type': 'ListItem', position: p.category ? 3 : 2, name: p.name, item: productUrl(p, settings) }
  ]
});

export function productPageHtml(p, settings = {}, related = []) {
  const currency = settings.currency || 'KSh';
  const price = salePrice(p);
  const inStock = num(p.stock) > 0;
  const image = absolute((p.images || [])[0], settings);
  const title = `${p.name}${p.brand ? ` by ${p.brand}` : ''} | ${settings.storeName || 'Tessora Beauty'}`;
  const description = metaDescription(p, settings);

  const gallery = (p.images || []).length
    ? `<img src="${esc(p.images[0])}" alt="${esc(p.name)}" width="800" height="800">`
    : `<div class="seo-ph">${esc(String(p.name).charAt(0).toUpperCase())}</div>`;

  const relatedList = related.length ? `
    <section class="seo-related">
      <h2>More in ${esc(p.category || 'the shop')}</h2>
      <ul>
        ${related.map((r) => `
          <li>
            <a href="/p/${esc(productSlug(r))}">
              ${(r.images || []).length
                ? `<img src="${esc(r.images[0])}" alt="" width="120" height="120" loading="lazy">`
                : '<span class="seo-ph seo-ph--sm">&#9733;</span>'}
              <b>${esc(r.name)}</b>
              <span>${esc(money(salePrice(r), currency))}</span>
            </a>
          </li>`).join('')}
      </ul>
    </section>` : '';

  const body = `
<body class="seo-page">
${siteHeader(settings)}
<main class="seo-wrap">
  <nav class="seo-crumbs" aria-label="Breadcrumb">
    <a href="/">Shop</a>
    ${p.category ? ` <span>&rsaquo;</span> <a href="/shop/${esc(slugify(p.category))}">${esc(p.category)}</a>` : ''}
    <span>&rsaquo;</span> <span aria-current="page">${esc(p.name)}</span>
  </nav>

  <article class="seo-product">
    <div class="seo-product__media">${gallery}</div>
    <div class="seo-product__body">
      ${p.category ? `<span class="seo-cat">${esc(p.category)}</span>` : ''}
      <h1>${esc(p.name)}</h1>
      ${p.brand ? `<p class="seo-brandline">by ${esc(p.brand)}</p>` : ''}
      <p class="seo-price">
        <strong>${esc(money(price, currency))}</strong>
        ${num(p.discount) > 0 ? `<s>${esc(money(p.price, currency))}</s>
          <em>${esc(String(Math.round(num(p.discount))))}% off</em>` : ''}
      </p>
      <p class="seo-stock ${inStock ? 'is-in' : 'is-out'}">
        ${inStock ? `In stock${num(p.stock) <= 5 ? `, only ${esc(String(p.stock))} left` : ''}` : 'Sold out'}
      </p>
      <p class="seo-desc">${esc(p.description || 'A Tessora Beauty favourite, carefully selected for you.')}</p>
      <a class="btn btn--gold btn--block" href="/?product=${esc(productSlug(p))}">
        ${inStock ? 'Add to bag in the shop' : 'See it in the shop'}
      </a>
      <ul class="seo-facts">
        ${p.sku ? `<li><span>SKU</span><b>${esc(p.sku)}</b></li>` : ''}
        <li><span>Payment</span><b>M-Pesa, before delivery</b></li>
        <li><span>Delivery</span><b>Across Kenya, priced by distance</b></li>
      </ul>
    </div>
  </article>

  ${relatedList}
</main>
${siteFooter(settings)}
</body>
</html>`;

  return head(settings, {
    title, description, image,
    canonical: productUrl(p, settings),
    jsonLd: [productJsonLd(p, settings), breadcrumbs(p, settings)]
  }) + body;
}

/* ----------------------------------------------------------- the category */

export function categoryPageHtml(category, products, settings = {}) {
  const currency = settings.currency || 'KSh';
  const shop = settings.storeName || 'Tessora Beauty';
  const title = `${category} | ${shop}`;
  const description =
    `${category} at ${shop}: ${products.slice(0, 6).map((p) => p.name).join(', ')}. `
    + 'Authentic, affordable, delivered across Kenya from Nairobi.';

  const jsonLd = [{
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: categoryUrl(category, settings),
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: products.length,
      itemListElement: products.slice(0, 50).map((p, i) => ({
        '@type': 'ListItem', position: i + 1,
        name: p.name, url: productUrl(p, settings)
      }))
    }
  }];

  const body = `
<body class="seo-page">
${siteHeader(settings)}
<main class="seo-wrap">
  <nav class="seo-crumbs" aria-label="Breadcrumb">
    <a href="/">Shop</a> <span>&rsaquo;</span> <span aria-current="page">${esc(category)}</span>
  </nav>
  <h1 class="seo-h1">${esc(category)}</h1>
  <p class="seo-lead">
    ${esc(String(products.length))} product${products.length === 1 ? '' : 's'} in ${esc(category)},
    paid by M-Pesa and delivered across Kenya.
  </p>
  <ul class="seo-grid">
    ${products.map((p) => `
      <li>
        <a href="/p/${esc(productSlug(p))}">
          ${(p.images || []).length
            ? `<img src="${esc(p.images[0])}" alt="" width="240" height="240" loading="lazy">`
            : '<span class="seo-ph seo-ph--sm">&#9733;</span>'}
          <b>${esc(p.name)}</b>
          ${p.brand ? `<i>${esc(p.brand)}</i>` : ''}
          <span>${esc(money(salePrice(p), currency))}</span>
        </a>
      </li>`).join('')}
  </ul>
</main>
${siteFooter(settings)}
</body>
</html>`;

  return head(settings, {
    title, description,
    canonical: categoryUrl(category, settings),
    image: absolute((products[0]?.images || [])[0], settings),
    jsonLd
  }) + body;
}

/* ------------------------------------------------------------- the sitemap */

export function sitemapXml(products, settings = {}) {
  const base = siteUrl(settings);
  const live = products.filter((p) => p.active !== false);
  const categories = [...new Set(live.map((p) => p.category).filter(Boolean))];
  const day = (iso) => {
    const d = new Date(iso || Date.now());
    return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
  };

  const entry = (loc, lastmod, changefreq, priority) =>
    `  <url>\n    <loc>${esc(loc)}</loc>\n`
    + (lastmod ? `    <lastmod>${esc(lastmod)}</lastmod>\n` : '')
    + `    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

  const newest = live.reduce((d, p) => {
    const t = p.updatedAt || p.createdAt;
    return !d || (t && t > d) ? (t || d) : d;
  }, '');

  // No comment before the root tag. It is valid XML, but sitemap fetchers vary
  // in how well they tolerate one, and there is nothing to gain by finding out.
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entry(`${base}/`, day(newest), 'daily', '1.0')}
${categories.map((c) => entry(categoryUrl(c, settings), day(newest), 'weekly', '0.7')).join('\n')}
${live.map((p) => entry(productUrl(p, settings), day(p.updatedAt || p.createdAt), 'weekly', '0.8')).join('\n')}
</urlset>
`;
}

/* -------------------------------------------- who the shop is, for Google */

export function organizationJsonLd(settings = {}) {
  const base = siteUrl(settings);
  const sameAs = [settings.instagram, settings.tiktok && `https://www.tiktok.com/@${String(settings.tiktok).replace(/^@/, '')}`]
    .filter((s) => s && /^https?:\/\//.test(s));

  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Store',
      name: settings.storeName || 'Tessora Beauty',
      description: settings.tagline || 'Makeup, skincare, body care and perfumes.',
      url: `${base}/`,
      logo: `${base}/assets/logo.svg`,
      image: `${base}/assets/share-card.jpg`,
      ...(settings.email ? { email: settings.email } : {}),
      ...(settings.whatsapp ? { telephone: `+${String(settings.whatsapp).replace(/\D/g, '')}` } : {}),
      ...(sameAs.length ? { sameAs } : {}),
      address: {
        '@type': 'PostalAddress',
        addressLocality: String(settings.location || 'Nairobi').split(',')[0].trim(),
        addressCountry: 'KE'
      },
      areaServed: { '@type': 'Country', name: 'Kenya' },
      currenciesAccepted: 'KES',
      paymentAccepted: 'M-Pesa'
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: settings.storeName || 'Tessora Beauty',
      url: `${base}/`,
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${base}/?q={search_term_string}` },
        'query-input': 'required name=search_term_string'
      }
    }
  ];
}
