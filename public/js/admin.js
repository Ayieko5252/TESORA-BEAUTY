/* Tessora Beauty — admin dashboard logic */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const TOKEN_KEY = 'tessora.admin.token';

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    settings: {},
    categories: [],
    products: [],
    orders: [],
    stats: {},
    editing: null,      // product being edited
    keptImages: [],     // existing image urls kept in the modal
    newImages: []       // data URLs queued for upload
  };

  /* ------------------------------------------------------------ helpers */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const money = (n) => `${state.settings.currency || 'KSh'} ${Number(n || 0).toLocaleString('en-KE')}`;
  const dateFmt = (iso) => new Date(iso).toLocaleString('en-KE', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  let toastTimer;
  function toast(message, bad = false) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('toast--bad', bad);
    el.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-open'), 2800);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && state.token) { signOut(true); throw new Error(data.error || 'Session expired'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  const lowThreshold = () => Number(state.settings.lowStockThreshold || 5);

  function stockPill(p) {
    if (p.stock <= 0) return '<span class="pill pill--bad">Out of stock</span>';
    if (p.stock <= lowThreshold()) return `<span class="pill pill--warn">Low · ${p.stock} left</span>`;
    return `<span class="pill pill--ok">${p.stock} in stock</span>`;
  }

  const thumb = (p) => (p.images && p.images[0]
    ? `<img class="thumb" src="${esc(p.images[0])}" alt="">`
    : `<div class="thumb thumb--ph">${esc((p.name || '?').charAt(0).toUpperCase())}</div>`);

  /* -------------------------------------------------------------- auth */
  async function signIn(event) {
    event.preventDefault();
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const data = await api('/login', { method: 'POST', body: { password: $('#password').value } });
      state.token = data.token;
      sessionStorage.setItem(TOKEN_KEY, data.token);
      $('#password').value = '';
      $('#loginMsg').innerHTML = '';
      await start();
    } catch (err) {
      $('#loginMsg').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  function signOut(expired = false) {
    stopLiveUpdates();
    state.token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    $('#app').classList.remove('is-ready');
    $('#login').style.display = 'grid';
    if (expired) $('#loginMsg').innerHTML = '<div class="notice notice--warn">Your session expired. Please sign in again.</div>';
  }

  async function start() {
    $('#login').style.display = 'none';
    $('#app').classList.add('is-ready');
    await refresh();
    startLiveUpdates();
  }

  /* ------------------------------------------------------------ loading */
  /**
   * Reload everything from the server and redraw.
   * `live` marks an automatic background refresh: those must never re-fill the
   * settings forms, or a half-typed change would be wiped out mid-edit.
   */
  async function refresh({ live = false } = {}) {
    const data = await api('/admin/overview');
    Object.assign(state, {
      settings: data.settings, categories: data.categories,
      products: data.products, orders: data.orders, stats: data.stats,
      customers: data.customers || []
    });
    setActivityBadge(data.activityUnread || 0);
    $('#globalNotice').innerHTML = state.settings.passwordIsDefault
      ? `<div class="notice notice--warn">
           <b>Security:</b> you are still using the default password.
           <button class="btn btn--sm btn--dark" data-tab="settings" style="margin-left:.5rem">Change it now</button>
         </div>`
      : '';
    fillCategorySelects();
    renderDashboard();
    renderProducts();
    renderInventory();
    renderOrders();
    if (!live || !$('#panel-settings').classList.contains('is-active')) fillSettings();
    renderBadges();
  }

  function fillCategorySelects() {
    const options = state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('#pmCategory').innerHTML = options;
    $('#prodCategory').innerHTML = `<option value="all">All categories</option>${options}`;
  }

  function renderBadges() {
    const alerts = state.stats.lowStock + state.stats.outOfStock;
    $('#badgeStock').textContent = alerts;
    $('#badgeStock').hidden = alerts === 0;
    $('#badgeOrders').textContent = state.stats.pendingOrders;
    $('#badgeOrders').hidden = state.stats.pendingOrders === 0;
  }

  /* --------------------------------------------------------- dashboard */
  function renderDashboard() {
    const s = state.stats;
    $('#statCards').innerHTML = `
      <div class="stat"><span>Products</span><b>${s.totalProducts}</b><small>${s.activeProducts} published on the shop</small></div>
      <div class="stat stat--ok"><span>Units in stock</span><b>${s.unitsInStock.toLocaleString('en-KE')}</b><small>Stock value ${money(s.inventoryValue)}</small></div>
      <div class="stat stat--warn"><span>Low stock</span><b>${s.lowStock}</b><small>At or below ${lowThreshold()} units</small></div>
      <div class="stat stat--bad"><span>Out of stock</span><b>${s.outOfStock}</b><small>Needs restocking</small></div>
      <div class="stat"><span>Orders</span><b>${s.totalOrders}</b><small>${s.pendingOrders} awaiting confirmation</small></div>
      <div class="stat stat--ok"><span>Revenue</span><b>${money(s.revenue)}</b><small>Confirmed &amp; delivered orders</small></div>`;

    const recent = state.orders.slice(0, 6);
    $('#recentOrders').innerHTML = recent.length ? recent.map((o) => `
      <div class="list__row">
        <div>
          <b>${esc(o.code)}</b> · ${esc(o.customer.name)}<br>
          <small style="color:var(--muted)">${o.items.length} item${o.items.length === 1 ? '' : 's'} · ${dateFmt(o.createdAt)}</small>
        </div>
        <div class="right">
          <b>${money(o.total)}</b><br>${statusPill(o.status)}
        </div>
      </div>`).join('')
      : '<div class="empty"><p>No orders yet.</p></div>';

    const alerts = state.products
      .filter((p) => p.stock <= lowThreshold())
      .sort((a, b) => a.stock - b.stock)
      .slice(0, 7);
    $('#stockAlerts').innerHTML = alerts.length ? alerts.map((p) => `
      <div class="list__row">
        ${thumb(p)}
        <div><b>${esc(p.name)}</b><br><small style="color:var(--muted)">${esc(p.category)}</small></div>
        <div class="right">${stockPill(p)}
          <div style="margin-top:.3rem"><button class="btn btn--light btn--sm" data-restock="${p.id}">+10</button></div>
        </div>
      </div>`).join('')
      : '<div class="empty"><p>All products are well stocked ♡</p></div>';
  }

  const statusPill = (status) => ({
    pending: '<span class="pill pill--warn">Pending</span>',
    confirmed: '<span class="pill pill--info">Confirmed</span>',
    delivered: '<span class="pill pill--ok">Delivered</span>',
    cancelled: '<span class="pill pill--muted">Cancelled</span>'
  }[status] || `<span class="pill pill--muted">${esc(status)}</span>`);

  // Every order is paid by M-Pesa — the shop does not take cash on delivery.
  const paymentPill = (o) => {
    const p = o.payment || { status: 'unpaid' };
    if (p.status === 'paid') {
      return `<span class="pill pill--ok">M-Pesa paid${p.receipt ? ` · ${esc(p.receipt)}` : ''}</span>`;
    }
    if (p.status === 'processing') return '<span class="pill pill--info">M-Pesa pending</span>';
    if (p.status === 'failed') return '<span class="pill pill--bad">M-Pesa failed</span>';
    return '<span class="pill pill--warn">Awaiting payment</span>';
  };

  /* ---------------------------------------------------------- products */
  function filteredProducts() {
    const q = $('#prodSearch').value.trim().toLowerCase();
    const cat = $('#prodCategory').value;
    const status = $('#prodStatus').value;
    return state.products.filter((p) => {
      if (cat !== 'all' && p.category !== cat) return false;
      if (status === 'active' && !p.active) return false;
      if (status === 'hidden' && p.active) return false;
      if (status === 'sale' && !(p.discount > 0)) return false;
      if (status === 'low' && !(p.stock > 0 && p.stock <= lowThreshold())) return false;
      if (status === 'out' && p.stock !== 0) return false;
      if (!q) return true;
      return `${p.name} ${p.brand} ${p.sku} ${p.category}`.toLowerCase().includes(q);
    });
  }

  function renderProducts() {
    const list = filteredProducts();
    $('#prodCount').textContent = `${list.length} of ${state.products.length} products`;
    $('#prodEmpty').hidden = list.length > 0;
    $('#prodRows').innerHTML = list.map((p) => `
      <tr>
        <td class="rt-head"><div class="prod-cell prod-cell--edit" data-edit="${p.id}" title="Click to edit ${esc(p.name)}">
          ${thumb(p)}
          <div><b>${esc(p.name)}</b><small><span class="cat-inline">${esc(p.category)} · </span>${esc(p.brand || p.sku)}</small></div>
          <svg class="prod-cell__pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </div></td>
        <td class="col-cat" data-label="Category">${esc(p.category)}</td>
        <td class="t-right" data-label="Price">${money(p.price)}</td>
        <td class="t-center" data-label="Discount">${p.discount > 0 ? `<span class="pill pill--sale">-${p.discount}%</span>` : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="t-right" data-label="Sells at"><b>${money(p.salePrice)}</b></td>
        <td class="t-center" data-label="Stock">${stockPill(p)}</td>
        <td class="t-center" data-label="Status">${p.active ? '<span class="pill pill--ok">Live</span>' : '<span class="pill pill--muted">Hidden</span>'}</td>
        <td class="t-right rt-actions">
          <button class="btn btn--light btn--sm" data-edit="${p.id}">Edit</button>
          <button class="btn btn--light btn--sm" data-toggle="${p.id}">${p.active ? 'Hide' : 'Publish'}</button>
          <button class="btn btn--danger btn--sm" data-delete="${p.id}">Delete</button>
        </td>
      </tr>`).join('');
  }

  /* --------------------------------------------------------- inventory */
  function renderInventory() {
    const filter = $('#invFilter').value;
    const low = lowThreshold();
    const list = state.products.filter((p) => {
      if (filter === 'low') return p.stock > 0 && p.stock <= low;
      if (filter === 'out') return p.stock === 0;
      if (filter === 'in') return p.stock > low;
      return true;
    }).sort((a, b) => a.stock - b.stock);

    const s = state.stats;
    $('#invStats').innerHTML = `
      <div class="stat"><span>Total units</span><b>${s.unitsInStock.toLocaleString('en-KE')}</b><small>Across ${s.totalProducts} products</small></div>
      <div class="stat stat--ok"><span>Stock value</span><b>${money(s.inventoryValue)}</b><small>At current selling prices</small></div>
      <div class="stat stat--warn"><span>Low stock</span><b>${s.lowStock}</b><small>Restock soon</small></div>
      <div class="stat stat--bad"><span>Out of stock</span><b>${s.outOfStock}</b><small>Not sellable right now</small></div>`;

    $('#invEmpty').hidden = list.length > 0;
    $('#invRows').innerHTML = list.map((p) => `
      <tr>
        <td class="rt-head"><div class="prod-cell prod-cell--edit" data-edit="${p.id}" title="Click to edit ${esc(p.name)}">
          ${thumb(p)}
          <div><b>${esc(p.name)}</b><small>${esc(p.category)}</small></div>
          <svg class="prod-cell__pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </div></td>
        <td data-label="SKU"><small style="color:var(--muted)">${esc(p.sku)}</small></td>
        <td class="t-center" data-label="Status">${stockPill(p)}</td>
        <td class="t-center" data-label="In stock">
          <div class="stock-edit">
            <button data-stock-dec="${p.id}" aria-label="Decrease stock of ${esc(p.name)}">−</button>
            <input type="number" inputmode="numeric" min="0" value="${p.stock}" data-stock-set="${p.id}" aria-label="Stock of ${esc(p.name)}">
            <button data-stock-inc="${p.id}" aria-label="Increase stock of ${esc(p.name)}">+</button>
          </div>
        </td>
        <td class="t-center" data-label="Buying price">
          <input class="cost-edit${p.costPrice ? '' : ' cost-edit--empty'}" type="number" inputmode="numeric" min="0" step="1"
                 value="${p.costPrice || ''}" placeholder="—" title="What you paid for one unit"
                 aria-label="Buying price of ${esc(p.name)}" data-cost-set="${p.id}">
        </td>
        <td class="t-right" data-label="Stock value">${money(p.salePrice * p.stock)}</td>
        <td class="t-right rt-actions">
          <button class="btn btn--light btn--sm" data-restock="${p.id}">+10</button>
          <button class="btn btn--light btn--sm" data-restock50="${p.id}">+50</button>
        </td>
      </tr>`).join('');
  }

  /* ------------------------------------------------------------ orders */
  function renderOrders() {
    const filter = $('#orderFilter').value;
    const list = state.orders.filter((o) => filter === 'all' || o.status === filter);
    $('#orderEmpty').hidden = list.length > 0;
    $('#orderRows').innerHTML = list.map((o) => `
      <tr>
        <td class="rt-head"><b>${esc(o.code)}</b><br><small style="color:var(--muted)">${dateFmt(o.createdAt)}</small></td>
        <td data-label="Customer">${esc(o.customer.name)}<br><small style="color:var(--muted)">${esc(o.customer.phone)}</small></td>
        <td data-label="Items">${o.items.length} item${o.items.length === 1 ? '' : 's'}<br>
            <small style="color:var(--muted)">${esc(o.items.map((i) => `${i.name} x${i.qty}`).join(', ').slice(0, 46))}${o.items.map((i) => i.name).join(', ').length > 46 ? '…' : ''}</small></td>
        <td class="t-right" data-label="Total"><b>${money(o.total)}</b><br>${paymentPill(o)}</td>
        <td class="t-center" data-label="Status">${statusPill(o.status)}</td>
        <td class="t-right rt-actions">
          <button class="btn btn--light btn--sm" data-order="${o.id}">View</button>
          <select class="input status-select" data-order-status="${o.id}" aria-label="Change status of ${esc(o.code)}">
            ${['pending', 'confirmed', 'delivered', 'cancelled'].map((s) =>
              `<option value="${s}"${o.status === s ? ' selected' : ''}>${s[0].toUpperCase()}${s.slice(1)}</option>`).join('')}
          </select>
        </td>
      </tr>`).join('');
  }

  function openOrder(id) {
    const o = state.orders.find((x) => x.id === id);
    if (!o) return;
    const wa = `https://wa.me/${(o.customer.phone || '').replace(/\D/g, '').replace(/^0/, '254')}`;
    $('#omTitle').textContent = `Order ${o.code}`;
    $('#omBody').innerHTML = `
      <div class="grid-2">
        <div>
          <p style="font-size:.74rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Customer</p>
          <p><b>${esc(o.customer.name)}</b><br>${esc(o.customer.phone)}<br>${esc(o.customer.location || 'No location given')}</p>
          ${o.customer.notes ? `<p style="font-size:.86rem"><b>Notes:</b> ${esc(o.customer.notes)}</p>` : ''}
        </div>
        <div>
          <p style="font-size:.74rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)">Order</p>
          <p>${dateFmt(o.createdAt)}<br>${statusPill(o.status)} ${paymentPill(o)}</p>
          ${o.payment?.receipt ? `<p style="font-size:.86rem">M-Pesa receipt: <b>${esc(o.payment.receipt)}</b></p>` : ''}
          <a class="btn btn--light btn--sm" href="${esc(wa)}" target="_blank" rel="noopener">Message on WhatsApp</a>
        </div>
      </div>
      <div class="table-wrap" style="margin-top:1rem;border:1px solid var(--line);border-radius:var(--radius)">
        <table>
          <thead><tr><th>Item</th><th class="t-center">Qty</th><th class="t-right">Price</th><th class="t-right">Line total</th></tr></thead>
          <tbody>
            ${o.items.map((i) => `<tr><td>${esc(i.name)}<br><small style="color:var(--muted)">${esc(i.sku || '')}</small></td>
              <td class="t-center">${i.qty}</td><td class="t-right">${money(i.price)}</td>
              <td class="t-right"><b>${money(i.price * i.qty)}</b></td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="list" style="margin-top:1rem">
        <div class="list__row"><span>Subtotal</span><span class="right">${money(o.subtotal)}</span></div>
        <div class="list__row"><span>Delivery${o.distanceKm != null ? ` (~${o.distanceKm} km)` : ''}</span><span class="right">${o.deliveryFee === 0 ? 'Free' : money(o.deliveryFee)}</span></div>
        <div class="list__row"><b>Total</b><b class="right">${money(o.total)}</b></div>
      </div>`;
    $('#orderModal').classList.add('is-open');
  }

  async function setOrderStatus(id, status) {
    try {
      await api(`/admin/orders/${id}`, { method: 'PATCH', body: { status } });
      await refresh();
      toast(`Order marked ${status}`);
    } catch (err) { toast(err.message, true); }
  }

  /* --------------------------------------------------- product modal */
  function openProductModal(product = null) {
    state.editing = product;
    state.keptImages = product ? [...product.images] : [];
    state.newImages = [];

    $('#pmTitle').textContent = product ? 'Edit product' : 'Add product';
    $('#pmMsg').innerHTML = '';
    $('#pmId').value = product?.id || '';
    $('#pmName').value = product?.name || '';
    $('#pmBrand').value = product?.brand || '';
    $('#pmCategory').value = product?.category || state.categories[0];
    $('#pmSku').value = product?.sku || '';
    $('#pmPrice').value = product?.price ?? '';
    $('#pmDiscount').value = product?.discount ?? 0;
    $('#pmStock').value = product?.stock ?? 0;
    $('#pmCostPrice').value = product?.costPrice || '';
    $('#pmDescription').value = product?.description || '';
    $('#pmActive').checked = product ? product.active : true;
    $('#pmFeatured').checked = product ? product.featured : false;

    renderPreviews();
    updatePricePreview();
    $('#productModal').classList.add('is-open');
    setTimeout(() => $('#pmName').focus(), 120);
  }

  function closeModals() {
    $$('.modal').forEach((m) => m.classList.remove('is-open'));
  }

  function renderPreviews() {
    const existing = state.keptImages.map((url, i) => `
      <div class="preview"><img src="${esc(url)}" alt="">
        <button type="button" data-drop-existing="${i}" aria-label="Remove">&times;</button></div>`);
    const fresh = state.newImages.map((url, i) => `
      <div class="preview"><img src="${esc(url)}" alt="">
        <button type="button" data-drop-new="${i}" aria-label="Remove">&times;</button></div>`);
    $('#pmPreviews').innerHTML = [...existing, ...fresh].join('');
  }

  function updatePricePreview() {
    const price = Number($('#pmPrice').value) || 0;
    const discount = Math.min(95, Math.max(0, Number($('#pmDiscount').value) || 0));
    const el = $('#pmPricePreview');
    if (!price) { el.style.display = 'none'; return; }
    const sale = Math.round(price * (1 - discount / 100));
    el.style.display = 'block';
    el.innerHTML = discount > 0
      ? `Customers will see <b>${money(sale)}</b> <s style="opacity:.6">${money(price)}</s> — they save ${money(price - sale)} (${discount}% off).`
      : `Customers will see <b>${money(price)}</b>. Add a discount % to run an offer.`;
  }

  function readFiles(fileList) {
    const files = Array.from(fileList).slice(0, 5);
    files.forEach((file) => {
      if (!file.type.startsWith('image/')) return toast('Only image files are allowed', true);
      if (file.size > 6 * 1024 * 1024) return toast(`${file.name} is bigger than 6MB`, true);
      const reader = new FileReader();
      reader.onload = () => {
        state.newImages.push(reader.result);
        renderPreviews();
      };
      reader.readAsDataURL(file);
    });
  }

  async function saveProduct() {
    const btn = $('#pmSave');
    const payload = {
      name: $('#pmName').value.trim(),
      brand: $('#pmBrand').value.trim(),
      category: $('#pmCategory').value,
      sku: $('#pmSku').value.trim(),
      price: Number($('#pmPrice').value),
      discount: Number($('#pmDiscount').value) || 0,
      stock: Number($('#pmStock').value) || 0,
      costPrice: Number($('#pmCostPrice').value) || 0,
      description: $('#pmDescription').value.trim(),
      active: $('#pmActive').checked,
      featured: $('#pmFeatured').checked,
      images: state.keptImages,
      newImages: state.newImages
    };

    if (!payload.name) return showModalError('Please give the product a name.');
    if (!(payload.price > 0)) return showModalError('Please set a price greater than 0.');

    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      if (state.editing) await api(`/admin/products/${state.editing.id}`, { method: 'PUT', body: payload });
      else await api('/admin/products', { method: 'POST', body: payload });
      closeModals();
      await refresh();
      toast(state.editing ? 'Product updated ♡' : 'Product added ♡');
    } catch (err) {
      showModalError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save product';
    }
  }

  function showModalError(message) {
    $('#pmMsg').innerHTML = `<div class="notice notice--error">${esc(message)}</div>`;
    $('#productModal .modal__panel').scrollTop = 0;
  }

  async function patchProduct(id, body, message) {
    try {
      await api(`/admin/products/${id}`, { method: 'PATCH', body });
      await refresh();
      if (message) toast(message);
    } catch (err) { toast(err.message, true); }
  }

  async function deleteProduct(id) {
    const p = state.products.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
    try {
      await api(`/admin/products/${id}`, { method: 'DELETE' });
      await refresh();
      toast('Product deleted');
    } catch (err) { toast(err.message, true); }
  }

  /* ---------------------------------------------------------- settings */
  function fillSettings() {
    const s = state.settings;
    $('#setStoreName').value = s.storeName || '';
    $('#setTagline').value = s.tagline || '';
    $('#setAnnounce').value = s.announcement || '';
    $('#setWhatsapp').value = s.whatsapp || '';
    $('#setEmail').value = s.email || '';
    $('#setInstagram').value = s.instagram || '';
    $('#setTiktok').value = s.tiktok || '';
    $('#setLocation').value = s.location || '';
    $('#setCurrency').value = s.currency || 'KSh';
    $('#setDelivery').value = s.deliveryFee ?? 0;
    $('#setFreeOver').value = s.freeDeliveryOver ?? 0;
    $('#setThreshold').value = s.lowStockThreshold ?? 5;

    // reports and alerts (the API key is never returned — blank means "keep")
    $('#setReportEmail').value = s.reportEmail || '';
    $('#setEmailFrom').value = s.emailFrom || '';
    $('#setNotifyNewOrder').checked = Boolean(s.notifyNewOrder);
    $('#setNotifyPayment').checked = Boolean(s.notifyPayment);
    $('#setNotifyStatus').checked = Boolean(s.notifyStatusChange);
    $('#setNotifyChanges').checked = Boolean(s.notifyAdminChanges);
    const status = $('#emailStatus');
    status.textContent = s.emailReady ? 'Email ready' : (s.emailApiKeySet ? 'Key set — add a recipient' : 'Not configured');
    status.className = `tag ${s.emailReady ? 'tag--ok' : 'tag--muted'}`;

    // delivery-by-distance + maps
    $('#setPerKm').value = s.deliveryPerKm ?? 15;
    $('#setBaseFee').value = s.deliveryBaseFee ?? 0;
    $('#setMapsKey').value = s.mapsApiKey || '';
    $('#setGoogleClientId').value = s.googleClientId || '';
    $('#setStoreLat').value = s.storeLat ?? '';
    $('#setStoreLng').value = s.storeLng ?? '';

    // M-Pesa (secrets are never returned; the inputs stay blank = keep existing)
    $('#setMpesaEnabled').checked = Boolean(s.mpesaEnabled);
    $('#setMpesaEnv').value = s.mpesaEnv || 'sandbox';
    $('#setMpesaType').value = s.mpesaType || 'paybill';
    $('#setMpesaShortcode').value = s.mpesaShortcode || '';
    $('#setMpesaTill').value = s.mpesaTill || '';
    $('#setMpesaKey').value = s.mpesaConsumerKey || '';
    $('#setMpesaCallback').value = s.mpesaCallbackUrl || '';
    $('#setMpesaSecret').placeholder = s.mpesaConsumerSecretSet ? 'Saved — leave blank to keep' : 'Consumer secret';
    $('#setMpesaPasskey').placeholder = s.mpesaPasskeySet ? 'Saved — leave blank to keep' : 'Passkey';
  }

  async function saveSettings(event) {
    event.preventDefault();
    try {
      await api('/admin/settings', {
        method: 'PUT',
        body: {
          storeName: $('#setStoreName').value, tagline: $('#setTagline').value,
          announcement: $('#setAnnounce').value, whatsapp: $('#setWhatsapp').value,
          email: $('#setEmail').value, instagram: $('#setInstagram').value,
          tiktok: $('#setTiktok').value, location: $('#setLocation').value,
          currency: $('#setCurrency').value, deliveryFee: $('#setDelivery').value,
          freeDeliveryOver: $('#setFreeOver').value, lowStockThreshold: $('#setThreshold').value,
          deliveryPerKm: $('#setPerKm').value, deliveryBaseFee: $('#setBaseFee').value,
          mapsApiKey: $('#setMapsKey').value,
          googleClientId: $('#setGoogleClientId').value.trim(),
          storeLat: $('#setStoreLat').value, storeLng: $('#setStoreLng').value
        }
      });
      await refresh();
      toast('Settings saved ♡');
    } catch (err) { toast(err.message, true); }
  }

  async function saveMpesa(event) {
    event.preventDefault();
    const body = {
      mpesaEnabled: $('#setMpesaEnabled').checked,
      mpesaEnv: $('#setMpesaEnv').value,
      mpesaType: $('#setMpesaType').value,
      mpesaShortcode: $('#setMpesaShortcode').value,
      mpesaTill: $('#setMpesaTill').value,
      mpesaConsumerKey: $('#setMpesaKey').value,
      mpesaCallbackUrl: $('#setMpesaCallback').value
    };
    // Only send secrets when the owner actually typed a new one.
    if ($('#setMpesaSecret').value) body.mpesaConsumerSecret = $('#setMpesaSecret').value;
    if ($('#setMpesaPasskey').value) body.mpesaPasskey = $('#setMpesaPasskey').value;
    try {
      await api('/admin/settings', { method: 'PUT', body });
      $('#setMpesaSecret').value = '';
      $('#setMpesaPasskey').value = '';
      $('#mpesaMsg').innerHTML = '<div class="notice notice--ok">M-Pesa settings saved.</div>';
      await refresh();
      toast('M-Pesa settings saved ♡');
    } catch (err) {
      $('#mpesaMsg').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    const next = $('#pwNew').value;
    if (next !== $('#pwConfirm').value) {
      $('#passwordMsg').innerHTML = '<div class="notice notice--error">The new passwords do not match.</div>';
      return;
    }
    try {
      const res = await api('/admin/password', {
        method: 'PUT',
        body: { currentPassword: $('#pwCurrent').value, newPassword: next }
      });
      // Changing the password ends every session that was open, including this
      // one. The server hands back a replacement so whoever made the change
      // stays signed in while everyone else is signed out.
      if (res.token) {
        state.token = res.token;
        sessionStorage.setItem(TOKEN_KEY, res.token);
      }
      $('#passwordForm').reset();
      $('#passwordMsg').innerHTML =
        '<div class="notice notice--ok">Password changed. Any other device signed in to this panel has been signed out.</div>';
      $('#globalNotice').innerHTML = '';
      toast('Password updated');
    } catch (err) {
      $('#passwordMsg').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    }
  }

  /* --------------------------------------------------- reports & alerts */

  async function saveReportSettings(event) {
    event.preventDefault();
    const body = {
      reportEmail: $('#setReportEmail').value.trim(),
      emailFrom: $('#setEmailFrom').value.trim(),
      notifyNewOrder: $('#setNotifyNewOrder').checked,
      notifyPayment: $('#setNotifyPayment').checked,
      notifyStatusChange: $('#setNotifyStatus').checked,
      notifyAdminChanges: $('#setNotifyChanges').checked
    };
    // Only send the key when a new one has actually been typed.
    if ($('#setEmailKey').value) body.emailApiKey = $('#setEmailKey').value.trim();
    try {
      await api('/admin/settings', { method: 'PUT', body });
      $('#setEmailKey').value = '';
      $('#reportSettingsMsg').innerHTML = '<div class="notice notice--ok">Report settings saved.</div>';
      await refresh();
      toast('Report settings saved ♡');
    } catch (err) {
      $('#reportSettingsMsg').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    }
  }

  const GROUP_TONE = {
    products: 'blush', stock: 'gold', orders: 'ink',
    payments: 'ok', customers: 'blush', settings: 'muted', security: 'bad'
  };

  function renderActivity(entries) {
    const box = $('#activityFeed');
    if (!entries.length) {
      box.innerHTML = '<p class="empty-line">Nothing recorded yet. Every change you make will appear here.</p>';
      return;
    }
    box.innerHTML = entries.map((a) => {
      const when = new Date(a.at);
      const changes = (a.changes || []).length
        ? `<div class="act__changes">${a.changes.map((c) =>
            `<span class="act__change"><i>${esc(c.label)}</i> ${esc(c.from ?? '—')} → <b>${esc(c.to ?? '—')}</b></span>`
          ).join('')}</div>`
        : '';
      return `
        <div class="act ${a.read ? '' : 'act--unread'}">
          <div class="act__when">
            <b>${when.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}</b>
            <span>${when.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' })}</span>
          </div>
          <div class="act__body">
            <span class="act__tag act__tag--${GROUP_TONE[a.group] || 'muted'}">${esc(a.label)}</span>
            ${a.target ? `<b class="act__target">${esc(a.target)}</b>` : ''}
            <div class="act__summary">${esc(a.summary)}</div>
            ${changes}
          </div>
          <div class="act__actor">${esc(a.actor)}</div>
        </div>`;
    }).join('');
  }

  function renderReport(r) {
    const m = (n) => money(n);
    $('#reportStats').innerHTML = `
      <div class="stat"><span>Orders</span><b>${r.orders.total}</b><small>${r.orders.pending} still pending</small></div>
      <div class="stat stat--ok"><span>Revenue</span><b>${m(r.orders.revenue)}</b><small>Confirmed &amp; delivered</small></div>
      <div class="stat"><span>Confirmed</span><b>${r.orders.confirmed}</b><small>${r.orders.delivered} delivered</small></div>
      <div class="stat${r.orders.cancelled ? ' stat--bad' : ''}"><span>Cancelled</span><b>${r.orders.cancelled}</b><small>Stock returned automatically</small></div>
      <div class="stat"><span>Paid by M-Pesa</span><b>${r.orders.paidOnline}</b><small>${m(r.orders.paidOnlineValue)} collected</small></div>
      <div class="stat"><span>New customers</span><b>${r.customers.newInPeriod}</b><small>${r.customers.total} registered in total</small></div>`;

    $('#reportTop').innerHTML = r.topProducts.length
      ? `<table class="table"><tbody>${r.topProducts.map((p) => `
          <tr><td>${esc(p.name)}</td><td class="num">${p.qty} sold</td><td class="num">${m(p.value)}</td></tr>`).join('')}
         </tbody></table>`
      : '<p class="empty-line">Nothing sold in this period.</p>';

    const alerts = [
      ...r.stock.outOfStock.map((p) => ({ name: p.name, note: 'Out of stock', tone: 'bad' })),
      ...r.stock.lowStock.map((p) => ({ name: p.name, note: `Only ${p.stock} left`, tone: 'gold' }))
    ];
    $('#reportStock').innerHTML = alerts.length
      ? `<table class="table"><tbody>${alerts.map((a) => `
          <tr><td>${esc(a.name)}</td><td class="num"><span class="tag tag--${a.tone}">${esc(a.note)}</span></td></tr>`).join('')}
         </tbody></table>`
      : '<p class="empty-line">Every product is in stock ♡</p>';
  }

  async function loadActivity() {
    try {
      const group = $('#activityGroup').value;
      const [act, rep] = await Promise.all([
        api(`/admin/activity${group ? `?group=${encodeURIComponent(group)}` : ''}`),
        api(`/admin/report?period=${encodeURIComponent($('#reportPeriod').value)}`)
      ]);
      renderActivity(act.entries || []);
      renderReport(rep.report);
      renderCostCoverage();
      setActivityBadge(act.unread || 0);
    } catch (err) {
      $('#activityFeed').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    }
  }

  function setActivityBadge(n) {
    const badge = $('#badgeActivity');
    badge.textContent = n;
    badge.hidden = !n;
  }

  async function markActivityRead() {
    try {
      await api('/admin/activity/read', { method: 'POST' });
      setActivityBadge(0);
      await loadActivity();
    } catch { /* the badge will correct itself on the next refresh */ }
  }

  async function emailReport() {
    const btn = $('#sendReport');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await api('/admin/report/send', {
        method: 'POST', body: { period: $('#reportPeriod').value }
      });
      $('#reportMsg').innerHTML = `<div class="notice notice--ok">Report sent to ${esc(res.to)}.</div>`;
      toast('Report emailed ♡');
    } catch (err) {
      $('#reportMsg').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Email me this report';
    }
  }

  /* -------------------------------------------------- books & downloads */

  // Downloads have to carry the admin token, and a plain <a href> cannot set a
  // header — so fetch the file, then hand the browser a blob to save. This also
  // keeps the token out of the URL, where it would end up in server logs.
  async function fetchAsBlob(path) {
    const res = await fetch(`/api${path}`, {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
    });
    if (res.status === 401) { signOut(true); throw new Error('Session expired'); }
    if (!res.ok) {
      let msg = 'Could not build that file';
      try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1];
    return { blob: await res.blob(), name };
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const exportPath = (what, format) => {
    const period = $('#finPeriod') ? $('#finPeriod').value : '30d';
    const q = new URLSearchParams({ format });
    if (what === 'financials') q.set('period', period);
    return `/admin/export/${what}?${q}`;
  };

  async function downloadExport(what) {
    $('#exportMsg').innerHTML = '';
    try {
      const { blob, name } = await fetchAsBlob(exportPath(what, 'csv'));
      saveBlob(blob, name || `tessora-${what}.csv`);
      toast('Download started ♡');
    } catch (err) {
      $('#exportMsg').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    }
  }

  /** Open a printable statement in its own tab. */
  async function openStatement(what) {
    $('#exportMsg').innerHTML = '';
    // Opened before the await: browsers block window.open once the click has
    // been forgotten, which an awaited fetch is long enough to cause.
    const tab = window.open('', '_blank');
    try {
      const { blob } = await fetchAsBlob(exportPath(what, 'html'));
      const url = URL.createObjectURL(blob);
      if (tab) tab.location = url;
      else saveBlob(blob, `tessora-${what}.html`);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      if (tab) tab.close();
      $('#exportMsg').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    }
  }

  /** Warn, gently, when profit figures would be built on missing cost prices. */
  function renderCostCoverage() {
    const el = $('#costCoverage');
    if (!el) return;
    const products = state.products || [];
    const withCost = products.filter((p) => Number(p.costPrice) > 0).length;
    if (!products.length) { el.textContent = ''; el.className = 'tag'; return; }
    if (withCost === products.length) {
      el.textContent = 'Cost prices complete';
      el.className = 'tag tag--ok';
    } else {
      el.textContent = `${products.length - withCost} of ${products.length} missing a cost price`;
      el.className = 'tag tag--gold';
    }
  }

  /* ------------------------------------------------------ live updates */

  // The panel keeps itself current: orders, stock and activity arrive without
  // anyone pressing refresh. Netlify runs the API as functions, so there is no
  // socket to hold open — this polls, but only while the tab is actually being
  // looked at, and never while the shop owner is in the middle of something.
  const LIVE_INTERVAL = 12000;
  let liveTimer = null;
  let liveFailures = 0;

  /** True when a refresh would yank something out from under the user. */
  function midEdit() {
    if (document.querySelector('.modal.is-open')) return true;
    const el = document.activeElement;
    return Boolean(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  function setLiveStatus(ok, note) {
    const el = $('#liveStatus');
    if (!el) return;
    el.innerHTML = `<span class="live-dot${ok ? '' : ' live-dot--stale'}"></span>${esc(note)}`;
  }

  async function liveTick() {
    if (document.visibilityState !== 'visible' || !state.token || midEdit()) return;
    try {
      await refresh({ live: true });
      // Keep whichever tab is open in step with the new data.
      if ($('#panel-activity').classList.contains('is-active')) await loadActivity();
      liveFailures = 0;
      setLiveStatus(true, `Live · ${new Date().toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' })}`);
    } catch {
      // A dropped request is normal on mobile data; only say so if it persists.
      if (++liveFailures >= 2) setLiveStatus(false, 'Reconnecting…');
    }
  }

  function startLiveUpdates() {
    clearInterval(liveTimer);
    liveTimer = setInterval(liveTick, LIVE_INTERVAL);
    // Coming back to the tab should feel instant, not up to 12s stale.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') liveTick();
    });
    window.addEventListener('online', liveTick);
    setLiveStatus(true, 'Live');
  }

  function stopLiveUpdates() {
    clearInterval(liveTimer);
    liveTimer = null;
  }

  /* -------------------------------------------------------------- tabs */
  function showTab(tab) {
    if (tab === 'activity') loadActivity();
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${tab}`));
    $$('.side__link').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    $('#side').classList.remove('is-open');
    $('#sideBackdrop').hidden = true;
    $('#menuToggle').setAttribute('aria-expanded', 'false');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------ wiring */
  function wire() {
    $('#loginForm').addEventListener('submit', signIn);
    $('#logout').addEventListener('click', () => signOut());
    // The slide-out menu on phones: a backdrop behind it, so a tap anywhere
    // else (or Escape) closes it instead of forcing a tab choice.
    const setMenu = (open) => {
      $('#side').classList.toggle('is-open', open);
      $('#sideBackdrop').hidden = !open;
      $('#menuToggle').setAttribute('aria-expanded', String(open));
    };
    $('#menuToggle').addEventListener('click', () => setMenu(!$('#side').classList.contains('is-open')));
    $('#sideBackdrop').addEventListener('click', () => setMenu(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#side').classList.contains('is-open')) setMenu(false);
    });

    ['#prodSearch', '#prodCategory', '#prodStatus'].forEach((sel) =>
      $(sel).addEventListener('input', renderProducts));
    $('#invFilter').addEventListener('change', renderInventory);
    $('#orderFilter').addEventListener('change', renderOrders);

    $('#pmSave').addEventListener('click', saveProduct);
    $('#pmPrice').addEventListener('input', updatePricePreview);
    $('#pmDiscount').addEventListener('input', updatePricePreview);
    $('#productForm').addEventListener('submit', (e) => { e.preventDefault(); saveProduct(); });

    $('#settingsForm').addEventListener('submit', saveSettings);
    $('#passwordForm').addEventListener('submit', changePassword);
    $('#mpesaForm').addEventListener('submit', saveMpesa);
    $('#reportForm').addEventListener('submit', saveReportSettings);
    $('#sendReport').addEventListener('click', emailReport);
    $('#markRead').addEventListener('click', markActivityRead);
    $('#activityGroup').addEventListener('change', loadActivity);
    $('#reportPeriod').addEventListener('change', loadActivity);

    // the books: statements open in a tab, spreadsheets download
    document.addEventListener('click', (e) => {
      const stmt = e.target.closest('[data-statement]');
      if (stmt) { openStatement(stmt.dataset.statement); return; }
      const dl = e.target.closest('[data-download]');
      if (dl) downloadExport(dl.dataset.download);
    });

    // image upload: click, file picker, drag & drop
    $('#pmDrop').addEventListener('click', () => $('#pmFiles').click());
    $('#pmFiles').addEventListener('change', (e) => { readFiles(e.target.files); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => $('#pmDrop').addEventListener(ev, (e) => {
      e.preventDefault(); $('#pmDrop').classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => $('#pmDrop').addEventListener(ev, (e) => {
      e.preventDefault(); $('#pmDrop').classList.remove('is-over');
    }));
    $('#pmDrop').addEventListener('drop', (e) => readFiles(e.dataTransfer.files));

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
    $$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));

    document.addEventListener('change', (e) => {
      const id = e.target.dataset.orderStatus;
      if (id) setOrderStatus(id, e.target.value);
      const stockId = e.target.dataset.stockSet;
      if (stockId) patchProduct(stockId, { stock: Number(e.target.value) || 0 }, 'Stock updated');
      // Buying price, edited straight in the inventory table so a whole
      // catalogue can be costed without opening every product.
      const costId = e.target.dataset.costSet;
      if (costId) patchProduct(costId, { costPrice: Number(e.target.value) || 0 }, 'Buying price saved');
    });

    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab],[data-new-product],[data-edit],[data-delete],[data-toggle],'
        + '[data-restock],[data-restock50],[data-stock-inc],[data-stock-dec],[data-order],'
        + '[data-close-modal],[data-drop-existing],[data-drop-new]');
      if (!t) return;
      const d = t.dataset;

      if (d.tab) return showTab(d.tab);
      if (d.newProduct !== undefined) return openProductModal();
      if (d.closeModal !== undefined) return closeModals();
      if (d.edit) return openProductModal(state.products.find((p) => p.id === d.edit));
      if (d.delete) return deleteProduct(d.delete);
      if (d.order) return openOrder(d.order);

      if (d.toggle) {
        const p = state.products.find((x) => x.id === d.toggle);
        return patchProduct(d.toggle, { active: !p.active }, p.active ? 'Product hidden' : 'Product published');
      }
      if (d.restock) return patchProduct(d.restock, { stockDelta: 10 }, 'Added 10 units');
      if (d.restock50) return patchProduct(d.restock50, { stockDelta: 50 }, 'Added 50 units');
      if (d.stockInc) return patchProduct(d.stockInc, { stockDelta: 1 });
      if (d.stockDec) return patchProduct(d.stockDec, { stockDelta: -1 });

      if (d.dropExisting !== undefined) {
        state.keptImages.splice(Number(d.dropExisting), 1);
        return renderPreviews();
      }
      if (d.dropNew !== undefined) {
        state.newImages.splice(Number(d.dropNew), 1);
        return renderPreviews();
      }
    });
  }

  /* -------------------------------------------------------------- boot */
  wire();
  if (state.token) {
    api('/admin/overview')
      .then(() => start())
      .catch(() => { /* token stale — the login screen stays */ });
  }
})();
