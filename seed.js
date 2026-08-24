// Seeds the store with sample products + branded placeholder artwork.
// Run: npm run seed        (safe to re-run: it replaces sample products only)
//      node seed.js --if-empty   (used on a server's first boot: does nothing
//                                 once the shop already has products)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, saveNow, newId } from './db.js';

if (process.argv.includes('--if-empty') && db.products.length > 0) {
  console.log(`Shop already has ${db.products.length} products — not seeding.`);
  process.exit(0);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ART_DIR = path.join(ROOT, 'public', 'assets', 'products');
fs.mkdirSync(ART_DIR, { recursive: true });

/* ---------------------------------------------------------- artwork ---- */
const SHAPES = {
  lipstick: `<rect x="255" y="300" width="90" height="190" rx="10" fill="#2a2523"/>
             <rect x="262" y="272" width="76" height="36" rx="6" fill="url(#g)"/>
             <path d="M272 272h56v-78q0-26-28-40-28 14-28 40z" fill="#b8536c"/>`,
  palette: `<rect x="140" y="230" width="320" height="200" rx="22" fill="#2a2523"/>
            <rect x="160" y="250" width="280" height="140" rx="14" fill="#fdeef1"/>
            ${[0, 1, 2, 3].map((i) => `<circle cx="${205 + i * 62}" cy="300" r="24" fill="${['#e39fae', '#b8536c', '#c9a227', '#8d6e63'][i]}"/>`).join('')}
            ${[0, 1, 2, 3].map((i) => `<circle cx="${205 + i * 62}" cy="356" r="24" fill="${['#f7c9d3', '#d98f7a', '#e8cd7a', '#6d4c41'][i]}"/>`).join('')}`,
  dropper: `<rect x="250" y="270" width="100" height="200" rx="18" fill="#fbf7f2" stroke="#e39fae" stroke-width="4"/>
            <rect x="264" y="320" width="72" height="140" rx="12" fill="#f2d7a8"/>
            <rect x="278" y="180" width="44" height="96" rx="10" fill="url(#g)"/>
            <rect x="286" y="150" width="28" height="40" rx="8" fill="#2a2523"/>`,
  lotion: `<rect x="238" y="280" width="124" height="200" rx="26" fill="#fdeef1" stroke="#e39fae" stroke-width="4"/>
           <rect x="238" y="350" width="124" height="60" fill="#f7c9d3"/>
           <rect x="282" y="228" width="36" height="56" rx="8" fill="#2a2523"/>
           <path d="M318 244h34a12 12 0 0 1 12 12v14" stroke="#2a2523" stroke-width="12" fill="none" stroke-linecap="round"/>`,
  perfume: `<rect x="236" y="286" width="128" height="192" rx="24" fill="#fdeef1" stroke="url(#g)" stroke-width="5"/>
            <rect x="270" y="236" width="60" height="56" rx="8" fill="#f7c9d3"/>
            <rect x="264" y="196" width="72" height="46" rx="10" fill="url(#g)"/>
            <circle cx="300" cy="390" r="42" fill="#f7c9d3" opacity=".7"/>`,
  shampoo: `<path d="M256 250h88q16 0 16 18v198q0 18-16 18h-88q-16 0-16-18V268q0-18 16-18z" fill="#fdeef1" stroke="#e39fae" stroke-width="4"/>
            <rect x="240" y="330" width="120" height="72" fill="#e39fae" opacity=".55"/>
            <rect x="276" y="206" width="48" height="48" rx="10" fill="#2a2523"/>`,
  brush: `<path d="M300 168q34 34 34 82t-34 60q-34-12-34-60t34-82z" fill="#2a2523"/>
          <rect x="278" y="300" width="44" height="30" rx="6" fill="url(#g)"/>
          <rect x="282" y="330" width="36" height="160" rx="14" fill="#e39fae"/>`,
  gift: `<rect x="180" y="300" width="240" height="170" rx="16" fill="#f7c9d3"/>
         <rect x="168" y="256" width="264" height="56" rx="12" fill="#fdeef1" stroke="#e39fae" stroke-width="3"/>
         <rect x="282" y="256" width="36" height="214" fill="url(#g)"/>
         <path d="M300 256q-40-6-40-34t40 34zm0 0q40-6 40-34t-40 34z" fill="url(#g)"/>`
};

function artwork(shape, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#e8cd7a"/><stop offset="50%" stop-color="#c9a227"/><stop offset="100%" stop-color="#f4e3ad"/>
    </linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fdeef1"/><stop offset="100%" stop-color="#fbf7f2"/>
    </linearGradient>
  </defs>
  <rect width="600" height="600" fill="url(#bg)"/>
  <circle cx="300" cy="316" r="196" fill="#fff" opacity=".62"/>
  ${SHAPES[shape]}
  <path d="M282 62 L290 44 L300 58 L310 44 L318 62 Z" fill="url(#g)"/>
  <text x="300" y="552" text-anchor="middle" font-family="Georgia, serif" font-size="30"
        letter-spacing="9" fill="#2a2523">TESSORA</text>
  <text x="300" y="578" text-anchor="middle" font-family="Georgia, serif" font-size="15"
        letter-spacing="5" fill="#b8536c">${label}</text>
</svg>`;
}

function writeArt(shape, label) {
  const file = `${shape}.svg`;
  fs.writeFileSync(path.join(ART_DIR, file), artwork(shape, label));
  return `/assets/products/${file}`;
}

const ART = {
  lipstick: writeArt('lipstick', 'LIPS'),
  palette: writeArt('palette', 'MAKEUP'),
  dropper: writeArt('dropper', 'SKINCARE'),
  lotion: writeArt('lotion', 'BODY CARE'),
  perfume: writeArt('perfume', 'FRAGRANCE'),
  shampoo: writeArt('shampoo', 'HAIR CARE'),
  brush: writeArt('brush', 'ACCESSORIES'),
  gift: writeArt('gift', 'GIFT SETS')
};

/* --------------------------------------------------------- products ---- */
const SAMPLES = [
  ['Glossy Shine Lip Gloss', 'Kiss Beauty', 'Lip Products', 450, 0, 48, 'lipstick', 'Soft, glossy and irresistible lips. Non-sticky formula with a mirror finish.', true],
  ['Fruity Hydrating Lip Oil', 'Bioaqua', 'Lip Products', 380, 15, 32, 'lipstick', 'Hydrated, juicy, healthy lips all day. Available in cherry, apple and peach.', true],
  ['Matte Lip Liner Pencil', 'Miss Rose', 'Lip Products', 250, 0, 60, 'lipstick', 'Define your beauty with a smooth, long-wearing nude lip liner.', false],
  ['Velvet Matte Liquid Lipstick', 'Kiss Beauty', 'Lip Products', 550, 20, 24, 'lipstick', 'Full coverage matte colour that lasts through the day.', false],

  ['Fit Me Matte Foundation', 'Maybelline', 'Makeup', 1450, 10, 18, 'palette', 'Matte and poreless finish that blends into your natural skin tone.', true],
  ['9 Shade Eyeshadow Palette', 'Kiss Beauty', 'Makeup', 890, 0, 15, 'palette', 'Nine blendable shades from soft neutrals to bold shimmer.', false],
  ['Loose Setting Powder', 'Kiss Beauty', 'Makeup', 650, 0, 22, 'palette', 'Lightweight powder that sets your makeup for a flawless finish.', false],
  ['Waterproof Liquid Eyeliner', 'NYX', 'Makeup', 480, 0, 4, 'palette', 'Precise, deep black wing that stays put all day.', false],
  ['Volumising Mascara', 'Miss Rose', 'Makeup', 520, 15, 26, 'palette', 'Bold lashes with lift and volume in a few strokes.', false],
  ['Baked Blush Duo', 'Kiss Beauty', 'Makeup', 700, 0, 0, 'palette', 'A natural flush of colour with a soft-focus finish.', false],

  ['Vitamin C Brightening Serum', 'The Ordinary', 'Skincare', 1650, 12, 12, 'dropper', 'Brightens dull skin and evens out tone with daily use.', true],
  ['Gentle Foaming Face Wash', 'CeraVe', 'Skincare', 1250, 0, 20, 'dropper', 'Cleanses without stripping. Suitable for sensitive skin.', false],
  ['Hydrating Water Gel Moisturiser', 'Neutrogena', 'Skincare', 1500, 0, 9, 'dropper', 'Lightweight gel that keeps skin plump and hydrated.', false],
  ['SPF 50 Facial Sunscreen', 'Nivea', 'Skincare', 1100, 10, 16, 'dropper', 'Daily broad-spectrum protection with no white cast.', false],
  ['Rose Glow Face Mask', 'Ponds', 'Skincare', 300, 0, 40, 'dropper', 'A weekly treat for soft, glowing skin.', false],

  ['Shea Sugar Body Scrub', 'Tree Hut', 'Body Care', 1850, 15, 11, 'lotion', 'Polishes away dullness and leaves skin smooth and glowing.', true],
  ['Even Tone Body Lotion', 'Vaseline', 'Body Care', 850, 0, 28, 'lotion', 'Daily moisture with a healthy, even-toned finish.', false],
  ['Whipped Body Butter', 'Shea Moisture', 'Body Care', 1600, 0, 7, 'lotion', 'Rich, deeply nourishing butter for very dry skin.', false],
  ['Soft Moisturising Cream', 'Nivea', 'Body Care', 550, 0, 34, 'lotion', 'The classic all-rounder for face, body and hands.', false],

  ['Pure Seduction Body Mist', "Victoria's Secret", 'Perfumes & Mists', 1950, 20, 14, 'perfume', 'Smell good, feel amazing. A fresh, flirty signature scent.', true],
  ['Yara Eau de Parfum', 'Lattafa', 'Perfumes & Mists', 3800, 10, 6, 'perfume', 'Long lasting, captivating fragrance with vanilla and orchid.', true],
  ['Glam Woman Eau de Parfum', 'Bellavita', 'Perfumes & Mists', 2400, 0, 8, 'perfume', 'A warm, confident fragrance for day into night.', false],
  ['Vanilla Fragrance Mist', 'Tessora Select', 'Perfumes & Mists', 900, 0, 30, 'perfume', 'Sweet, soft vanilla — perfect for layering.', false],
  ['Roll-On Perfume Oil', 'Tessora Select', 'Perfumes & Mists', 350, 0, 45, 'perfume', 'Pocket-size fragrance oil that lasts for hours.', false],

  ['Nourishing Shampoo', 'Sunsilk', 'Hair Care', 620, 0, 24, 'shampoo', 'Cleanses gently and leaves hair soft and manageable.', false],
  ['Intensive Hair Conditioner', 'Dove', 'Hair Care', 680, 10, 18, 'shampoo', 'Restores moisture and reduces breakage.', false],

  ['3D Mink False Lashes', 'Kiss Beauty', 'Beauty Accessories', 300, 0, 55, 'brush', 'For that extra pretty look — reusable and easy to apply.', true],
  ['12-Piece Makeup Brush Set', 'Tessora Select', 'Beauty Accessories', 1400, 15, 10, 'brush', 'Everything you need, from foundation to blending.', false],
  ['Beauty Blender Sponge Set', 'Tessora Select', 'Beauty Accessories', 350, 0, 38, 'brush', 'Soft sponges for a seamless, natural finish.', false],
  ['Satin Scrunchie Pack', 'Tessora Select', 'Beauty Accessories', 250, 0, 3, 'brush', 'Gentle on hair, pretty on your wrist. Pack of four.', false],

  ['Glow Getter Gift Set', 'Tessora Beauty', 'Gift Sets', 4500, 20, 5, 'gift', 'Body mist, lip oil, scrub and lotion in a signature Tessora box.', true],
  ['Lip Lover Mini Set', 'Tessora Beauty', 'Gift Sets', 1500, 0, 9, 'gift', 'Three best-selling lip glosses wrapped and ready to gift.', false]
];

const now = Date.now();
const products = SAMPLES.map(([name, brand, category, price, discount, stock, art, description, featured], i) => ({
  id: newId(),
  name,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  category,
  brand,
  description,
  price,
  discount,
  stock,
  sku: `TB-${String(1001 + i)}`,
  images: [ART[art]],
  featured,
  active: true,
  createdAt: new Date(now - i * 36e5).toISOString(),
  updatedAt: new Date(now - i * 36e5).toISOString(),
  sample: true
}));

const kept = db.products.filter((p) => !p.sample);
db.products = [...products, ...kept];
saveNow();

console.log(`Seeded ${products.length} sample products (${kept.length} of your own products kept).`);
console.log('Delete them any time from the admin Products tab.');
