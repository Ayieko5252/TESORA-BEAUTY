# Tessora Beauty — online cosmetic store

A complete online shop for Tessora Beauty: a customer storefront with accounts, M-Pesa
payment, mapped delivery and receipts, plus a private admin panel where you upload
products, set prices and discounts, manage stock and orders, and see everything that has
happened in the store.

Built with plain Node.js, HTML, CSS and JavaScript — nothing to build, and the only
dependency is `@netlify/blobs`, which is used when the shop runs on Netlify.

**Live at [tessora-beauty.netlify.app](https://tessora-beauty.netlify.app)**, where the
API runs as a Netlify function and the data lives in Netlify Blobs. See
**[NETLIFY-DEPLOY.md](NETLIFY-DEPLOY.md)** for deploying and for switching on Maps,
M-Pesa and emailed reports.

Run locally and it uses `data/db.json` instead, with photos in `data/uploads/` — a
separate database, so nothing you try locally touches the real shop.

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

**Starting admin password: `1234`** — change it in Admin → Settings → Admin password.
It must be at least 8 characters and not only digits. On the live shop the starting
password comes from the `ADMIN_PASSWORD` environment variable in Netlify, and is saved as
a hash the first time you sign in so you can change it from the panel afterwards.

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

## How customers order

Shoppers **create an account** first — name, email, phone and a password. Their details
and delivery location are saved, so their next order takes seconds, and every order and
receipt stays in **Your account → Your orders**.

At checkout they pin their delivery point on the map. The shop measures how far that is
from you and works out the delivery charge and how long delivery should take, before they
commit to anything.

## How payment works

**Everything is paid up front by M-Pesa. The shop does not take cash on delivery.**

Placing an order sends an M-Pesa prompt (STK push) to the customer's phone; they enter
their PIN and the order is marked paid, with the M-Pesa receipt number recorded against it.

Until M-Pesa is configured in Admin → Settings → Payments, orders are still taken and
saved as **awaiting payment**, and the customer is pointed at WhatsApp to settle — they
are never offered payment on delivery.

## Delivery charges and timing

Delivery is **15 KSh per kilometre** from your shop, and how long it takes is estimated
from the same distance:

| Distance | Arrives |
| --- | --- |
| up to 5 km | Same day or next day |
| up to 15 km | 1–2 days |
| up to 40 km | 2–3 days |
| up to 100 km | 3–4 days |
| up to 300 km | 4–5 days |
| beyond that | 5–7 days |

Free delivery still overrides this once an order passes your free-delivery threshold.

## Receipts

Every order gets a receipt in Tessora's colours, showing the full cost breakdown — each
item, the subtotal, exactly how the delivery charge was worked out (`3.8 km × KSh 15/km`),
and the total — plus where it is going and when it should arrive. Customers can open it
from their order confirmation or their account, and print or save it as a PDF.

## Everything is recorded

**Admin → Activity** is the store's paper trail: every product added, every price and
stock change with its before and after, every order placed, confirmed or cancelled, every
payment, every settings change and every password change — with the time and who did it.

The same tab builds a **store report** for today, the last 7 days or the last 30 days:
what sold, what it earned, what needs restocking, and everything that changed. You can
email it to yourself once a Resend API key is set in Settings → Reports.

## The books, and downloading your data

**Admin → Activity → The books & downloads** gives you five things:

| Download | What it is |
| --- | --- |
| **Balance sheet** | What the shop owns and owes today — cash collected, money customers still owe you, and stock on hand — and the equity that leaves. |
| **Financial analysis** | Sales, cost of goods sold, gross profit and margin, cancellations, cash collected vs. outstanding, your most profitable products, and the daily trend. Pick today, 7 / 30 / 90 days, or all time. |
| **Inventory** | Every product with cost, price, discount, stock, and what that stock is worth at cost and at retail. |
| **Orders** | Every order with customer, distance, delivery charge, payment status and M-Pesa receipt. |
| **Full backup** | Products, orders, customers and the activity log in one file. Passwords and payment secrets are never included. |

The two statements open as a page you can **Print / Save as PDF**; everything else
downloads as a spreadsheet that opens in Excel or Google Sheets.

### Cost prices

Profit needs to know what you paid. Each product now has an optional **Cost price**
(Admin → Products). Where it is missing, the shop does not guess — it counts that stock
as zero and prints a plain warning on the statement telling you how many products are
missing a cost. Fill them in and the figures become exact.

The admin panel refreshes on its own every few seconds — new orders, stock and activity
appear without anyone pressing reload, and the **Live** dot in the sidebar shows when it
last checked. The storefront does the same with stock counts, so a customer never adds
something that has just sold out. Both pause while the tab is in the background.

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

See **[DEPLOY.md](DEPLOY.md)** for step-by-step instructions to get a shareable link.
It deploys to Northflank, where the shop stays awake and keeps your data.

Two things that matter wherever you host it:

- **Set a longer password first.** `1234` is fine while the shop only runs on your own
  computer, but on the open internet a four-digit password is guessable, and anyone who
  gets in can change your prices, stock and orders.
- **Keep `data/` on persistent storage.** That folder *is* your shop. On a host with no
  disk, every product and photo you add is wiped on the next restart.
