# Tessora Beauty, the three things only you can do

The shop is built and running at <https://tessorabeauty.co.ke>. Three things
need your own accounts, because they ask for passwords and keys that must never
pass through anyone else's hands. Each one is short.

---

## 1. Receive the money in your own M-Pesa

**Where it stands:** the shop can already send a payment prompt, watch for the
money, confirm it with Safaricom, write the receipt and email it. It is switched
off because it has no account to pay into yet.

**The one thing to know first:** a payment prompt cannot be sent to a personal
M-Pesa number. Safaricom only allows it into a **Till (Buy Goods)** or a
**Paybill**. A Till is the usual choice for a shop like yours. Money that comes
in sits in your M-Pesa Business account, and you move it to your own number
whenever you like, from the app or by USSD.

### Step 1, get a Till
- Safaricom dealer, or `*234#`, or the M-Pesa Business app.
- You need your ID and your business registration.
- You come away with a **Till number** and a **Head Office number (the store
  number)**. Keep both.

### Step 2, get the keys
- Go to <https://developer.safaricom.co.ke> and create an account.
- Create an app. It gives you a **Consumer Key** and a **Consumer Secret**.
- Apply to **Go Live** with your Till. Safaricom then gives you the
  **Passkey** for your shortcode.

### Step 3, put them in the shop
Admin, Settings, M-Pesa:

| Field | What goes in it |
|---|---|
| Type | Buy Goods (Till) |
| Shortcode | your Head Office / store number |
| Till | your Till number |
| Consumer key, Consumer secret, Passkey | from Daraja |
| Environment | Production |
| Callback URL | `https://tessorabeauty.co.ke/api/mpesa/callback` |

Then turn **M-Pesa** on and save.

### What happens from then on
1. The customer taps **Place order**. The payment screen opens: the amount, the
   number being charged, a bar that drains, and **Pending approval**.
2. They enter their M-Pesa PIN.
3. Safaricom calls the shop back. The shop **asks Safaricom to confirm it** and
   checks the amount is the full total before believing a word of it.
4. The screen turns to **Success** with the M-Pesa receipt number.
5. The receipt is emailed to the customer, the order is marked paid, the stock
   is already reduced, and the sale lands in your books and reports.

Paste the callback URL into Daraja exactly as written above. Everything else is
already wired.

---

## 2. Appear when someone searches

**Where it stands:** until today the shop was one page, so Google had one thing
to look at and no product to show. Now:

- every product has its own address, `tessorabeauty.co.ke/p/<product-name>`
- every category has one, `tessorabeauty.co.ke/shop/<category>`
- each product page carries its picture, price, stock and description in the
  form Google reads, so it can appear with a price and an "in stock" label
- `tessorabeauty.co.ke/sitemap.xml` lists all of them and updates itself the
  moment you add a product

**Why you did not find the shop yet:** the domain is new. No search engine had
been told it exists. Nothing makes that instant.

### Already done for you
- **All 94 addresses submitted to IndexNow**, which is how you tell a search
  engine about a page without an account. Bing, Yandex, Seznam and Naver take
  part, and Ecosia and DuckDuckGo sit downstream of Bing. It was accepted.
  Re-run it after adding products with `node scripts/submit-indexnow.mjs`.
- **The old netlify.app address now redirects here.** Two addresses serving one
  shop splits it in search; now there is one.
- `www.` and plain `http://` already redirect to the real address, and every
  page names itself as the original, so nothing competes with itself.

### Only you can do this: Google
Google does not accept IndexNow. It only takes submissions through Search
Console, which needs your own Google sign-in. It is five minutes.

1. Go to <https://search.google.com/search-console> and sign in.
2. Add a property, choose **URL prefix**, enter `https://tessorabeauty.co.ke`.
3. Choose the **HTML tag** method. It shows you a line like
   `<meta name="google-site-verification" content="...">`.
   **Send me that line** and I will put it in the site and deploy it, then you
   press Verify.
4. Once verified, open **Sitemaps** and submit `sitemap.xml`.
5. Open **URL inspection**, paste `https://tessorabeauty.co.ke/`, and press
   **Request indexing**. Do the same for two or three product pages.

Worth doing the same at <https://www.bing.com/webmasters> even though IndexNow
already reaches Bing: the account shows you what Bing thinks of the shop.

### What to expect
- Your own name, "Tessora Beauty": usually a few days to two weeks.
- Product searches: longer, and they compete with everyone else selling the
  same thing. Product pages are what make it possible at all.

### What moves it fastest, and only you can do
- Put the link `https://tessorabeauty.co.ke` in your Instagram and TikTok bios.
- Create a **Google Business Profile** for the shop. For a Kenyan shop this is
  usually worth more than everything else on this page put together.
- Share product links directly: every product has its own now, so a post can
  point at the product instead of the front page.

---

## 3. Customer care and orders email, free

The shop already writes the customer their confirmation and their receipt. It
sends from an **orders** address, and replies go to a **customer care** address.
Those two addresses need somewhere to live.

**The sending side is already free.** The shop sends through Resend, whose free
tier is 3,000 emails a month. At a hundred orders a month you would use a few
hundred. You never need to pay for that.

**The receiving side** is the only open question, and there are two free ways.
Check cPanel first: if your HostPinnacle plan includes hosting, **Email
Accounts** is already there and free, and you can skip straight to
"So the email is not treated as spam". If you only bought the domain, it is not,
so pick one of these.

### Free option A, Zoho Mail. Real mailboxes.
The better one. You get proper inboxes you sign into, send and receive from,
on your phone or the web.

- Free forever, 1 domain, up to 5 users, 5GB each. No card.
- The catch: webmail and the Zoho app only. No IMAP or POP, so you cannot pull
  it into Gmail or Outlook. In practice you use the Zoho app, which is fine.

1. Sign up at <https://www.zoho.com/mail/> and choose the **Forever Free** plan.
2. Add `tessorabeauty.co.ke` and verify it with the TXT record it gives you.
3. Create `care@tessorabeauty.co.ke` and `orders@tessorabeauty.co.ke`.
4. Add the **MX records** Zoho gives you, in HostPinnacle cPanel, **Zone
   Editor**. MX is what makes mail arrive.

### Free option B, ImprovMX. Forwarding only.
Quicker, but it only receives. Mail to `care@` lands in your Gmail.

- Free, 1 domain, 25 addresses, 500 forwards a day.
- Set up at <https://improvmx.com>: add the domain, then add the two **MX
  records** it gives you in cPanel, **Zone Editor**.
- Forward both `care@` and `orders@` to your Gmail.
- To **reply as** `care@` from Gmail: Gmail, Settings, Accounts, **Add another
  email address**, then use Resend's SMTP, `smtp.resend.com`, port 587,
  username `resend`, password your Resend API key.

### So the email is not treated as spam
Whichever you chose, Resend still has to be allowed to send as your domain.
This part is free and is the difference between landing in the inbox and
landing in spam.

1. In Resend, **Domains**, add `tessorabeauty.co.ke`.
2. It shows you records to add. In HostPinnacle cPanel, **Zone Editor**, add
   them exactly as given:
   - a **TXT** record for SPF
   - a **TXT** record for DKIM
   - a **TXT** record for DMARC
3. Back in Resend, press verify. It can take up to an hour.

**One thing to watch.** A domain may have only **one** SPF record. If Zoho or
ImprovMX already added one, do not add a second: merge them into one line.
Two SPF records is the single most common reason business email goes to spam.
If you are unsure, send me both lines and I will write the merged one for you.

### Then in the shop
Admin, Settings, Reports:

| Field | Value |
|---|---|
| Resend API key | the key from Resend |
| Customer care email | `care@tessorabeauty.co.ke` |
| Orders email | `orders@tessorabeauty.co.ke` |
| Shop address | `https://tessorabeauty.co.ke` |
| Email the customer their confirmation and receipt | on |

Save, then press **Send me a test email**.

Until the Resend key is in, nothing is lost: every order is still recorded in
**Activity**, and the shop tells you there when an email could not be sent.

---

## Still worth doing

- **Change the admin password.** Admin, Settings, Password. The current one has
  been discussed in chat, so treat it as known.
- **Google sign-in** for customers needs a client ID from the Google Cloud
  console, pasted into Admin, Settings. Customers can create accounts with an
  email and password in the meantime.
