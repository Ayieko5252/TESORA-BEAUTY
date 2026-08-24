# Putting Tessora Beauty online

This gets you a shareable link like `https://tessora-beauty.onrender.com`.

Roughly 15 minutes. You need a GitHub account and a Render account — both free,
both sign up with your email.

---

## Before you start: change the admin password

Your shop is about to be reachable by anyone with the link. `1234` is not safe
on the open internet — whoever guesses it can change your prices, stock and orders.

1. `npm start`, open http://localhost:3000/admin, sign in with `1234`
2. **Settings → Admin password** → set something long
3. Write it down somewhere safe

Do this first. It only takes a minute and it is the one step you cannot undo later
if someone gets in.

---

## Step 1 — put the code on GitHub

The code is already committed locally. You just need somewhere to push it.

1. Go to https://github.com/new
2. Repository name: `tessora-beauty`
3. Choose **Private** (nobody needs to read your shop's code)
4. Do **not** tick "Add a README" — the repo must start empty
5. Click **Create repository**

GitHub then shows you a page with commands. Ignore those and run these instead,
replacing `YOUR-USERNAME` with your GitHub username:

```bash
git remote add origin https://github.com/YOUR-USERNAME/tessora-beauty.git
```

```bash
git push -u origin main
```

It will ask you to sign in to GitHub the first time.

---

## Step 2 — deploy on Render

1. Go to https://render.com and sign up (choose **GitHub** as the sign-up method —
   it saves connecting the accounts later)
2. Click **New** → **Blueprint**
3. Pick your `tessora-beauty` repository
4. Render reads `render.yaml` and fills everything in — just click **Apply**
5. Wait about two minutes for the first build

Your link appears at the top of the Render page, something like
`https://tessora-beauty.onrender.com`. That is the link you share.

The admin panel is at that same address with `/admin` on the end.

---

## Step 3 — set your real WhatsApp number

The order buttons currently point at a placeholder number, so orders would go nowhere.

On your live site: **/admin → Settings → WhatsApp number**. Use the full country
code with no `+` or spaces, for example `254712345678`. Save.

While you are there, set your Instagram and TikTok handles too.

---

## Two things to know about the free plan

**The shop sleeps.** After 15 minutes with no visitors, Render puts it to sleep.
The next person to open your link sees a loading page for about a minute while it
wakes up. Fine for sharing with friends, annoying for real customers. (You also
get 750 free hours a month, which is roughly one service running full time.)

**Your products reset.** This is the important one. On the free plan Render gives
the shop no permanent storage, so every product you add, every photo you upload
and every order you receive disappears when the service restarts — which happens
each time it sleeps, and on every deploy. The shop comes back with the 32 sample
products.

So the free plan is right for *showing people the shop*. It is not somewhere to
run the real business — Render's own documentation says not to use free instances
for production.

### When you're ready to sell for real

In Render: open your service → **Settings** → change the instance type from Free
to a paid one (**Starter** is the cheapest; check render.com/pricing for the
current rate). Persistent disks are only available on paid services, which is
what makes your data stick.

Then open `render.yaml` in this folder and delete the `#` from the last four
lines so it reads:

```yaml
    disk:
      name: tessora-data
      mountPath: /opt/render/project/src/data
      sizeGB: 1
```

Then:

```bash
git add render.yaml && git commit -m "Add persistent disk" && git push
```

Render redeploys with a real disk. From that point your products, photos and
orders stay put, and the shop stops sleeping.

---

## Updating your shop later

Any time you change the code on your computer:

```bash
git add -A && git commit -m "describe what changed" && git push
```

Render notices the push and redeploys automatically in a minute or two.

You do **not** need this for everyday work — adding products, changing prices and
managing stock all happen in the admin panel on the live site, no code involved.

---

## Backing up

Your shop's data lives in the `data/` folder on the server, and is deliberately
kept out of Git so a deploy can never overwrite it.

On the paid plan, take a backup now and then from Render's **Disks** section.
On your own computer, copying the `data/` folder is a complete backup.
