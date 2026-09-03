// Tessora Beauty — the store's activity log.
//
// Every action that changes the shop is written here: products added, prices
// and stock edited, orders placed, confirmed or cancelled, payments, settings
// and password changes. It is the shop's paper trail — what changed, when, and
// who did it — and it is what the emailed store report is built from.

const MAX_ENTRIES = 1000;

/** Every kind of event the shop records, with a human label and a group. */
export const EVENTS = {
  'product.created':   { label: 'Product added',        group: 'products' },
  'product.updated':   { label: 'Product edited',       group: 'products' },
  'product.deleted':   { label: 'Product deleted',      group: 'products' },
  'product.stock':     { label: 'Stock changed',        group: 'stock' },
  'product.price':     { label: 'Price changed',        group: 'products' },
  'product.visible':   { label: 'Visibility changed',   group: 'products' },
  'order.placed':      { label: 'Order placed',         group: 'orders' },
  'order.confirmed':   { label: 'Order confirmed',      group: 'orders' },
  'order.delivered':   { label: 'Order delivered',      group: 'orders' },
  'order.cancelled':   { label: 'Order cancelled',      group: 'orders' },
  'order.status':      { label: 'Order status changed', group: 'orders' },
  'payment.requested': { label: 'M-Pesa prompt sent',   group: 'payments' },
  'payment.paid':      { label: 'Payment received',     group: 'payments' },
  'payment.failed':    { label: 'Payment failed',       group: 'payments' },
  'settings.updated':  { label: 'Settings changed',     group: 'settings' },
  'security.password': { label: 'Password changed',     group: 'security' },
  'security.login':    { label: 'Admin signed in',      group: 'security' },
  'security.denied':   { label: 'Failed sign-in',       group: 'security' },
  'account.created':   { label: 'Customer registered',  group: 'customers' }
};

const short = (v, max = 80) => {
  const s = v === null || v === undefined || v === '' ? '—' : String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Compare two objects over the given fields and describe what changed.
 * Returns [{ field, label, from, to }] — the raw material for "price 450 → 400".
 */
export function diff(before = {}, after = {}, fields) {
  const out = [];
  for (const [field, label] of Object.entries(fields)) {
    const from = before?.[field];
    const to = after?.[field];
    if (to === undefined) continue;
    // Loose compare so 450 and "450" do not read as a change.
    if (String(from ?? '') === String(to ?? '')) continue;
    out.push({ field, label, from: from ?? null, to: to ?? null });
  }
  return out;
}

/** One-line description of a set of changes, e.g. "Price 450 → 400, Stock 12 → 20". */
export function describe(changes = []) {
  return changes.map((c) => `${c.label} ${short(c.from, 40)} → ${short(c.to, 40)}`).join(', ');
}

/**
 * Append an event to the log. Mutates `db.activity` and returns the entry.
 *
 * `actor` is who did it: 'admin', 'customer', 'system' (M-Pesa callbacks,
 * automatic stock moves) — so the report can separate deliberate edits from
 * things the shop did on its own.
 */
export function record(db, { type, summary, actor = 'admin', target = '', targetId = '', changes = [], meta = {} }) {
  db.activity ||= [];
  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    type,
    group: EVENTS[type]?.group || 'other',
    label: EVENTS[type]?.label || type,
    actor,
    target,
    targetId,
    summary: summary || describe(changes) || EVENTS[type]?.label || type,
    changes,
    meta,
    read: false
  };
  db.activity.unshift(entry);
  if (db.activity.length > MAX_ENTRIES) db.activity.length = MAX_ENTRIES;
  return entry;
}

/** How many events the admin has not looked at yet. */
export const unreadCount = (db) => (db.activity || []).filter((a) => !a.read).length;

/* ---------------------------------------------------------------- reports */

const startOf = (period) => {
  const now = new Date();
  if (period === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const days = period === '30d' ? 30 : period === '7d' ? 7 : 1;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
};

/**
 * Build the store report for a period: what sold, what it earned, what needs
 * restocking, and everything that was changed. This is the body of the email
 * the shop owner gets, and what the Activity tab shows.
 */
export function buildReport(db, period = 'today') {
  const since = startOf(period);
  const inPeriod = (iso) => new Date(iso) >= since;

  const orders = (db.orders || []).filter((o) => inPeriod(o.createdAt));
  const activity = (db.activity || []).filter((a) => inPeriod(a.at));
  const settled = new Set(['confirmed', 'delivered']);

  const byStatus = { pending: 0, confirmed: 0, delivered: 0, cancelled: 0 };
  for (const o of orders) if (byStatus[o.status] !== undefined) byStatus[o.status] += 1;

  // What actually sold, best sellers first.
  const sold = new Map();
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    for (const i of o.items || []) {
      const row = sold.get(i.productId) || { name: i.name, qty: 0, value: 0 };
      row.qty += i.qty;
      row.value += i.price * i.qty;
      sold.set(i.productId, row);
    }
  }
  const topProducts = [...sold.values()].sort((a, b) => b.qty - a.qty).slice(0, 10);

  const threshold = Number(db.settings?.lowStockThreshold ?? 5);
  const products = db.products || [];

  const byGroup = {};
  for (const a of activity) byGroup[a.group] = (byGroup[a.group] || 0) + 1;

  const revenue = orders.filter((o) => settled.has(o.status)).reduce((n, o) => n + (o.total || 0), 0);
  const paid = orders.filter((o) => o.payment?.status === 'paid');

  return {
    period,
    since: since.toISOString(),
    generatedAt: new Date().toISOString(),
    orders: {
      total: orders.length,
      ...byStatus,
      revenue,
      averageOrder: orders.length ? Math.round(revenue / Math.max(1, byStatus.confirmed + byStatus.delivered || 1)) : 0,
      paidOnline: paid.length,
      paidOnlineValue: paid.reduce((n, o) => n + (o.total || 0), 0)
    },
    topProducts,
    stock: {
      outOfStock: products.filter((p) => p.stock === 0).map((p) => ({ name: p.name, sku: p.sku })),
      lowStock: products.filter((p) => p.stock > 0 && p.stock <= threshold)
        .map((p) => ({ name: p.name, sku: p.sku, stock: p.stock })),
      unitsInStock: products.reduce((n, p) => n + (p.stock || 0), 0),
      totalProducts: products.length
    },
    changes: {
      total: activity.length,
      byGroup,
      entries: activity.slice(0, 60)
    },
    customers: {
      total: (db.customers || []).length,
      newInPeriod: (db.customers || []).filter((c) => inPeriod(c.createdAt)).length
    }
  };
}
