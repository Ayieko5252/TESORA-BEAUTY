# Tessora Beauty, where things stand

The shop is live at <https://tessorabeauty.co.ke>.

Last updated 8 October 2026.

---

## The one thing blocking everything else

**Netlify will not accept new deploys.**

```
403 Account credit usage exceeded - new deploys are blocked until credits are added
```

The free plan's 300 monthly credits are spent. The usage period resets on
**21 October 2026**.

The shop itself is completely unaffected: it keeps serving from the last
successful deploy, and every page returns normally. What is affected is
anything that needs new code or new environment variables to go out. Two
things are waiting on it, one of which matters.

### Waiting, and it matters
A security fix. The shop front was publishing `costPrice`, the price you pay
your supplier, on every product that has one. **46 of your 91 products are
exposing it right now.** It is fixed in the code and pushed to GitHub, but it
cannot reach the live site until a deploy succeeds.

Nothing else is leaking: no orders, no customers, no passwords, no payment
keys. It is your margin, visible to anyone who knows where to look.

### Waiting, and it does not matter much
`ORDERS_EMAIL` and `REPORT_EMAIL` are set on Netlify but need a deploy to take
effect. You do not need them: setting the same values in the admin panel
works immediately, because admin settings live in the database rather than in
the deploy.

### What to do
Either wait for 21 October, or add credits to the Netlify account. It is your
call and your money; the shop trades perfectly well in the meantime.

---

## Done

### Email, both directions
- **Zoho Mail** receives. `customer.care@tessorabeauty.co.ke` and
  `orders@tessorabeauty.co.ke` exist and the domain is verified.
- **Resend** sends, and the domain is **verified**: DKIM and both sending
  CNAMEs confirmed.
- DNS holds exactly one SPF record, which is Zoho's. Resend authorises sending
  through CNAMEs instead, so there was no merge to get wrong. Two SPF records
  is the commonest reason business mail is marked as spam.
- Resend's **inbound MX was deliberately not added**. It sits at the root, the
  same place Zoho's does, and would have taken delivery away from your
  mailboxes silently.

Check delivery at any time:

```bash
node scripts/test-mail-delivery.mjs customer.care@tessorabeauty.co.ke
```

### Being found
- Every product has its own address, `tessorabeauty.co.ke/p/<name>`, rendered
  on the server with its picture, price and stock in the form Google reads.
- Categories too, at `/shop/<category>`.
- `sitemap.xml` is built from the live catalogue, so a product is listed the
  day you add it. 94 addresses.
- All 94 submitted to **IndexNow**, which reaches Bing, Yandex, Seznam and
  Naver without an account. Ecosia and DuckDuckGo sit downstream of Bing.
- The old `netlify.app` address now redirects here, so the shop is not
  competing with a copy of itself.
- Google Search Console is verified.

### Security
- Admin endpoints reject unauthenticated and forged tokens. Checked against
  the live site, not just read in the code.
- The M-Pesa prompt, placing an order and delivery quotes are all throttled.
  The prompt is limited **per phone number**, because Safaricom puts very many
  customers behind very few addresses and an address limit would turn real
  buyers away silently.
- `npm audit`: clean. One dependency.
- The production code logs nothing at all, so no password or token can end up
  in a log.
- `.env` is ignored.
- Forgotten passwords can be reset, by a shopper and by you.

---

## Still yours to do

### 1. Finish Resend, in the admin panel
Create a key at <https://resend.com/api-keys> with **Sending access**, then
Admin, Settings, Reports:

| Field | Value |
|---|---|
| Send reports to | `orders@tessorabeauty.co.ke` |
| Send from | `Tessora Beauty <orders@tessorabeauty.co.ke>` |
| Resend API key | the `re_…` key |
| Customer care email | `customer.care@tessorabeauty.co.ke` |
| Orders email | `orders@tessorabeauty.co.ke` |
| Shop address | `https://tessorabeauty.co.ke` |

Tick **Email the customer their confirmation and receipt**, save, then
**Send me a test email**.

Copy the key when Resend shows it. It is shown once. If you lose it, delete
it and make another; nothing breaks.

This works today. It does not need a deploy.

### 2. Receive the money
The payment flow is finished and switched off, because it has nowhere to pay
into.

A payment prompt **cannot be sent to a personal M-Pesa number**. Safaricom
only allows it into a **Till** or a **Paybill**.

1. Get a Till: a Safaricom dealer, `*234#`, or the M-Pesa Business app. You
   need your ID and business registration. You come away with a Till number
   and a Head Office number.
2. Get keys at <https://developer.safaricom.co.ke>: create an app for the
   Consumer Key and Secret, then apply to **Go Live** for the Passkey.
3. Admin, Settings, M-Pesa: type Buy Goods, your shortcode and till, the three
   keys, environment Production, and callback URL
   `https://tessorabeauty.co.ke/api/mpesa/callback`. Switch M-Pesa on.

Money then lands in your M-Pesa Business account, which you draw from your own
number.

### 3. Change the admin password
It has been discussed in this project, so treat it as known. Admin, Settings,
Password. If you are ever locked out, see below.

### 4. Google, when you have a moment
Submit `sitemap.xml` in Search Console and request indexing on the home page.
The sitemap showed "Couldn't fetch" at first; it is served correctly, so
resubmit if it has not cleared.

A **Google Business Profile** is worth more than everything else on this page
for a Nairobi shop. So is your domain in your Instagram and TikTok bios.

---

## When something goes wrong

### Back up the shop
```bash
node scripts/backup.mjs            # save a copy
node scripts/backup.mjs --list     # what has been saved
node scripts/backup.mjs --verify <file>
node scripts/backup.mjs --restore <file>
```

A restore saves the current shop first, and keeps your passwords and payment
keys from the live store rather than from the file. Backups hold customer
names and phone numbers; they stay in `backups/`, out of Git. Run one before
anything risky.

### Locked out of the admin panel
If email is working, use **Forgot the password?** on the admin sign-in. The
link goes only to the shop's saved address.

If email is not working, from this computer:

```bash
node scripts/reset-admin-password.mjs "your new password"
```

This needs no password and no deploy. It ends every signed-in admin session.

### Tell search engines about new products
```bash
node scripts/submit-indexnow.mjs
```
