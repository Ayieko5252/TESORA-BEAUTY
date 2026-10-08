// Tessora Beauty, email delivery for order alerts and the store report.
//
// The shop never depends on email working: everything sent here is already
// written to the activity log first, so a missing API key costs you the inbox
// copy, never the record. Configure it in Admin → Settings → Reports.
//
// Zero dependencies: the provider is called over plain HTTPS with fetch.

import { BRAND, money, receiptHtml } from './receipt.js';
import { EVENTS } from './activity.js';

const SERIF = "'Playfair Display', Didot, Georgia, serif";
const SANS = "Jost, 'Century Gothic', 'Segoe UI', system-ui, sans-serif";

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const cfg = (settings, key, envName) => {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return settings?.[key] ?? '';
};

/**
 * The address a customer should reply to when they need a person. Falls back
 * through the shop's own email so a reply always lands somewhere staffed.
 */
export const supportEmail = (settings) =>
  cfg(settings, 'supportEmail', 'SUPPORT_EMAIL') || settings?.email || '';

/**
 * The address order mail is sent from. Resend will only send from a domain you
 * have verified, so until the shop's own domain is verified this stays empty
 * and the shared sender is used.
 */
export const ordersEmail = (settings) =>
  cfg(settings, 'ordersEmail', 'ORDERS_EMAIL') || '';

/** Where reports and alerts go, the reports address, or the shop's own email. */
export const reportRecipient = (settings) =>
  cfg(settings, 'reportEmail', 'REPORT_EMAIL') || settings?.email || '';

/** True when we have both a key and somewhere to send to. */
export function isConfigured(settings) {
  return Boolean(cfg(settings, 'emailApiKey', 'EMAIL_API_KEY') && reportRecipient(settings));
}

/**
 * Send one email. Returns { sent, reason } and never throws, a failure here
 * must not roll back the order or the edit that triggered it.
 */
export async function sendEmail(settings, { to, subject, html, text, replyTo }) {
  const key = cfg(settings, 'emailApiKey', 'EMAIL_API_KEY');
  const recipient = to || reportRecipient(settings);
  if (!key) return { sent: false, reason: 'no-api-key' };
  if (!recipient) return { sent: false, reason: 'no-recipient' };

  const shop = settings && settings.storeName ? settings.storeName : 'Tessora Beauty';
  const orders = ordersEmail(settings);
  // Resend will only send from a domain you have verified, so the shop's own
  // address is used once it is set and the shared sender until then.
  const from = cfg(settings, 'emailFrom', 'EMAIL_FROM')
    || (orders ? `${shop} <${orders}>` : 'Tessora Beauty <onboarding@resend.dev>');
  // A customer who hits reply should reach a person, not the sending robot.
  const reply = replyTo || supportEmail(settings);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [recipient], subject, html, text,
        ...(reply ? { reply_to: reply } : {})
      })
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { sent: false, reason: `provider-${res.status}`, detail: detail.slice(0, 200) };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: 'network', detail: String(err.message || err).slice(0, 200) };
  }
}

/* ------------------------------------------------------------- templates */

const shell = (settings, title, inner) => `
<div style="background:${BRAND.ivory};padding:24px 12px;font-family:${SANS};">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid ${BRAND.line};border-radius:16px;overflow:hidden;">
    <div style="background:${BRAND.ink};padding:24px 30px;">
      <div style="font-family:${SERIF};font-size:22px;letter-spacing:.18em;color:#fff;">
        ${esc(settings.storeName || 'TESSORA').toUpperCase()}
      </div>
      <div style="font-family:${SANS};font-size:12px;color:${BRAND.goldLight};letter-spacing:.1em;margin-top:2px;">
        ${esc(title)}
      </div>
    </div>
    ${inner}
  </div>
</div>`;

const statBox = (label, value, accent = BRAND.ink) => `
  <td style="padding:6px;" width="25%">
    <div style="background:${BRAND.blushSoft};border-radius:12px;padding:14px 10px;text-align:center;">
      <div style="font-family:${SERIF};font-size:22px;color:${accent};">${esc(value)}</div>
      <div style="font-family:${SANS};font-size:10px;letter-spacing:.12em;color:${BRAND.muted};margin-top:2px;">
        ${esc(String(label).toUpperCase())}
      </div>
    </div>
  </td>`;

/** The periodic store report, what sold, what changed, what needs restocking. */
export function reportHtml(report, settings = {}) {
  const currency = settings.currency || 'KSh';
  const periodLabel = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' }[report.period] || report.period;

  const top = report.topProducts.length
    ? report.topProducts.map((p) => `
        <tr>
          <td style="padding:7px 0;border-bottom:1px solid ${BRAND.line};font-size:13px;color:${BRAND.ink};">${esc(p.name)}</td>
          <td style="padding:7px 0;border-bottom:1px solid ${BRAND.line};font-size:13px;text-align:right;color:${BRAND.muted};">${p.qty} sold</td>
          <td style="padding:7px 0;border-bottom:1px solid ${BRAND.line};font-size:13px;text-align:right;white-space:nowrap;">${money(p.value, currency)}</td>
        </tr>`).join('')
    : `<tr><td style="padding:10px 0;font-size:13px;color:${BRAND.muted};">Nothing sold in this period.</td></tr>`;

  const alerts = [
    ...report.stock.outOfStock.map((p) => ({ name: p.name, note: 'Out of stock', colour: BRAND.bad })),
    ...report.stock.lowStock.map((p) => ({ name: p.name, note: `Only ${p.stock} left`, colour: BRAND.gold }))
  ].slice(0, 15);

  const alertRows = alerts.length
    ? alerts.map((a) => `
        <tr>
          <td style="padding:6px 0;font-size:13px;color:${BRAND.ink};">${esc(a.name)}</td>
          <td style="padding:6px 0;font-size:12px;text-align:right;color:${a.colour};font-weight:600;">${esc(a.note)}</td>
        </tr>`).join('')
    : `<tr><td style="padding:8px 0;font-size:13px;color:${BRAND.ok};">Every product is in stock.</td></tr>`;

  const changeRows = report.changes.entries.length
    ? report.changes.entries.slice(0, 40).map((a) => `
        <tr>
          <td style="padding:6px 0;border-bottom:1px solid ${BRAND.line};font-size:12px;color:${BRAND.muted};white-space:nowrap;vertical-align:top;">
            ${new Date(a.at).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}
          </td>
          <td style="padding:6px 10px;border-bottom:1px solid ${BRAND.line};font-size:12px;color:${BRAND.rose};white-space:nowrap;vertical-align:top;">
            ${esc(a.label)}
          </td>
          <td style="padding:6px 0;border-bottom:1px solid ${BRAND.line};font-size:12px;color:${BRAND.ink};">
            ${esc(a.target ? `${a.target}, ` : '')}${esc(a.summary)}
          </td>
        </tr>`).join('')
    : `<tr><td style="padding:8px 0;font-size:13px;color:${BRAND.muted};">No changes were made in this period.</td></tr>`;

  const inner = `
    <div style="padding:24px 30px;">
      <div style="font-family:${SERIF};font-size:20px;color:${BRAND.ink};">${esc(periodLabel)}</div>
      <div style="font-size:12px;color:${BRAND.muted};margin-bottom:14px;">
        Generated ${new Date(report.generatedAt).toLocaleString('en-KE')}
      </div>

      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 -6px 18px;">
        <tr>
          ${statBox('Orders', report.orders.total)}
          ${statBox('Revenue', money(report.orders.revenue, currency), BRAND.ok)}
          ${statBox('Confirmed', report.orders.confirmed, BRAND.rose)}
          ${statBox('Cancelled', report.orders.cancelled, report.orders.cancelled ? BRAND.bad : BRAND.ink)}
        </tr>
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:18px;">
        <tr>
          <td style="font-size:13px;color:${BRAND.muted};padding:4px 0;">Pending</td>
          <td style="font-size:13px;text-align:right;">${report.orders.pending}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:${BRAND.muted};padding:4px 0;">Delivered</td>
          <td style="font-size:13px;text-align:right;">${report.orders.delivered}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:${BRAND.muted};padding:4px 0;">Paid online (M-Pesa)</td>
          <td style="font-size:13px;text-align:right;">${report.orders.paidOnline} · ${money(report.orders.paidOnlineValue, currency)}</td>
        </tr>
        <tr>
          <td style="font-size:13px;color:${BRAND.muted};padding:4px 0;">New customers</td>
          <td style="font-size:13px;text-align:right;">${report.customers.newInPeriod} of ${report.customers.total}</td>
        </tr>
      </table>

      <div style="font-family:${SANS};font-size:11px;letter-spacing:.14em;color:${BRAND.muted};margin:22px 0 6px;">BEST SELLERS</div>
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">${top}</table>

      <div style="font-family:${SANS};font-size:11px;letter-spacing:.14em;color:${BRAND.muted};margin:22px 0 6px;">STOCK ALERTS</div>
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">${alertRows}</table>

      <div style="font-family:${SANS};font-size:11px;letter-spacing:.14em;color:${BRAND.muted};margin:22px 0 6px;">
        EVERYTHING THAT CHANGED (${report.changes.total})
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">${changeRows}</table>
    </div>

    <div style="background:${BRAND.ink};padding:18px 30px;text-align:center;">
      <div style="font-family:${SANS};font-size:11px;color:${BRAND.goldLight};letter-spacing:.06em;">
        ${esc(settings.storeName || 'Tessora Beauty')} · store report
      </div>
    </div>`;

  return shell(settings, `STORE REPORT · ${String(periodLabel).toUpperCase()}`, inner);
}

/** A single admin action, emailed as it happens (when instant alerts are on). */
export function activityHtml(entry, settings = {}) {
  const changeList = (entry.changes || []).length
    ? `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:10px;">
        ${entry.changes.map((c) => `
          <tr>
            <td style="padding:5px 0;font-size:13px;color:${BRAND.muted};">${esc(c.label)}</td>
            <td style="padding:5px 0;font-size:13px;text-align:right;color:${BRAND.ink};">
              <span style="color:${BRAND.muted};text-decoration:line-through;">${esc(c.from ?? ' ')}</span>
              &nbsp;→&nbsp;<strong>${esc(c.to ?? ' ')}</strong>
            </td>
          </tr>`).join('')}
       </table>`
    : '';

  const inner = `
    <div style="padding:24px 30px;">
      <div style="display:inline-block;background:${BRAND.blushSoft};color:${BRAND.rose};font-size:11px;
                  letter-spacing:.12em;padding:5px 12px;border-radius:999px;">
        ${esc(String(EVENTS[entry.type]?.label || entry.label).toUpperCase())}
      </div>
      <div style="font-family:${SERIF};font-size:20px;color:${BRAND.ink};margin-top:12px;">
        ${esc(entry.target || entry.summary)}
      </div>
      ${entry.target ? `<div style="font-size:13px;color:${BRAND.muted};">${esc(entry.summary)}</div>` : ''}
      ${changeList}
      <div style="font-size:12px;color:${BRAND.muted};margin-top:16px;">
        ${new Date(entry.at).toLocaleString('en-KE')} · by ${esc(entry.actor)}
      </div>
    </div>`;

  return shell(settings, 'STORE ACTIVITY', inner);
}

/** An order alert, with the full receipt embedded so it is all in one place. */
export function orderHtml(order, settings = {}, headline = 'NEW ORDER') {
  const inner = `
    <div style="padding:20px 30px 4px;">
      <div style="font-family:${SANS};font-size:13px;color:${BRAND.muted};">
        ${esc(headline === 'NEW ORDER' ? 'A customer just placed an order.' : `Order ${order.code} is now ${order.status}.`)}
      </div>
    </div>
    <div style="padding:10px 16px 24px;">
      ${receiptHtml(order, settings, { embedded: true })}
    </div>`;
  return shell(settings, headline, inner);
}

/* ------------------------------------------- what the customer receives */

/** The shop's public address, used for receipt links inside emails. */
const siteUrl = (settings) =>
  String(cfg(settings, 'siteUrl', 'SITE_URL') || 'https://tessorabeauty.co.ke').replace(/\/+$/, '');

/** A customer's own receipt link. The token is what makes it theirs. */
export const receiptLink = (order, settings) =>
  `${siteUrl(settings)}/receipt?order=${encodeURIComponent(order.id)}&token=${encodeURIComponent(order.payToken || '')}`;

const firstName = (order) => String((order && order.customer && order.customer.name) || '').trim().split(/\s+/)[0] || 'there';

const waLink = (settings, order) => {
  const num = String((settings && settings.whatsapp) || '').replace(/\D/g, '');
  if (!num) return '';
  return `https://wa.me/${num}?text=${encodeURIComponent(`Hi, about my order ${order.code}`)}`;
};

const bigButton = (href, label, bg = BRAND.ink, fg = '#fff') => `
  <table cellpadding="0" cellspacing="0" role="presentation" style="margin:18px auto 4px;">
    <tr><td style="border-radius:999px;background:${bg};">
      <a href="${esc(href)}" style="display:inline-block;padding:13px 30px;font-family:${SANS};
         font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:${fg};text-decoration:none;">
        ${esc(label)}
      </a>
    </td></tr>
  </table>`;

/**
 * The footer every customer email carries: who to talk to, and how. A reply to
 * any of these lands in the customer care inbox, because sendEmail sets
 * reply-to; the address is printed as well for anyone who prefers to start a
 * fresh message.
 */
const customerFoot = (settings, order) => {
  const care = supportEmail(settings);
  const wa = waLink(settings, order);
  return `
    <div style="padding:22px 30px;border-top:1px solid ${BRAND.line};text-align:center;">
      <div style="font-family:${SANS};font-size:13px;color:${BRAND.muted};line-height:1.6;">
        Any question about this order, just reply to this email${care ? ` or write to <a href="mailto:${esc(care)}" style="color:${BRAND.rose};text-decoration:none;">${esc(care)}</a>` : ''}.
      </div>
      ${wa ? `<div style="font-family:${SANS};font-size:13px;margin-top:6px;">
        <a href="${esc(wa)}" style="color:${BRAND.ok};text-decoration:none;">Or message us on WhatsApp</a>
      </div>` : ''}
    </div>
    <div style="background:${BRAND.ink};padding:18px 30px;text-align:center;">
      <div style="font-family:${SERIF};font-size:15px;letter-spacing:.2em;color:#fff;">
        ${esc(String(settings.storeName || 'TESSORA').toUpperCase())}
      </div>
      <div style="font-family:${SANS};font-size:11px;color:${BRAND.goldLight};letter-spacing:.08em;margin-top:4px;">
        ${esc(settings.tagline || 'Your Beauty. Your Aura.')}
      </div>
    </div>`;
};

/** The headline block at the top of a customer email. */
const customerHead = (settings, order, { eyebrow, title, line }) => `
  <div style="padding:26px 30px 6px;text-align:center;">
    <div style="display:inline-block;background:${BRAND.blushSoft};color:${BRAND.rose};font-family:${SANS};
                font-size:10px;letter-spacing:.16em;padding:6px 14px;border-radius:999px;">
      ${esc(String(eyebrow).toUpperCase())}
    </div>
    <div style="font-family:${SERIF};font-size:26px;color:${BRAND.ink};margin:14px 0 6px;">${title}</div>
    <div style="font-family:${SANS};font-size:14px;color:${BRAND.muted};line-height:1.6;">${line}</div>
    <div style="font-family:${SANS};font-size:12px;letter-spacing:.12em;color:${BRAND.muted};margin-top:14px;">
      ORDER ${esc(order.code)}
    </div>
  </div>`;

/** Order placed, payment not yet made. Sent the moment the order is saved. */
export function customerOrderHtml(order, settings = {}) {
  const currency = settings.currency || 'KSh';
  const eta = order.delivery && order.delivery.label ? order.delivery.label : '';
  const inner = `
    ${customerHead(settings, order, {
      eyebrow: 'Order received',
      title: `Thank you, ${esc(firstName(order))}`,
      line: `We have your order and your items are set aside. The M-Pesa prompt goes to
             <b style="color:${BRAND.ink}">${esc(order.customer.phone || 'your phone')}</b>:
             enter your PIN there and your order is on its way.`
    })}
    <div style="padding:4px 30px;">
      <div style="background:${BRAND.blushSoft};border-radius:14px;padding:16px 18px;text-align:center;">
        <div style="font-family:${SANS};font-size:11px;letter-spacing:.14em;color:${BRAND.muted};">TO PAY</div>
        <div style="font-family:${SERIF};font-size:30px;color:${BRAND.ink};margin-top:2px;">
          ${money(order.total, currency)}
        </div>
        ${eta ? `<div style="font-family:${SANS};font-size:12px;color:${BRAND.muted};margin-top:6px;">
          Arriving in ${esc(eta)} once paid</div>` : ''}
      </div>
      ${bigButton(receiptLink(order, settings), 'View your receipt', BRAND.ink)}
      <div style="font-family:${SANS};font-size:12px;color:${BRAND.muted};text-align:center;margin-top:4px;">
        Did the prompt not arrive? Message us and we will send it again.
      </div>
    </div>
    <div style="padding:16px 16px 20px;">
      ${receiptHtml(order, settings, { embedded: true })}
    </div>
    ${customerFoot(settings, order)}`;
  return shell(settings, 'ORDER RECEIVED', inner);
}

/** Payment confirmed by Safaricom. This is the receipt going back. */
export function customerPaidHtml(order, settings = {}) {
  const receiptNo = order.payment && order.payment.receipt ? order.payment.receipt : '';
  const eta = order.delivery && order.delivery.label ? order.delivery.label : '';
  const inner = `
    ${customerHead(settings, order, {
      eyebrow: 'Payment received',
      title: `You are all set, ${esc(firstName(order))}`,
      line: `Your payment came through and your order is confirmed.
             ${eta ? `We are packing it now and it should reach you in <b style="color:${BRAND.ink}">${esc(eta)}</b>.` : 'We are packing it now.'}`
    })}
    <div style="padding:4px 30px;">
      <div style="background:#eef7f1;border:1px solid #cde6d9;border-radius:14px;padding:16px 18px;text-align:center;">
        <div style="font-family:${SERIF};font-size:26px;color:${BRAND.ok};">
          ${money(order.total, settings.currency || 'KSh')} paid
        </div>
        ${receiptNo ? `<div style="font-family:${SANS};font-size:12px;letter-spacing:.1em;color:${BRAND.muted};margin-top:4px;">
          M-PESA ${esc(receiptNo)}</div>` : ''}
      </div>
      ${bigButton(receiptLink(order, settings), 'Download your receipt', BRAND.ink)}
    </div>
    <div style="padding:16px 16px 20px;">
      ${receiptHtml(order, settings, { embedded: true })}
    </div>
    ${customerFoot(settings, order)}`;
  return shell(settings, 'PAYMENT RECEIVED', inner);
}

/** The prompt was declined, timed out, or the balance was short. */
export function customerFailedHtml(order, settings = {}) {
  const why = order.payment && order.payment.failReason ? order.payment.failReason : '';
  const inner = `
    ${customerHead(settings, order, {
      eyebrow: 'Payment not completed',
      title: 'Your order is still waiting',
      line: `The M-Pesa payment did not go through${why ? `: <b style="color:${BRAND.ink}">${esc(why)}</b>` : ''}.
             Nothing has been charged, and we are holding your items for you.`
    })}
    <div style="padding:4px 30px;">
      <div style="background:${BRAND.blushSoft};border-radius:14px;padding:16px 18px;">
        <div style="font-family:${SANS};font-size:13px;color:${BRAND.ink};line-height:1.7;">
          To finish it, open the shop, go to your account and place the order again,
          or message us and we will send you a fresh prompt.
        </div>
      </div>
      ${bigButton(siteUrl(settings), 'Back to the shop', BRAND.ink)}
    </div>
    ${customerFoot(settings, order)}`;
  return shell(settings, 'PAYMENT NOT COMPLETED', inner);
}

/** Confirmed, on the way, delivered: the shop owner moved the order on. */
export function customerStatusHtml(order, settings = {}, status = '') {
  const s = String(status || order.status || '').toLowerCase();
  const copy = {
    confirmed: ['Order confirmed', 'We have confirmed your order and it is being prepared.'],
    packed: ['Your order is packed', 'Everything is boxed and ready to leave us.'],
    shipped: ['Your order is on the way', 'It has left us and is heading to you.'],
    delivered: ['Delivered', 'Your order has been delivered. We hope you love it.'],
    cancelled: ['Order cancelled', 'This order has been cancelled. Nothing further will be charged.']
  }[s] || ['Order update', `Your order is now ${esc(s)}.`];

  const inner = `
    ${customerHead(settings, order, { eyebrow: 'Order update', title: esc(copy[0]), line: copy[1] })}
    <div style="padding:4px 30px;">
      ${bigButton(receiptLink(order, settings), 'View your receipt', BRAND.ink)}
    </div>
    ${customerFoot(settings, order)}`;
  return shell(settings, 'ORDER UPDATE', inner);
}

/**
 * The plain-text copy. Some mail apps, and anyone reading with a screen
 * reader that prefers text, see this instead of the HTML.
 */
export function customerText(order, settings = {}, kind = 'placed') {
  const currency = settings.currency || 'KSh';
  const care = supportEmail(settings);
  const lines = [];
  if (kind === 'paid') {
    lines.push(`You are all set, ${firstName(order)}.`, '',
      `Order ${order.code} is paid: ${money(order.total, currency)}.`);
    if (order.payment && order.payment.receipt) lines.push(`M-Pesa receipt: ${order.payment.receipt}`);
  } else if (kind === 'failed') {
    lines.push('Your order is still waiting.', '',
      `The M-Pesa payment for order ${order.code} did not go through. Nothing was charged.`);
  } else if (kind === 'status') {
    lines.push(`Order ${order.code} is now ${order.status}.`);
  } else {
    lines.push(`Thank you, ${firstName(order)}.`, '',
      `We have your order ${order.code}. Amount to pay: ${money(order.total, currency)}.`,
      'Enter your M-Pesa PIN on the prompt sent to your phone.');
  }
  if (order.delivery && order.delivery.label) lines.push(`Delivery: ${order.delivery.label}.`);
  lines.push('', `Your receipt: ${receiptLink(order, settings)}`);
  if (care) lines.push('', `Questions? Reply to this email, or write to ${care}.`);
  lines.push('', settings.storeName || 'Tessora Beauty');
  return lines.join('\n');
}

/* ------------------------------------------------- forgotten passwords */

/** The shop's address, for links inside a reset email. */
export const shopUrl = (settings) => siteUrl(settings);

/**
 * The reset email.
 *
 * No password in it, and nothing that identifies the account beyond a first
 * name, because an email sits in an inbox for years. The link is the only
 * secret, it works once, and it expires.
 */
export function resetHtml(settings = {}, { name, link, minutes, admin } = {}) {
  const who = String(name || '').trim().split(/\s+/)[0] || 'there';
  const inner = `
    <div style="padding:26px 30px 6px;text-align:center;">
      <div style="display:inline-block;background:${BRAND.blushSoft};color:${BRAND.rose};font-family:${SANS};
                  font-size:10px;letter-spacing:.16em;padding:6px 14px;border-radius:999px;">
        PASSWORD RESET
      </div>
      <div style="font-family:${SERIF};font-size:26px;color:${BRAND.ink};margin:14px 0 6px;">
        Hello ${esc(who)}
      </div>
      <div style="font-family:${SANS};font-size:14px;color:${BRAND.muted};line-height:1.6;">
        Someone asked to reset the password for
        ${admin ? 'the shop admin panel' : `your ${esc(settings.storeName || 'Tessora Beauty')} account`}.
        If that was you, use the button below. It works once, and only for the
        next ${esc(String(minutes))} minutes.
      </div>
    </div>
    <div style="padding:4px 30px 10px;">
      ${bigButton(link, 'Choose a new password', BRAND.ink)}
      <div style="font-family:${SANS};font-size:12px;color:${BRAND.muted};text-align:center;margin-top:10px;line-height:1.6;">
        If you did not ask for this, you can ignore this email.
        Nothing has changed and your password still works.
      </div>
    </div>
    <div style="padding:16px 30px 24px;">
      <div style="background:${BRAND.ivory};border-radius:10px;padding:12px 14px;
                  font-family:${SANS};font-size:11px;color:${BRAND.muted};word-break:break-all;">
        If the button does not work, paste this into your browser:<br>
        <span style="color:${BRAND.ink};">${esc(link)}</span>
      </div>
    </div>
    <div style="background:${BRAND.ink};padding:18px 30px;text-align:center;">
      <div style="font-family:${SERIF};font-size:15px;letter-spacing:.2em;color:#fff;">
        ${esc(String(settings.storeName || 'TESSORA').toUpperCase())}
      </div>
    </div>`;
  return shell(settings, 'PASSWORD RESET', inner);
}

/** The plain-text copy of the same thing. */
export function resetText(settings = {}, { link, minutes } = {}) {
  return [
    'Someone asked to reset your password.',
    '',
    `Open this link to choose a new one. It works once, and only for the next ${minutes} minutes:`,
    link,
    '',
    'If you did not ask for this, ignore this email. Nothing has changed.',
    '',
    settings.storeName || 'Tessora Beauty'
  ].join('\n');
}
