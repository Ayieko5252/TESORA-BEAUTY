# Deploying Tessora Beauty

Your shop runs entirely on Netlify — the same `tessora-beauty.netlify.app` link
you already have. There is no second host to pay for and nothing to keep awake.

- **The pages** customers and you see come from `public/`.
- **The API** (`/api/*`), the receipts and the product photos are handled by one
  Netlify Function: `netlify/functions/api.mjs`.
- **Your data** — products, orders, customers, settings, activity log — lives in
  **Netlify Blobs**. It survives deploys. Deploying new code never touches it.

---

## Deploying

From inside this folder:

```bash
npm install -g netlify-cli
```

```bash
netlify login
```

```bash
netlify link
```

Choose the existing **tessora-beauty** site when `netlify link` asks. Then, to
publish:

```bash
netlify deploy --prod
```

Your products and orders are in Blobs, not in the code, so they are untouched by
this. The link never changes.

---

## After the first deploy

Everything below is set from **Admin → Settings**. None of it needs a redeploy.

### 1. Your admin password

You can now change it in **Settings → Admin password**. Until you do, the shop
falls back to the `ADMIN_PASSWORD` environment variable in Netlify (or `1234`
if that was never set). The first time you sign in after this update, that
password is saved as a hash so the panel can change it from then on.

> Set a real password before sharing the admin link. Minimum 8 characters.

### 2. Delivery by distance — Google Maps

**Settings → Store details → Delivery**

- **Charge per km** — set to **15** (KSh). This is the default.
- **Base fee** — optional flat amount added on top.
- **Store latitude / longitude** — where you deliver *from*. Distance is
  measured from this point.
- **Google Maps API key** — from Google Cloud, with these three APIs enabled:
  *Maps JavaScript*, *Places*, and *Distance Matrix*.

Without a key the shop still works: it estimates road distance from the
coordinates instead of asking Google, and charges the same 15 KSh/km.

Delivery time is estimated from the same distance:

| Distance | Quoted as |
| --- | --- |
| up to 5 km | Same day or next day |
| up to 15 km | 1–2 days |
| up to 40 km | 2–3 days |
| up to 100 km | 3–4 days |
| up to 300 km | 4–5 days |
| beyond that | 5–7 days |

### 3. M-Pesa — the payment prompt

**Settings → Payments**

Enter your Daraja **Consumer Key**, **Consumer Secret**, **Passkey** and
**Shortcode** (or Till), tick **Accept M-Pesa**, and set Environment to
**Production** when you are ready to take real money.

Leave **Callback URL** blank — the shop fills in
`https://tessora-beauty.netlify.app/api/mpesa/callback` automatically, which is
where Safaricom confirms the payment.

Until all four credentials are present, the M-Pesa option stays hidden at
checkout and customers pay on delivery.

### 4. Store reports by email

**Settings → Reports & alerts**

Every change is recorded in **Activity** whether or not email is set up — email
just sends you a copy. To switch it on:

1. Get a free API key at **resend.com** (3,000 emails a month).
2. Paste it into **Resend API key**.
3. Set **Send reports to** — your own address.
4. Set **Send from** — an address on a domain you have verified with Resend.
   Until you verify one, leave it blank and it sends from Resend's shared
   test sender.

Then choose what you want to hear about: new orders, payments, confirmations and
cancellations, and (if you want it) every product edit.

You can send a report to yourself at any time from **Activity → Email me this
report**.

---

## Where things are

```
public/               the shop and the admin panel
  index.html          storefront
  admin.html          admin panel
  receipt.html        receipt link handler
netlify/functions/
  api.mjs             the whole API, running on Netlify
  seed.mjs            starter products (only used on a brand-new store)
lib/
  pricing.js          distance, the 15 KSh/km charge, delivery estimates
  receipt.js          the receipt, in Tessora's colours
  activity.js         the store's activity log and report builder
  email.js            report and alert emails
  auth.js             password hashing and session tokens
mpesa.js              Safaricom Daraja STK push
server.js             the same shop, for running on your own computer
```

`server.js` and the Netlify function share everything in `lib/`, so a price
quoted locally is the same price quoted live.

---

## Running it on your own computer

```bash
npm start
```

That serves the shop at `http://localhost:3000` using `data/db.json` instead of
Netlify Blobs. Useful for trying changes before deploying. It is a separate
database from the live shop — nothing you do locally affects the real store.
