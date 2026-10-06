// Tessora Beauty, the order receipt.
//
// One template, used in three places: the receipt page the customer opens after
// checkout, the copy that can be emailed, and the printable version. Styles are
// inline because email clients throw away <style> blocks.

/** The shop's colours, kept here so the receipt matches the storefront. */
export const BRAND = {
  ivory: '#fbf7f2',
  blush: '#f7c9d3',
  blushSoft: '#fdeef1',
  blushDeep: '#e39fae',
  rose: '#b8536c',
  ink: '#12100f',
  inkSoft: '#2a2523',
  gold: '#c9a227',
  goldLight: '#e8cd7a',
  muted: '#7b716c',
  line: '#ece3dc',
  white: '#ffffff',
  ok: '#2f7d5b',
  bad: '#b3392f'
};

const SERIF = "'Playfair Display', Didot, Georgia, 'Times New Roman', serif";
const SANS = "Jost, 'Century Gothic', 'Segoe UI', system-ui, -apple-system, sans-serif";

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** KSh 1,234, whole shillings, which is how the shop prices everything. */
export const money = (n, currency = 'KSh') =>
  `${currency} ${Math.round(Number(n) || 0).toLocaleString('en-KE')}`;

const date = (iso) => {
  const d = new Date(iso || Date.now());
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
};

const dateTime = (iso) => {
  const d = new Date(iso || Date.now());
  return `${date(iso)} at ${d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}`;
};

/** How the delivery charge was arrived at, in words the customer can check. */
export function deliveryExplanation(order, currency = 'KSh') {
  const d = order.delivery || {};
  if (d.basis === 'free') return 'Free delivery, your order qualified';
  if (d.basis === 'distance' && d.distanceKm !== null && d.distanceKm !== undefined) {
    const base = d.baseFee ? `${money(d.baseFee, currency)} base + ` : '';
    return `${base}${d.distanceKm} km × ${money(d.perKm, currency)}/km`;
  }
  return 'Standard delivery charge';
}

// The shop is paid up front by M-Pesa, there is no cash-on-delivery option,
// so an unpaid order is always simply awaiting its payment.
const statusChip = (order) => {
  const status = order.payment?.status;
  const paid = status === 'paid';
  const bg = paid ? BRAND.ok : (status === 'failed' ? BRAND.bad : BRAND.gold);
  const text = paid
    ? `PAID${order.payment?.receipt ? ` · ${esc(order.payment.receipt)}` : ''}`
    : (status === 'failed' ? 'PAYMENT FAILED' : 'AWAITING M-PESA PAYMENT');
  return `<span style="display:inline-block;background:${bg};color:#fff;font-family:${SANS};
    font-size:11px;letter-spacing:.14em;padding:6px 12px;border-radius:999px;">${text}</span>`;
};

/**
 * The full receipt as a standalone HTML document.
 * `opts.embedded` returns just the card (for dropping inside an email body).
 */
export function receiptHtml(order, settings = {}, opts = {}) {
  const currency = settings.currency || 'KSh';
  const d = order.delivery || {};
  const items = order.items || [];

  const savings = items.reduce((n, i) => n + Math.max(0, (i.wasPrice || 0) - i.price) * i.qty, 0);

  const rows = items.map((i) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid ${BRAND.line};font-family:${SANS};font-size:14px;color:${BRAND.ink};">
        ${esc(i.name)}
        ${i.wasPrice && i.wasPrice > i.price
          ? `<div style="font-size:12px;color:${BRAND.rose};">was ${money(i.wasPrice, currency)} each</div>`
          : ''}
        <div style="font-size:12px;color:${BRAND.muted};">${money(i.price, currency)} × ${i.qty}</div>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid ${BRAND.line};text-align:right;
                 font-family:${SANS};font-size:14px;white-space:nowrap;color:${BRAND.ink};">
        ${money(i.price * i.qty, currency)}
      </td>
    </tr>`).join('');

  const line = (label, value, note = '', strong = false) => `
    <tr>
      <td style="padding:${strong ? '14px 0 0' : '7px 0'};font-family:${SANS};
                 font-size:${strong ? '17px' : '14px'};color:${strong ? BRAND.ink : BRAND.muted};
                 ${strong ? 'font-weight:600;' : ''}">
        ${esc(label)}${note ? `<div style="font-size:12px;color:${BRAND.muted};font-weight:400;">${esc(note)}</div>` : ''}
      </td>
      <td style="padding:${strong ? '14px 0 0' : '7px 0'};text-align:right;font-family:${SANS};
                 font-size:${strong ? '17px' : '14px'};white-space:nowrap;
                 color:${strong ? BRAND.ink : BRAND.inkSoft};${strong ? 'font-weight:600;' : ''}">
        ${esc(value)}
      </td>
    </tr>`;

  const card = `
<div style="max-width:640px;margin:0 auto;background:${BRAND.white};border:1px solid ${BRAND.line};
            border-radius:16px;overflow:hidden;">

  <!-- header -->
  <div style="background:${BRAND.ink};padding:28px 32px;text-align:center;">
    <div style="font-family:${SERIF};font-size:26px;letter-spacing:.18em;color:${BRAND.white};">
      ${esc(settings.storeName || 'TESSORA').toUpperCase()}
    </div>
    <div style="font-family:${SANS};font-size:12px;letter-spacing:.1em;color:${BRAND.goldLight};margin-top:4px;">
      ${esc(settings.tagline || 'Your Beauty. Your Aura.')}
    </div>
    <div style="height:3px;width:70px;margin:16px auto 0;
                background:linear-gradient(90deg,${BRAND.gold},${BRAND.goldLight},${BRAND.gold});"></div>
  </div>

  <!-- order meta -->
  <div style="background:${BRAND.blushSoft};padding:20px 32px;border-bottom:1px solid ${BRAND.line};">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
      <tr>
        <td style="font-family:${SANS};">
          <div style="font-size:11px;letter-spacing:.14em;color:${BRAND.muted};">RECEIPT</div>
          <div style="font-family:${SERIF};font-size:22px;color:${BRAND.ink};">${esc(order.code)}</div>
          <div style="font-size:12px;color:${BRAND.muted};">${dateTime(order.createdAt)}</div>
        </td>
        <td style="text-align:right;vertical-align:top;">${statusChip(order)}</td>
      </tr>
    </table>
  </div>

  <!-- items -->
  <div style="padding:24px 32px;">
    <div style="font-family:${SANS};font-size:11px;letter-spacing:.14em;color:${BRAND.muted};margin-bottom:8px;">
      YOUR ITEMS
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">${rows}</table>

    <!-- cost breakdown -->
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:14px;">
      ${line('Subtotal', money(order.subtotal, currency))}
      ${savings > 0 ? line('You saved', `− ${money(savings, currency)}`) : ''}
      ${line(
        'Delivery',
        order.deliveryFee === 0 ? 'FREE' : money(order.deliveryFee, currency),
        deliveryExplanation(order, currency)
      )}
      <tr><td colspan="2" style="padding-top:10px;border-top:2px solid ${BRAND.ink};"></td></tr>
      ${line('Total', money(order.total, currency), '', true)}
    </table>
  </div>

  <!-- delivery -->
  <div style="padding:0 32px 24px;">
    <div style="background:${BRAND.ivory};border:1px solid ${BRAND.line};border-radius:12px;padding:18px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
          <td style="font-family:${SANS};font-size:13px;color:${BRAND.inkSoft};vertical-align:top;">
            <div style="font-size:11px;letter-spacing:.14em;color:${BRAND.muted};margin-bottom:6px;">DELIVERING TO</div>
            <div style="font-weight:600;">${esc(order.customer?.name)}</div>
            <div>${esc(order.customer?.phone)}</div>
            <div style="color:${BRAND.muted};">${esc(order.customer?.location || ' ')}</div>
            ${order.customer?.notes ? `<div style="margin-top:6px;color:${BRAND.muted};font-style:italic;">“${esc(order.customer.notes)}”</div>` : ''}
          </td>
          <td style="font-family:${SANS};font-size:13px;text-align:right;vertical-align:top;white-space:nowrap;">
            <div style="font-size:11px;letter-spacing:.14em;color:${BRAND.muted};margin-bottom:6px;">ARRIVES</div>
            <div style="font-family:${SERIF};font-size:18px;color:${BRAND.rose};">${esc(d.label || '1 to 2 days')}</div>
            ${d.expectedBy ? `<div style="color:${BRAND.muted};">by ${date(d.expectedBy)}</div>` : ''}
            ${d.distanceKm !== null && d.distanceKm !== undefined
              ? `<div style="color:${BRAND.muted};margin-top:4px;">${d.distanceKm} km away</div>` : ''}
          </td>
        </tr>
      </table>
    </div>
  </div>

  <!-- footer -->
  <div style="background:${BRAND.ink};padding:22px 32px;text-align:center;">
    <div style="font-family:${SANS};font-size:12px;color:${BRAND.goldLight};letter-spacing:.06em;">
      Thank you for shopping with ${esc(settings.storeName || 'Tessora Beauty')}
    </div>
    <div style="font-family:${SANS};font-size:11px;color:#8d8378;margin-top:6px;">
      ${settings.whatsapp ? `WhatsApp ${esc(settings.whatsapp)}` : ''}
      ${settings.instagram ? ` · Instagram @${esc(String(settings.instagram).replace(/^@/, ''))}` : ''}
      ${settings.location ? ` · ${esc(settings.location)}` : ''}
    </div>
  </div>
</div>`;

  if (opts.embedded) return card;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${esc(order.code)} · ${esc(settings.storeName || 'Tessora Beauty')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; background:${BRAND.ivory}; padding:28px 16px; }
  .actions { max-width:640px; margin:0 auto 16px; text-align:right; font-family:${SANS}; }
  .actions button, .actions a {
    font:inherit; font-size:13px; letter-spacing:.1em; cursor:pointer;
    background:${BRAND.ink}; color:#fff; border:0; border-radius:999px;
    padding:10px 22px; text-decoration:none; display:inline-block; margin-left:8px;
  }
  .actions a.ghost { background:transparent; color:${BRAND.ink}; border:1px solid ${BRAND.line}; }
  @media print { .actions { display:none; } body { background:#fff; padding:0; } }
</style>
</head>
<body>
  <div class="actions">
    <a class="ghost" href="/">Back to the shop</a>
    <button onclick="window.print()">Print / Save PDF</button>
  </div>
  ${card}
</body>
</html>`;
}

/** Plain-text fallback, for email clients that refuse HTML. */
export function receiptText(order, settings = {}) {
  const currency = settings.currency || 'KSh';
  const lines = [
    `${settings.storeName || 'Tessora Beauty'}, receipt ${order.code}`,
    dateTime(order.createdAt),
    '',
    ...(order.items || []).map((i) => `  ${i.qty} × ${i.name}, ${money(i.price * i.qty, currency)}`),
    '',
    `  Subtotal: ${money(order.subtotal, currency)}`,
    `  Delivery: ${order.deliveryFee === 0 ? 'FREE' : money(order.deliveryFee, currency)}  (${deliveryExplanation(order, currency)})`,
    `  Total:    ${money(order.total, currency)}`,
    '',
    `Delivering to ${order.customer?.name}, ${order.customer?.location || ' '}`,
    `Arrives: ${order.delivery?.label || '1 to 2 days'}`
  ];
  return lines.join('\n');
}
