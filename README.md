# Tessora Beauty — online cosmetic store

A complete online shop for Tessora Beauty: a customer storefront plus a private admin
panel where you upload products, set prices and discounts, and manage stock and orders.

Built with plain Node.js, HTML, CSS and JavaScript — **no dependencies to install**,
nothing to build. Data lives in `data/db.json`, product photos in `data/uploads/`.

---

## Running the shop

```bash
npm start
```

Then open:

| Page | Address |
| --- | --- |
| Storefront | http://localhost:3000 |
| Admin panel | http://localhost:3000/admin |

**Admin password: `1234`** — change it any time in Admin → Settings.

To use a different port: `set PORT=8080` (PowerShell: `$env:PORT=8080`) before `npm start`.

---

## What the admin can do

**Products** — Add a product with photos (click or drag & drop, up to 5 per product),
name, brand, category, SKU, description, price, discount % and stock quantity.
Edit or delete any product, hide it from the shop without deleting it, or mark it a bestseller.
As you type a price and discount, the panel shows exactly what the customer will see.

**Inventory** — Every product's stock in one table. Adjust with the − / + buttons, type an
exact number, or use the +10 / +50 restock buttons. Changes save instantly. Filter to
low-stock or out-of-stock items. Shows total units and the shilling value of your stock.

**Orders** — Every order placed on the site, with customer name, phone, delivery location
and notes. Set status to pending / confirmed / delivered / cancelled, and message the
customer on WhatsApp in one click.

**Settings** — Store name, tagline, announcement bar, WhatsApp number, Instagram and TikTok
handles, location, currency, delivery fee, free-delivery threshold, and the low-stock
alert level. Also where you change your password.

---

## How stock works

- Each product card on the shop shows its live stock: `12 in stock`,
  `Low stock — only 3 left`, or `Out of stock` (with the buy button disabled).
- "Low stock" kicks in at the threshold you set in Settings (default 5).
- When a customer places an order, stock is **reduced automatically**.
- Cancel an order and the stock goes **back** to the product. Re-open it and it is taken again.
- A customer can never order more than you have — the server checks stock before accepting.

## How discounts work

Set a discount percentage on the product. The shop then shows the new price, the old price
crossed out, a `-20%` badge, and how much the customer saves. Discounted items also appear
in the **Offers** section on the home page. Set the discount back to 0 to end the offer.

## How orders reach you

A customer fills in name, phone and location and places the order. It is saved to your
admin panel immediately, and they get a **Send order on WhatsApp** button that opens a
chat with the full order already written out. Customers can also skip the form and order
straight from the cart via WhatsApp.

---

## Sample products

The shop ships with 32 sample products so it doesn't look empty. Delete them from
Admin → Products whenever you're ready, or re-add them any time:

```bash
npm run seed
```

Stop the server before seeding, then start it again. Seeding never touches products
you added yourself, or your orders and settings.

---

## Files

```
server.js            API + web server
db.js                JSON datastore, password hashing
seed.js              sample products + placeholder artwork
data/db.json         your products, orders and settings   <-- back this up
data/uploads/        uploaded product photos              <-- back this up
public/
  index.html         storefront
  admin.html         admin panel
  css/               styles.css (shop), admin.css (admin)
  js/                store.js (shop), admin.js (admin)
  assets/            logo + generated product artwork
```

**Backing up:** copy the `data/` folder. That's your whole shop.

---

## Good to know

- The admin password is stored hashed (PBKDF2, 120k iterations) — never in plain text.
  Login is rate-limited to 8 attempts per 15 minutes.
- Admin sessions last 8 hours and end when the server restarts.
- Product photos are limited to 6MB each and must be PNG, JPG, WEBP or GIF.
- Run only one copy of the server at a time — it holds the database in memory, so a
  second copy would overwrite the first one's changes.
- Prices are whole numbers (no cents), which suits KSh pricing.

### Putting it online

It runs as-is on any host that runs Node 20+ (Railway, Render, a VPS). Two things to do
first: make sure `data/` is on persistent storage so your products and photos survive a
restart, and put it behind HTTPS — the admin password is sent over the connection at login.

**Before going public, set a longer password.** `1234` is fine while the shop only runs on
your own computer, but on the open internet a four-digit password is guessable. Anyone who
gets in can change your prices, stock and orders. Admin → Settings, something long.
