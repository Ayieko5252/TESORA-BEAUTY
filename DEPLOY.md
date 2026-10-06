# Putting Tessora Beauty online

This gets you a shareable link like `https://tessora-beauty--yourproject.code.run`,
running on Northflank: always on, never sleeps, and your products stay put.

About 20 minutes. You need a GitHub account and a Northflank account.

**Cost:** the shop itself is free. The storage for your products and photos is
Northflank's cheapest add-on, 4GB minimum at $0.15/GB, so roughly **$0.60 a
month** (about 80 KES). Northflank asks for a card to verify you, and bills at
the end of the cycle.

---

## Step 0, change the admin password

Your shop is about to be reachable by anyone with the link. `1234` is not safe on
the open internet, whoever guesses it can change your prices, stock and orders.

1. `npm start`, open http://localhost:3000/admin, sign in with `1234`
2. **Settings → Admin password** → set something long
3. Write it down somewhere safe

Do this first. It is the one step you cannot undo if someone gets in.

---

## Step 1, put the code on GitHub

The code is already committed on your computer. It just needs somewhere to live.

1. Go to https://github.com/new
2. Repository name: `tessora-beauty`
3. Choose **Private**
4. Do **not** tick "Add a README", the repo must start empty
5. Click **Create repository**

Then run these, replacing `YOUR-USERNAME`:

```bash
git remote add origin https://github.com/YOUR-USERNAME/tessora-beauty.git
```

```bash
git push -u origin main
```

It asks you to sign in to GitHub the first time.

---

## Step 2, create the Northflank project

1. Sign up at https://northflank.com (sign up **with GitHub**, it saves
   connecting the accounts later)
2. Add your card when asked. This verifies you; nothing is charged now.
3. Click **Create new** → **Project**. Name it `tessora`, pick the region
   closest to Kenya (usually **Europe**), and create it.

---

## Step 3, create the storage volume *first*

Do this before creating the service, a volume is easiest to attach at the moment
the service is created.

1. Inside your project, go to **Volumes** → **Create volume**
2. Name: `tessora-data`
3. Size: **4 GB** (their minimum, far more than this shop will ever need)
4. Create it

This is the bit that costs about $0.60/month, and it is what stops your products
and photos disappearing.

---

## Step 4, create the service

1. **Create new** → **Service** → **Combined service** (it builds and runs in one)
2. Name: `tessora-beauty`
3. Repository: pick your `tessora-beauty` repo, branch `main`
4. Build: choose **Dockerfile**, path `/Dockerfile`, the repo already has one
5. **Networking / Ports:** port **8080**, protocol **HTTP**, and turn on
   **Publicly accessible**
6. **Volumes:** attach `tessora-data`, mount path **`/data`**

   This must be exactly `/data`, it is where the shop writes your products,
   orders and uploaded photos.
7. Resources: the free **nano** plan is plenty
8. Click **Create service**

The first build takes two or three minutes. When it goes green, Northflank shows
your public URL at the top of the service page. **That is the link you share.**

Your admin panel is that same address with `/admin` on the end.

---

## Step 5, set your real WhatsApp number

The order buttons currently point at a placeholder, so orders would go nowhere.

On your live site: **/admin → Settings → WhatsApp number**. Full country code, no
`+` and no spaces, for example `254712345678`. Save.

Set your Instagram and TikTok handles while you are there.

---

## What happens on that first start

The very first time the shop boots on an empty volume, it loads the 32 sample
products so the site doesn't look broken. Delete them from **Admin → Products**
once you've added your own.

After that it never seeds again, every restart and every redeploy keeps whatever
is on the volume. Your products, photos and orders are safe.

---

## Updating the shop later

When you change the code on your computer:

```bash
git add -A && git commit -m "describe what changed" && git push
```

Northflank sees the push and rebuilds automatically.

You do **not** need this for everyday work. Adding products, changing prices,
adjusting stock and handling orders all happen in the admin panel on the live
site, no code, no deploying.

---

## Backing up

Everything lives in `/data` on the volume: `db.json` (products, orders, settings)
and `uploads/` (your product photos).

Northflank gives the service a shell from the dashboard, so you can download that
folder now and then. On your own computer, copying the `data/` folder is a
complete backup. `data/` is deliberately kept out of Git, so a deploy can never
overwrite your live shop and customer phone numbers never land on GitHub.

---

## If Northflank won't attach a volume on the free plan

I could not verify from the outside whether their free Sandbox plan accepts a
paid volume. If step 4 blocks you, you have two ways forward:

- Upgrade the project to their cheapest paid tier and attach the volume as above.
- Tell me, and I'll move the shop's storage into a hosted database and object
  storage instead, so it runs on a free plan with no disk at all.

Everything else in this guide stays the same either way.
