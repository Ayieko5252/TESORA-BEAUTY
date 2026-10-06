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
export async function sendEmail(settings, { to, subject, html, text }) {
  const key = cfg(settings, 'emailApiKey', 'EMAIL_API_KEY');
  const recipient = to || reportRecipient(settings);
  if (!key) return { sent: false, reason: 'no-api-key' };
  if (!recipient) return { sent: false, reason: 'no-recipient' };

  const from = cfg(settings, 'emailFrom', 'EMAIL_FROM')
    || 'Tessora Beauty <onboarding@resend.dev>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [recipient], subject, html, text })
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
