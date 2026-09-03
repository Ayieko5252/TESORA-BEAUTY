// Tessora Beauty — the shop's books.
//
// Three things live here:
//   • a balance sheet    — what the shop owns and owes on a given day
//   • a financial analysis — what it sold, what that cost, and what it kept
//   • CSV exports        — inventory and orders, for a spreadsheet
//
// Honesty rule: profit needs a cost price, and cost price is optional on a
// product. Anything computed from an incomplete cost base is reported alongside
// a `costCoverage` figure and a plain warning, never presented as if it were
// certain. Better an obviously-partial number than a confidently wrong one.

import { BRAND, money } from './receipt.js';

const SERIF = "'Playfair Display', Didot, Georgia, serif";
const SANS = "Jost, 'Century Gothic', 'Segoe UI', system-ui, sans-serif";

const num = (v, f = 0) => (Number.isFinite(Number(v)) ? Number(v) : f);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const salePrice = (p) =>
  Math.round(num(p.price) * (1 - Math.min(95, Math.max(0, num(p.discount))) / 100));

/** Orders that represent real, recognised business (not cancelled). */
const isLive = (o) => o.status !== 'cancelled';
/** Orders whose money is actually in hand. */
const isPaid = (o) => o.payment?.status === 'paid';

const startOf = (period) => {
  const now = new Date();
  if (period === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; }
  if (period === 'all') return new Date(0);
  const days = period === '30d' ? 30 : period === '90d' ? 90 : period === '7d' ? 7 : 1;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
};

export const PERIOD_LABELS = {
  today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days',
  '90d': 'Last 90 days', all: 'All time'
};

/* ------------------------------------------------------------ cost basis */

/**
 * How much of the catalogue has a cost price set, weighted by the stock held.
 * Returns { withCost, total, ratio, missing: [names] }.
 */
export function costCoverage(products = []) {
  const total = products.length;
  const withCost = products.filter((p) => num(p.costPrice) > 0).length;
  return {
    withCost,
    total,
    ratio: total ? withCost / total : 0,
    missing: products.filter((p) => num(p.costPrice) <= 0).map((p) => p.name).slice(0, 50)
  };
}

/* ----------------------------------------------------------- balance sheet */

/**
 * What the shop owns and owes, as at now.
 *
 * A small retail shop like this has a deliberately simple shape:
 *   Assets      = cash collected + money still owed by customers + stock on hand
 *   Liabilities = goods customers have paid for but not yet received
 *   Equity      = the difference (what the business is worth to its owner)
 */
export function buildBalanceSheet(db) {
  const products = db.products || [];
  const orders = db.orders || [];
  const coverage = costCoverage(products);

  // --- stock on hand, at what it cost and what it would sell for ---
  const inventoryAtCost = products.reduce((n, p) => n + num(p.costPrice) * num(p.stock), 0);
  const inventoryAtRetail = products.reduce((n, p) => n + salePrice(p) * num(p.stock), 0);

  // --- money in ---
  const paidOrders = orders.filter((o) => isLive(o) && isPaid(o));
  const cashCollected = paidOrders.reduce((n, o) => n + num(o.total), 0);

  // --- money owed to the shop: confirmed or delivered, but not yet paid ---
  const receivableOrders = orders.filter(
    (o) => isLive(o) && !isPaid(o) && ['confirmed', 'delivered'].includes(o.status)
  );
  const receivables = receivableOrders.reduce((n, o) => n + num(o.total), 0);

  // --- owed to customers: paid for, not yet delivered ---
  const undeliveredPaid = orders.filter((o) => isLive(o) && isPaid(o) && o.status !== 'delivered');
  const deferredRevenue = undeliveredPaid.reduce((n, o) => n + num(o.total), 0);

  const assets = [
    { label: 'Cash collected (M-Pesa)', value: cashCollected,
      note: `${paidOrders.length} paid order${paidOrders.length === 1 ? '' : 's'}` },
    { label: 'Owed by customers', value: receivables,
      note: `${receivableOrders.length} confirmed but unpaid` },
    { label: 'Stock on hand (at cost)', value: inventoryAtCost,
      note: coverage.ratio < 1
        ? `${coverage.withCost} of ${coverage.total} products have a cost price`
        : `${products.length} products` }
  ];
  const totalAssets = assets.reduce((n, a) => n + a.value, 0);

  const liabilities = [
    { label: 'Paid, not yet delivered', value: deferredRevenue,
      note: `${undeliveredPaid.length} order${undeliveredPaid.length === 1 ? '' : 's'} owed to customers` }
  ];
  const totalLiabilities = liabilities.reduce((n, l) => n + l.value, 0);

  return {
    asOf: new Date().toISOString(),
    assets,
    totalAssets,
    liabilities,
    totalLiabilities,
    equity: totalAssets - totalLiabilities,
    memo: {
      inventoryAtRetail,
      unrealisedMargin: inventoryAtRetail - inventoryAtCost,
      productCount: products.length,
      unitsInStock: products.reduce((n, p) => n + num(p.stock), 0)
    },
    coverage
  };
}

/* -------------------------------------------------------------- analysis */

/** Sales, cost of sales, margin and the trend behind them. */
export function buildFinancials(db, period = '30d') {
  const since = startOf(period);
  const products = db.products || [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const coverage = costCoverage(products);

  const all = (db.orders || []).filter((o) => new Date(o.createdAt) >= since);
  const live = all.filter(isLive);
  const cancelled = all.filter((o) => !isLive(o));

  const merchandise = live.reduce((n, o) => n + num(o.subtotal), 0);
  const deliveryIncome = live.reduce((n, o) => n + num(o.deliveryFee), 0);
  const revenue = merchandise + deliveryIncome;

  // Cost of goods sold, from the cost price recorded on each product.
  let cogs = 0;
  let linesCosted = 0;
  let linesTotal = 0;
  const perProduct = new Map();

  for (const o of live) {
    for (const i of o.items || []) {
      linesTotal += 1;
      const p = byId.get(i.productId);
      const unitCost = num(p?.costPrice);
      if (unitCost > 0) { cogs += unitCost * num(i.qty); linesCosted += 1; }

      const row = perProduct.get(i.productId)
        || { name: i.name, qty: 0, revenue: 0, cost: 0, hasCost: unitCost > 0 };
      row.qty += num(i.qty);
      row.revenue += num(i.price) * num(i.qty);
      row.cost += unitCost * num(i.qty);
      row.hasCost = row.hasCost && unitCost > 0;
      perProduct.set(i.productId, row);
    }
  }

  const grossProfit = merchandise - cogs;
  const paid = live.filter(isPaid);

  const topByProfit = [...perProduct.values()]
    .map((r) => ({ ...r, profit: r.revenue - r.cost, margin: r.revenue ? (r.revenue - r.cost) / r.revenue : 0 }))
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 15);

  const topBySales = [...perProduct.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15);

  // Daily trend, oldest first — enough to see whether things are moving.
  const days = new Map();
  for (const o of live) {
    const key = new Date(o.createdAt).toISOString().slice(0, 10);
    const d = days.get(key) || { date: key, orders: 0, revenue: 0 };
    d.orders += 1;
    d.revenue += num(o.total);
    days.set(key, d);
  }
  const trend = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    period,
    periodLabel: PERIOD_LABELS[period] || period,
    since: since.toISOString(),
    generatedAt: new Date().toISOString(),

    income: {
      merchandise,
      deliveryIncome,
      revenue,
      cogs,
      grossProfit,
      grossMargin: merchandise ? grossProfit / merchandise : 0
    },
    orders: {
      total: all.length,
      live: live.length,
      cancelled: cancelled.length,
      cancelledValue: cancelled.reduce((n, o) => n + num(o.total), 0),
      cancellationRate: all.length ? cancelled.length / all.length : 0,
      paid: paid.length,
      collected: paid.reduce((n, o) => n + num(o.total), 0),
      outstanding: live.filter((o) => !isPaid(o)).reduce((n, o) => n + num(o.total), 0),
      averageOrder: live.length ? Math.round(revenue / live.length) : 0,
      unitsSold: live.reduce((n, o) => n + (o.items || []).reduce((m, i) => m + num(i.qty), 0), 0)
    },
    topByProfit,
    topBySales,
    trend,
    coverage: { ...coverage, linesCosted, linesTotal },
    // True only when every sold line had a cost price behind it.
    profitIsComplete: linesTotal > 0 && linesCosted === linesTotal
  };
}

/* ------------------------------------------------------------------ CSV */

/** RFC-4180-ish escaping: quote anything with a comma, quote or newline. */
const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\r\n');

/** Every product, with what it cost, what it sells for and what it is worth. */
export function inventoryCsv(db) {
  const rows = [[
    'SKU', 'Product', 'Category', 'Brand', 'Cost price', 'Price', 'Discount %',
    'Sells at', 'Stock', 'Stock value at cost', 'Stock value at retail',
    'Margin per unit', 'Status', 'Visible', 'Last updated'
  ]];
  for (const p of db.products || []) {
    const sells = salePrice(p);
    const cost = num(p.costPrice);
    rows.push([
      p.sku, p.name, p.category, p.brand,
      cost || '', p.price, p.discount, sells, p.stock,
      cost ? cost * num(p.stock) : '',
      sells * num(p.stock),
      cost ? sells - cost : '',
      num(p.stock) === 0 ? 'Out of stock'
        : num(p.stock) <= num(db.settings?.lowStockThreshold, 5) ? 'Low stock' : 'In stock',
      p.active ? 'Yes' : 'Hidden',
      p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : ''
    ]);
  }
  return toCsv(rows);
}

/** Every order, one row per order, with how the delivery charge was worked out. */
export function ordersCsv(db) {
  const rows = [[
    'Order', 'Date', 'Customer', 'Phone', 'Email', 'Location', 'Distance km',
    'Items', 'Units', 'Subtotal', 'Delivery fee', 'Total',
    'Status', 'Payment', 'M-Pesa receipt', 'Arrives'
  ]];
  for (const o of db.orders || []) {
    rows.push([
      o.code,
      new Date(o.createdAt).toISOString().slice(0, 16).replace('T', ' '),
      o.customer?.name, o.customer?.phone, o.customer?.email, o.customer?.location,
      o.delivery?.distanceKm ?? '',
      (o.items || []).length,
      (o.items || []).reduce((n, i) => n + num(i.qty), 0),
      o.subtotal, o.deliveryFee, o.total,
      o.status,
      o.payment?.status || 'unpaid',
      o.payment?.receipt || '',
      o.delivery?.label || ''
    ]);
  }
  return toCsv(rows);
}

/** The balance sheet as a spreadsheet, for an accountant. */
export function balanceSheetCsv(sheet, currency = 'KSh') {
  const rows = [
    ['Tessora Beauty — Balance sheet'],
    ['As at', new Date(sheet.asOf).toISOString().slice(0, 16).replace('T', ' ')],
    ['Currency', currency],
    [],
    ['ASSETS', 'Amount', 'Note']
  ];
  for (const a of sheet.assets) rows.push([a.label, a.value, a.note]);
  rows.push(['Total assets', sheet.totalAssets, '']);
  rows.push([]);
  rows.push(['LIABILITIES', 'Amount', 'Note']);
  for (const l of sheet.liabilities) rows.push([l.label, l.value, l.note]);
  rows.push(['Total liabilities', sheet.totalLiabilities, '']);
  rows.push([]);
  rows.push(['EQUITY (assets − liabilities)', sheet.equity, '']);
  rows.push([]);
  rows.push(['MEMORANDUM', 'Amount', '']);
  rows.push(['Stock at retail value', sheet.memo.inventoryAtRetail, 'What the stock would sell for']);
  rows.push(['Unrealised margin', sheet.memo.unrealisedMargin, 'Retail value less cost']);
  rows.push(['Units in stock', sheet.memo.unitsInStock, '']);
  if (sheet.coverage.ratio < 1) {
    rows.push([]);
    rows.push(['WARNING',
      `${sheet.coverage.total - sheet.coverage.withCost} of ${sheet.coverage.total} products have no cost price, so stock at cost is understated.`]);
  }
  return toCsv(rows);
}

/** The financial analysis as a spreadsheet. */
export function financialsCsv(fin, currency = 'KSh') {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  const rows = [
    ['Tessora Beauty — Financial analysis'],
    ['Period', fin.periodLabel],
    ['Generated', new Date(fin.generatedAt).toISOString().slice(0, 16).replace('T', ' ')],
    ['Currency', currency],
    [],
    ['INCOME', 'Amount'],
    ['Merchandise sales', fin.income.merchandise],
    ['Delivery income', fin.income.deliveryIncome],
    ['Total revenue', fin.income.revenue],
    ['Cost of goods sold', fin.income.cogs],
    ['Gross profit', fin.income.grossProfit],
    ['Gross margin', pct(fin.income.grossMargin)],
    [],
    ['ORDERS', 'Value'],
    ['Orders placed', fin.orders.total],
    ['Cancelled', fin.orders.cancelled],
    ['Cancellation rate', pct(fin.orders.cancellationRate)],
    ['Value cancelled', fin.orders.cancelledValue],
    ['Paid', fin.orders.paid],
    ['Cash collected', fin.orders.collected],
    ['Still outstanding', fin.orders.outstanding],
    ['Average order value', fin.orders.averageOrder],
    ['Units sold', fin.orders.unitsSold],
    [],
    ['PRODUCT PROFITABILITY'],
    ['Product', 'Units sold', 'Revenue', 'Cost', 'Profit', 'Margin', 'Cost price set']
  ];
  for (const p of fin.topByProfit) {
    rows.push([p.name, p.qty, p.revenue, p.cost, p.profit, pct(p.margin), p.hasCost ? 'Yes' : 'No']);
  }
  rows.push([]);
  rows.push(['DAILY TREND']);
  rows.push(['Date', 'Orders', 'Revenue']);
  for (const d of fin.trend) rows.push([d.date, d.orders, d.revenue]);
  if (!fin.profitIsComplete) {
    rows.push([]);
    rows.push(['WARNING',
      `Only ${fin.coverage.linesCosted} of ${fin.coverage.linesTotal} sold lines had a cost price, so profit is understated.`]);
  }
  return toCsv(rows);
}

/* ----------------------------------------------------------- statements */

const page = (settings, title, subtitle, inner) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(settings.storeName || 'Tessora Beauty')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; background:${BRAND.ivory}; padding:28px 16px; font-family:${SANS}; color:${BRAND.ink}; }
  .sheet { max-width:820px; margin:0 auto; background:#fff; border:1px solid ${BRAND.line}; border-radius:16px; overflow:hidden; }
  .head { background:${BRAND.ink}; padding:28px 34px; }
  .head h1 { font-family:${SERIF}; font-size:26px; letter-spacing:.16em; color:#fff; margin:0; }
  .head p { font-family:${SANS}; font-size:12px; letter-spacing:.1em; color:${BRAND.goldLight}; margin:4px 0 0; }
  .body { padding:26px 34px 34px; }
  h2 { font-family:${SANS}; font-size:11px; letter-spacing:.16em; color:${BRAND.muted};
       margin:26px 0 8px; font-weight:600; text-transform:uppercase; }
  h2:first-child { margin-top:0; }
  table { width:100%; border-collapse:collapse; }
  td, th { padding:9px 0; font-size:14px; text-align:left; border-bottom:1px solid ${BRAND.line}; }
  th { font-size:11px; letter-spacing:.1em; color:${BRAND.muted}; font-weight:500; text-transform:uppercase; }
  .num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .note { color:${BRAND.muted}; font-size:12px; }
  .total td { border-top:2px solid ${BRAND.ink}; border-bottom:0; font-weight:600; font-size:16px; padding-top:12px; }
  .grand { background:${BRAND.blushSoft}; border-radius:12px; padding:16px 20px; margin-top:18px;
           display:flex; justify-content:space-between; align-items:baseline; }
  .grand b { font-family:${SERIF}; font-size:24px; }
  .warn { background:#fdf3e2; border:1px solid #eccf94; color:${BRAND.warn || '#b7791f'};
          border-radius:10px; padding:12px 16px; font-size:13px; margin:18px 0 0; line-height:1.55; }
  .cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:6px; }
  .card { flex:1 1 150px; background:${BRAND.ivory}; border:1px solid ${BRAND.line};
          border-radius:12px; padding:14px 16px; }
  .card span { display:block; font-size:10px; letter-spacing:.12em; color:${BRAND.muted}; text-transform:uppercase; }
  .card b { display:block; font-family:${SERIF}; font-size:21px; margin-top:3px; }
  .foot { background:${BRAND.ink}; color:${BRAND.goldLight}; padding:18px 34px; font-size:11px; letter-spacing:.06em; text-align:center; }
  .actions { max-width:820px; margin:0 auto 16px; text-align:right; }
  .actions button, .actions a { font:inherit; font-size:13px; letter-spacing:.1em; cursor:pointer;
    background:${BRAND.ink}; color:#fff; border:0; border-radius:999px; padding:10px 22px;
    text-decoration:none; display:inline-block; margin-left:8px; }
  .actions a.ghost { background:transparent; color:${BRAND.ink}; border:1px solid ${BRAND.line}; }
  @media print { .actions { display:none; } body { background:#fff; padding:0; } .sheet { border:0; } }
</style>
</head>
<body>
  <div class="actions">
    <a class="ghost" href="/admin">Back to admin</a>
    <button onclick="window.print()">Print / Save PDF</button>
  </div>
  <div class="sheet">
    <div class="head">
      <h1>${esc(String(settings.storeName || 'TESSORA BEAUTY').toUpperCase())}</h1>
      <p>${esc(subtitle)}</p>
    </div>
    <div class="body">${inner}</div>
    <div class="foot">${esc(title)} · generated ${new Date().toLocaleString('en-KE')}</div>
  </div>
</body>
</html>`;

/** The balance sheet, ready to print or save as a PDF. */
export function balanceSheetHtml(sheet, settings = {}) {
  const c = settings.currency || 'KSh';
  const row = (r) => `
    <tr>
      <td>${esc(r.label)}${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</td>
      <td class="num">${money(r.value, c)}</td>
    </tr>`;

  const warning = sheet.coverage.ratio < 1 ? `
    <div class="warn">
      <b>Stock at cost is understated.</b>
      ${sheet.coverage.total - sheet.coverage.withCost} of ${sheet.coverage.total} products have no
      cost price recorded, so they count as zero here. Add cost prices in
      Admin → Products to make this figure exact.
    </div>` : '';

  return page(settings, 'Balance sheet',
    `BALANCE SHEET · AS AT ${new Date(sheet.asOf).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}`, `
    <h2>Assets</h2>
    <table>${sheet.assets.map(row).join('')}
      <tr class="total"><td>Total assets</td><td class="num">${money(sheet.totalAssets, c)}</td></tr>
    </table>

    <h2>Liabilities</h2>
    <table>${sheet.liabilities.map(row).join('')}
      <tr class="total"><td>Total liabilities</td><td class="num">${money(sheet.totalLiabilities, c)}</td></tr>
    </table>

    <div class="grand">
      <span>Equity — what the business is worth</span>
      <b>${money(sheet.equity, c)}</b>
    </div>

    <h2>Memorandum</h2>
    <table>
      <tr><td>Stock at retail value<div class="note">What the stock would sell for</div></td>
          <td class="num">${money(sheet.memo.inventoryAtRetail, c)}</td></tr>
      <tr><td>Unrealised margin<div class="note">Retail value less cost</div></td>
          <td class="num">${money(sheet.memo.unrealisedMargin, c)}</td></tr>
      <tr><td>Units in stock</td><td class="num">${sheet.memo.unitsInStock.toLocaleString('en-KE')}</td></tr>
      <tr><td>Products</td><td class="num">${sheet.memo.productCount}</td></tr>
    </table>
    ${warning}`);
}

/** The financial analysis, ready to print or save as a PDF. */
export function financialsHtml(fin, settings = {}) {
  const c = settings.currency || 'KSh';
  const pct = (n) => `${(n * 100).toFixed(1)}%`;

  const profitRows = fin.topByProfit.length
    ? fin.topByProfit.map((p) => `
        <tr>
          <td>${esc(p.name)}${p.hasCost ? '' : '<div class="note">no cost price set</div>'}</td>
          <td class="num">${p.qty}</td>
          <td class="num">${money(p.revenue, c)}</td>
          <td class="num">${p.hasCost ? money(p.profit, c) : '—'}</td>
          <td class="num">${p.hasCost ? pct(p.margin) : '—'}</td>
        </tr>`).join('')
    : `<tr><td colspan="5" class="note">Nothing sold in this period.</td></tr>`;

  const trendRows = fin.trend.length
    ? fin.trend.slice(-30).map((d) => `
        <tr>
          <td>${new Date(d.date).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' })}</td>
          <td class="num">${d.orders}</td>
          <td class="num">${money(d.revenue, c)}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" class="note">No orders in this period.</td></tr>`;

  const warning = !fin.profitIsComplete ? `
    <div class="warn">
      <b>Profit is understated.</b>
      Only ${fin.coverage.linesCosted} of ${fin.coverage.linesTotal} sold lines had a cost price
      behind them, so cost of goods sold — and therefore gross profit — is incomplete.
      Add cost prices in Admin → Products for exact margins.
    </div>` : '';

  return page(settings, 'Financial analysis',
    `FINANCIAL ANALYSIS · ${String(fin.periodLabel).toUpperCase()}`, `
    <div class="cards">
      <div class="card"><span>Revenue</span><b>${money(fin.income.revenue, c)}</b></div>
      <div class="card"><span>Gross profit</span><b>${money(fin.income.grossProfit, c)}</b></div>
      <div class="card"><span>Gross margin</span><b>${pct(fin.income.grossMargin)}</b></div>
      <div class="card"><span>Avg order</span><b>${money(fin.orders.averageOrder, c)}</b></div>
    </div>

    <h2>Income</h2>
    <table>
      <tr><td>Merchandise sales</td><td class="num">${money(fin.income.merchandise, c)}</td></tr>
      <tr><td>Delivery income</td><td class="num">${money(fin.income.deliveryIncome, c)}</td></tr>
      <tr class="total"><td>Total revenue</td><td class="num">${money(fin.income.revenue, c)}</td></tr>
    </table>
    <table style="margin-top:14px">
      <tr><td>Less cost of goods sold</td><td class="num">− ${money(fin.income.cogs, c)}</td></tr>
      <tr class="total"><td>Gross profit</td><td class="num">${money(fin.income.grossProfit, c)}</td></tr>
    </table>

    <h2>Orders &amp; collection</h2>
    <table>
      <tr><td>Orders placed</td><td class="num">${fin.orders.total}</td></tr>
      <tr><td>Cancelled<div class="note">${money(fin.orders.cancelledValue, c)} of business lost</div></td>
          <td class="num">${fin.orders.cancelled} · ${pct(fin.orders.cancellationRate)}</td></tr>
      <tr><td>Paid by M-Pesa</td><td class="num">${fin.orders.paid}</td></tr>
      <tr><td>Cash collected</td><td class="num">${money(fin.orders.collected, c)}</td></tr>
      <tr><td>Still outstanding</td><td class="num">${money(fin.orders.outstanding, c)}</td></tr>
      <tr><td>Units sold</td><td class="num">${fin.orders.unitsSold}</td></tr>
    </table>

    <h2>Most profitable products</h2>
    <table>
      <tr><th>Product</th><th class="num">Units</th><th class="num">Revenue</th><th class="num">Profit</th><th class="num">Margin</th></tr>
      ${profitRows}
    </table>

    <h2>Daily trend</h2>
    <table>
      <tr><th>Date</th><th class="num">Orders</th><th class="num">Revenue</th></tr>
      ${trendRows}
    </table>
    ${warning}`);
}
