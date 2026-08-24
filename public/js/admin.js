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
  }

  /* ------------------------------------------------------------ loading */
  async function refresh() {
    const data = await api('/admin/overview');
    Object.assign(state, {
      settings: data.settings, categories: data.categories,
      products: data.products, orders: data.orders, stats: data.stats
    });
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
    fillSettings();
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
        <td><div class="prod-cell prod-cell--edit" data-edit="${p.id}" title="Click to edit ${esc(p.name)}">
          ${thumb(p)}
          <div><b>${esc(p.name)}</b><small>${esc(p.brand || p.sku)}</small></div>
          <svg class="prod-cell__pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </div></td>
        <td>${esc(p.category)}</td>
        <td class="t-right">${money(p.price)}</td>
        <td class="t-center">${p.discount > 0 ? `<span class="pill pill--sale">-${p.discount}%</span>` : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="t-right"><b>${money(p.salePrice)}</b></td>
        <td class="t-center">${stockPill(p)}</td>
        <td class="t-center">${p.active ? '<span class="pill pill--ok">Live</span>' : '<span class="pill pill--muted">Hidden</span>'}</td>
        <td class="t-right" style="white-space:nowrap">
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
        <td><div class="prod-cell prod-cell--edit" data-edit="${p.id}" title="Click to edit ${esc(p.name)}">
          ${thumb(p)}
          <div><b>${esc(p.name)}</b><small>${esc(p.category)}</small></div>
          <svg class="prod-cell__pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </div></td>
        <td><small style="color:var(--muted)">${esc(p.sku)}</small></td>
        <td class="t-center">${stockPill(p)}</td>
        <td class="t-center">
          <div class="stock-edit">
            <button data-stock-dec="${p.id}" aria-label="Decrease">−</button>
            <input type="number" min="0" value="${p.stock}" data-stock-set="${p.id}">
            <button data-stock-inc="${p.id}" aria-label="Increase">+</button>
          </div>
        </td>
        <td class="t-right">${money(p.salePrice * p.stock)}</td>
        <td class="t-right" style="white-space:nowrap">
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
        <td><b>${esc(o.code)}</b><br><small style="color:var(--muted)">${dateFmt(o.createdAt)}</small></td>
        <td>${esc(o.customer.name)}<br><small style="color:var(--muted)">${esc(o.customer.phone)}</small></td>
        <td>${o.items.length} item${o.items.length === 1 ? '' : 's'}<br>
            <small style="color:var(--muted)">${esc(o.items.map((i) => `${i.name} x${i.qty}`).join(', ').slice(0, 46))}${o.items.map((i) => i.name).join(', ').length > 46 ? '…' : ''}</small></td>
        <td class="t-right"><b>${money(o.total)}</b></td>
        <td class="t-center">${statusPill(o.status)}</td>
        <td class="t-right" style="white-space:nowrap">
          <button class="btn btn--light btn--sm" data-order="${o.id}">View</button>
          <select class="input" data-order-status="${o.id}" style="width:auto;display:inline-block;padding:.35rem .6rem;font-size:.76rem">
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
          <p>${dateFmt(o.createdAt)}<br>${statusPill(o.status)}</p>
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
        <div class="list__row"><span>Delivery</span><span class="right">${o.deliveryFee === 0 ? 'Free' : money(o.deliveryFee)}</span></div>
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
          freeDeliveryOver: $('#setFreeOver').value, lowStockThreshold: $('#setThreshold').value
        }
      });
      await refresh();
      toast('Settings saved ♡');
    } catch (err) { toast(err.message, true); }
  }

  async function changePassword(event) {
    event.preventDefault();
    const next = $('#pwNew').value;
    if (next !== $('#pwConfirm').value) {
      $('#passwordMsg').innerHTML = '<div class="notice notice--error">The new passwords do not match.</div>';
      return;
    }
    try {
      await api('/admin/password', {
        method: 'PUT',
        body: { currentPassword: $('#pwCurrent').value, newPassword: next }
      });
      $('#passwordForm').reset();
      $('#passwordMsg').innerHTML = '<div class="notice notice--ok">Password changed successfully.</div>';
      $('#globalNotice').innerHTML = '';
      toast('Password updated');
    } catch (err) {
      $('#passwordMsg').innerHTML = `<div class="notice notice--error">${esc(err.message)}</div>`;
    }
  }

  /* -------------------------------------------------------------- tabs */
  function showTab(tab) {
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${tab}`));
    $$('.side__link').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
    $('#side').classList.remove('is-open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------ wiring */
  function wire() {
    $('#loginForm').addEventListener('submit', signIn);
    $('#logout').addEventListener('click', () => signOut());
    $('#menuToggle').addEventListener('click', () => $('#side').classList.toggle('is-open'));

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
