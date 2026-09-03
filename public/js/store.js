/* Tessora Beauty — storefront logic (vanilla JS, no build step) */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const CART_KEY = 'tessora.cart.v1';
  const AUTH_KEY = 'tessora.auth.v1';

  const state = {
    settings: {},
    products: [],
    categories: [],
    cart: loadCart(),
    auth: { token: loadToken(), customer: null, orders: [] },
    filter: { category: 'all', query: '', sort: 'new', inStock: false, onSale: false },
    checkout: {
      // M-Pesa is the only way to pay — the shop does not take cash on delivery.
      coords: null,        // { lat, lng } chosen on the map
      quote: null,         // { fee, distanceKm, basis } from /api/delivery/quote
      map: null, marker: null, geocoder: null,
      mapsLoading: null,   // a Promise while the Google script loads
      addressTouched: false // true once the buyer types their own location
    }
  };

  const CAT_ICONS = {
    'Lip Products': '💄', 'Makeup': '🎨', 'Skincare': '🧴', 'Body Care': '🫧',
    'Perfumes & Mists': '🌸', 'Hair Care': '💇🏽‍♀️', 'Beauty Accessories': '🖌️', 'Gift Sets': '🎁'
  };

  /* ------------------------------------------------------------ helpers */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const money = (n) => `${state.settings.currency || 'KSh'} ${Number(n || 0).toLocaleString('en-KE')}`;

  function loadCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
    catch { return []; }
  }

  /* -------------------------------------------------------------- account */
  function loadToken() {
    try { return localStorage.getItem(AUTH_KEY) || ''; }
    catch { return ''; }
  }
  function saveToken(token) {
    state.auth.token = token || '';
    try {
      if (token) localStorage.setItem(AUTH_KEY, token);
      else localStorage.removeItem(AUTH_KEY);
    } catch { /* private browsing — the session just won't be remembered */ }
  }

  const signedIn = () => Boolean(state.auth.token && state.auth.customer);

  /** fetch() with the signed-in customer's token attached. */
  function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (state.auth.token) headers.Authorization = `Bearer ${state.auth.token}`;
    return fetch(url, { ...options, headers });
  }
  function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
    renderCartCount();
  }

  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-open'), 2600);
  }

  const findProduct = (id) => state.products.find((p) => p.id === id);

  function stockLabel(p) {
    const low = state.settings.lowStockThreshold || 5;
    if (p.stock <= 0) return { cls: 'stock--out', text: 'Out of stock' };
    if (p.stock <= low) return { cls: 'stock--low', text: `Low stock, only ${p.stock} left` };
    return { cls: 'stock--in', text: `${p.stock} in stock` };
  }

  const isNew = (p) => (Date.now() - new Date(p.createdAt).getTime()) < 14 * 864e5;

  function waLink(text) {
    const phone = (state.settings.whatsapp || '').replace(/\D/g, '');
    return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
  }

  /* -------------------------------------------------------------- boot */
  async function boot() {
    try {
      const res = await fetch('/api/storefront');
      const data = await res.json();
      state.settings = data.settings || {};
      state.products = data.products || [];
      state.categories = data.categories || [];
    } catch {
      toast('Could not load the shop. Please refresh.');
    }
    applyBranding();
    renderCategories();
    renderChips();
    render();
    renderCartCount();
    wire();
    await refreshAccount();   // restores the session if they signed in before
    startLiveStock();
  }

  /**
   * Keep the shop honest: stock counts, prices and offers are re-read from the
   * server so a customer never adds something that sold out while they browsed.
   * Only while the tab is visible, and never mid-checkout — re-rendering under
   * an open drawer would throw away what they were doing.
   */
  function startLiveStock() {
    const EVERY = 30000;
    setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      if (document.querySelector('.drawer.is-open, .modal.is-open')) return;
      const before = JSON.stringify(state.products.map((p) => [p.id, p.stock, p.salePrice]));
      await refreshProducts();
      const after = JSON.stringify(state.products.map((p) => [p.id, p.stock, p.salePrice]));
      if (before !== after) { render(); renderCartCount(); }
    }, EVERY);

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      if (document.querySelector('.drawer.is-open, .modal.is-open')) return;
      await refreshProducts();
      render();
      renderCartCount();
    });
  }

  function applyBranding() {
    const s = state.settings;
    document.title = `${s.storeName || 'Tessora Beauty'} — ${s.tagline || 'Your Beauty. Your Aura.'}`;
    $('#announce').textContent = s.announcement || '';
    $('#announce').hidden = !s.announcement;
    $('#brandName').textContent = (s.storeName || 'Tessora').split(' ')[0];
    $('#brandTag').textContent = s.tagline || '';
    $('#heroTag').textContent = s.tagline || '';
    $('#footLocation').textContent = s.location || '';
    $('#year').textContent = new Date().getFullYear();
    $('#statProducts').textContent = state.products.length || '—';
    $('#statCats').textContent = new Set(state.products.map((p) => p.category)).size || '—';

    const hello = waLink(`Hi ${s.storeName || 'Tessora Beauty'} ♡ I'd like to make an order.`);
    ['#waFloat', '#footWa', '#socialWa'].forEach((sel) => { $(sel).href = hello; });
    $('#socialIg').href = s.instagram ? `https://instagram.com/${s.instagram}` : '#';
    $('#socialTt').href = s.tiktok ? `https://tiktok.com/@${s.tiktok}` : '#';
    $('#footPhone').textContent = s.whatsapp ? `+${s.whatsapp}` : '';
  }

  /* --------------------------------------------------------- rendering */
  function renderCategories() {
    const counts = new Map();
    state.products.forEach((p) => counts.set(p.category, (counts.get(p.category) || 0) + 1));
    $('#catGrid').innerHTML = state.categories.map((c) => `
      <button class="cat" data-cat="${esc(c)}">
        <div class="cat__icon">${CAT_ICONS[c] || '♡'}</div>
        <b>${esc(c)}</b>
        <span>${counts.get(c) || 0} product${(counts.get(c) || 0) === 1 ? '' : 's'}</span>
      </button>`).join('');
  }

  function renderChips() {
    const all = ['all', ...state.categories];
    $('#chips').innerHTML = all.map((c) => `
      <button class="chip${state.filter.category === c ? ' is-active' : ''}" data-chip="${esc(c)}">
        ${c === 'all' ? 'All products' : esc(c)}
      </button>`).join('');
  }

  function cardHTML(p) {
    const stock = stockLabel(p);
    const out = p.stock <= 0;
    const img = p.images && p.images[0]
      ? `<img src="${esc(p.images[0])}" alt="${esc(p.name)}" loading="lazy">`
      : `<div class="card__ph">${esc(p.name.charAt(0).toUpperCase())}</div>`;

    return `
      <article class="card${out ? ' is-out' : ''}" data-id="${p.id}">
        <div class="card__media" data-view="${p.id}">
          ${img}
          <div class="badges">
            ${p.discount > 0 ? `<span class="badge badge--sale">${p.discount}% off</span>` : ''}
            ${p.featured ? '<span class="badge badge--star">Bestseller</span>' : ''}
            ${isNew(p) && !p.discount ? '<span class="badge badge--new">New in</span>' : ''}
          </div>
        </div>
        <div class="card__body">
          <span class="card__cat">${esc(p.category)}</span>
          <h3 class="card__title">${esc(p.name)}</h3>
          ${p.brand ? `<span class="card__brand">${esc(p.brand)}</span>` : ''}
          <div class="price">
            <span class="price__now">${money(p.salePrice)}</span>
            ${p.discount > 0 ? `<span class="price__was">${money(p.price)}</span>
              <span class="price__off">Save ${money(p.price - p.salePrice)}</span>` : ''}
          </div>
          <span class="stock ${stock.cls}">${stock.text}</span>
          <div class="card__foot">
            <button class="btn ${out ? 'btn--outline' : 'btn--dark'} btn--sm btn--block"
                    data-add="${p.id}" ${out ? 'disabled' : ''}>
              ${out ? 'Sold out' : 'Add to bag'}
            </button>
          </div>
        </div>
      </article>`;
  }

  function visibleProducts() {
    const f = state.filter;
    const q = f.query.trim().toLowerCase();
    let list = state.products.filter((p) => {
      if (f.category !== 'all' && p.category !== f.category) return false;
      if (f.inStock && p.stock <= 0) return false;
      if (f.onSale && !(p.discount > 0)) return false;
      if (!q) return true;
      return `${p.name} ${p.brand} ${p.category} ${p.description}`.toLowerCase().includes(q);
    });

    const sorters = {
      'price-asc': (a, b) => a.salePrice - b.salePrice,
      'price-desc': (a, b) => b.salePrice - a.salePrice,
      discount: (a, b) => b.discount - a.discount,
      name: (a, b) => a.name.localeCompare(b.name),
      new: (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    };
    return list.sort(sorters[f.sort] || sorters.new);
  }

  function render() {
    const list = visibleProducts();
    $('#grid').innerHTML = list.map(cardHTML).join('');
    $('#emptyState').hidden = list.length > 0;
    $('#resultCount').textContent = `${list.length} product${list.length === 1 ? '' : 's'}`;

    const deals = state.products
      .filter((p) => p.discount > 0)
      .sort((a, b) => b.discount - a.discount)
      .slice(0, 8);
    $('#dealsGrid').innerHTML = deals.map(cardHTML).join('');
    $('#dealsEmpty').hidden = deals.length > 0;
  }

  /* -------------------------------------------------------------- cart */
  function cartLines() {
    return state.cart
      .map((line) => ({ line, product: findProduct(line.id) }))
      .filter((x) => x.product);
  }

  function cartTotals() {
    const subtotal = cartLines().reduce((s, { line, product }) => s + product.salePrice * line.qty, 0);
    const freeOver = Number(state.settings.freeDeliveryOver || 0);
    const flat = Number(state.settings.deliveryFee || 0);
    const q = state.checkout.quote;
    let delivery;
    let estimated = false;
    if (subtotal === 0) delivery = 0;
    else if (freeOver > 0 && subtotal >= freeOver) delivery = 0;
    else if (q) delivery = q.fee;                 // exact fee for the chosen point
    else { delivery = flat; estimated = true; }   // shown until a point is picked
    return { subtotal, delivery, total: subtotal + delivery, freeOver, estimated };
  }

  function renderCartCount() {
    const count = state.cart.reduce((s, l) => s + l.qty, 0);
    const el = $('#cartCount');
    el.textContent = count;
    el.hidden = count === 0;
  }

  function addToCart(id, qty = 1) {
    const product = findProduct(id);
    if (!product) return;
    if (product.stock <= 0) return toast('That item is sold out.');

    const existing = state.cart.find((l) => l.id === id);
    const wanted = (existing ? existing.qty : 0) + qty;
    if (wanted > product.stock) return toast(`Only ${product.stock} left in stock.`);

    if (existing) existing.qty = wanted;
    else state.cart.push({ id, qty });
    saveCart();
    renderCart();
    toast(`${product.name} added to your bag ♡`);
  }

  function setQty(id, qty) {
    const product = findProduct(id);
    const line = state.cart.find((l) => l.id === id);
    if (!line || !product) return;
    if (qty <= 0) state.cart = state.cart.filter((l) => l.id !== id);
    else if (qty > product.stock) { toast(`Only ${product.stock} in stock.`); return; }
    else line.qty = qty;
    saveCart();
    renderCart();
  }

  function renderCart() {
    const lines = cartLines();
    const body = $('#cartBody');
    const foot = $('#cartFoot');

    if (!lines.length) {
      body.innerHTML = `<div class="empty"><div class="empty__mark">♡</div>
        <h3>Your bag is empty</h3><p>Add a few favourites and they'll show up here.</p></div>`;
      foot.innerHTML = `<button class="btn btn--outline btn--block" data-close-cart>Continue shopping</button>`;
      return;
    }

    body.innerHTML = lines.map(({ line, product }) => `
      <div class="line">
        ${product.images[0]
          ? `<img class="line__img" src="${esc(product.images[0])}" alt="">`
          : `<div class="line__ph">${esc(product.name.charAt(0))}</div>`}
        <div>
          <b>${esc(product.name)}</b>
          <small>${money(product.salePrice)} each · ${product.stock} in stock</small>
          <div class="qty" style="margin-top:.4rem">
            <button data-dec="${product.id}" aria-label="Decrease">−</button>
            <span>${line.qty}</span>
            <button data-inc="${product.id}" aria-label="Increase">+</button>
          </div>
        </div>
        <div class="line__right">
          <b>${money(product.salePrice * line.qty)}</b>
          <button class="link-danger" data-remove="${product.id}">Remove</button>
        </div>
      </div>`).join('');

    const t = cartTotals();
    foot.innerHTML = `
      <div class="totals">
        <div><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        <div><span>Delivery</span><span>${t.delivery === 0 ? 'Free' : money(t.delivery)}</span></div>
        ${t.freeOver > 0 && t.subtotal < t.freeOver
          ? `<div style="font-size:.8rem;color:var(--rose)"><span>Spend ${money(t.freeOver - t.subtotal)} more for free delivery</span><span></span></div>`
          : ''}
        <div class="grand"><span>Total</span><span>${money(t.total)}</span></div>
      </div>
      <button class="btn btn--gold btn--block" id="toCheckout">Checkout</button>
      <a class="btn btn--outline btn--block" style="margin-top:.5rem" id="waOrder" target="_blank" rel="noopener">Order on WhatsApp instead</a>`;

    $('#waOrder').href = waLink(cartMessage());
    $('#toCheckout').addEventListener('click', openCheckout);
  }

  function cartMessage(customer) {
    const t = cartTotals();
    const items = cartLines()
      .map(({ line, product }) => `• ${product.name} x${line.qty}: ${money(product.salePrice * line.qty)}`)
      .join('\n');
    const who = customer
      ? `\n\nName: ${customer.name}\nPhone: ${customer.phone}${customer.location ? `\nLocation: ${customer.location}` : ''}${customer.notes ? `\nNotes: ${customer.notes}` : ''}`
      : '';
    return `Hi ${state.settings.storeName || 'Tessora Beauty'} ♡ I'd like to order:\n\n${items}\n\n`
      + `Subtotal: ${money(t.subtotal)}\nDelivery: ${t.delivery === 0 ? 'Free' : money(t.delivery)}\n`
      + `Total: ${money(t.total)}${who}`;
  }

  /* ------------------------------------------------------- account view */

  function renderAccount() {
    const on = signedIn();
    $('#accountAuth').hidden = on;
    $('#accountPanel').hidden = !on;
    $('#acctDot').hidden = !on;
    $('#accountTitle').textContent = on ? 'Your account' : 'Sign in';

    // Who is signed in, shown in the header so it is never a guess.
    const who = $('#acctWho');
    who.hidden = !on;
    who.textContent = on ? state.auth.customer.name.split(' ')[0] : '';
    $('#accountOpen').setAttribute('aria-label',
      on ? `Your account — signed in as ${state.auth.customer.name}` : 'Sign in to your account');

    // The checkout is only open to people with an account.
    $('#checkoutGate').hidden = on;
    $('#checkoutForm').hidden = !on;
    $('#signedAs').hidden = !on;

    if (!on) return;

    const c = state.auth.customer;
    $('#acctName').textContent = c.name;
    $('#acctMeta').textContent = `${c.email} · ${c.phone}`;
    $('#acctAddress').textContent = c.address && c.address.location
      ? `Saved location: ${c.address.location}` : '';
    $('#signedAs').innerHTML =
      `Ordering as <b>${esc(c.name)}</b> · <button type="button" class="linkish" id="signedAsSwitch">not you?</button>`;

    renderAccountOrders();
  }

  function renderAccountOrders() {
    const box = $('#acctOrders');
    const orders = state.auth.orders || [];
    if (!orders.length) {
      box.innerHTML = '<p class="acct-empty">No orders yet. Everything you buy will show up here.</p>';
      return;
    }
    box.innerHTML = orders.map((o) => `
      <div class="acct-order">
        <div class="acct-order__top">
          <b>${esc(o.code)}</b>
          <span class="pill pill--${esc(o.status)}">${esc(o.status)}</span>
        </div>
        <div class="acct-order__meta">
          ${new Date(o.createdAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })}
          · ${o.items.reduce((n, i) => n + i.qty, 0)} item(s) · <b>${money(o.total)}</b>
        </div>
        ${o.delivery && o.delivery.label
          ? `<div class="acct-order__meta">Arrives: ${esc(o.delivery.label)}</div>` : ''}
        ${o.payment && o.payment.status === 'paid'
          ? `<div class="acct-order__paid">Paid${o.payment.receipt ? ` · ${esc(o.payment.receipt)}` : ''}</div>` : ''}
        <a class="btn btn--outline btn--sm" href="/api/orders/${esc(o.id)}/receipt" target="_blank" rel="noopener">View receipt</a>
      </div>`).join('');
  }

  /** Load the signed-in customer and their orders; sign out if the token died. */
  async function refreshAccount() {
    if (!state.auth.token) { renderAccount(); return; }
    try {
      const res = await api('/api/account/me');
      if (!res.ok) { saveToken(''); state.auth.customer = null; renderAccount(); return; }
      const data = await res.json();
      state.auth.customer = data.customer;
      state.auth.orders = data.orders || [];
    } catch {
      // Offline: keep whatever we already had rather than signing them out.
    }
    renderAccount();
  }

  function accountMessage(html, kind = 'error') {
    $('#accountMsg').innerHTML = html
      ? `<div class="notice notice--${kind}">${html}</div>` : '';
  }

  function showAuthPane(which) {
    document.querySelectorAll('.auth-tab').forEach((t) =>
      t.classList.toggle('is-active', t.dataset.auth === which));
    $('#loginForm').hidden = which !== 'login';
    $('#registerForm').hidden = which !== 'register';
    accountMessage('');
  }

  async function submitRegister(event) {
    event.preventDefault();
    const btn = event.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('/api/account/register', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#rgName').value.trim(),
          email: $('#rgEmail').value.trim(),
          phone: $('#rgPhone').value.trim(),
          password: $('#rgPassword').value
        })
      });
      const data = await res.json();
      if (!res.ok) return accountMessage(esc(data.error || 'Could not create your account.'));
      saveToken(data.token);
      state.auth.customer = data.customer;
      state.auth.orders = [];
      accountMessage(`Welcome, ${esc(data.customer.name.split(' ')[0])} ♡`, 'ok');
      event.target.reset();
      renderAccount();
      prefillCheckout();
    } catch {
      accountMessage('Network problem — please try again.');
    } finally {
      btn.disabled = false;
    }
  }

  async function submitLogin(event) {
    event.preventDefault();
    const btn = event.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('/api/account/login', {
        method: 'POST',
        body: JSON.stringify({ email: $('#liEmail').value.trim(), password: $('#liPassword').value })
      });
      const data = await res.json();
      if (!res.ok) return accountMessage(esc(data.error || 'Could not sign you in.'));
      saveToken(data.token);
      state.auth.customer = data.customer;
      accountMessage(`Welcome back, ${esc(data.customer.name.split(' ')[0])} ♡`, 'ok');
      event.target.reset();
      await refreshAccount();
      prefillCheckout();
    } catch {
      accountMessage('Network problem — please try again.');
    } finally {
      btn.disabled = false;
    }
  }

  async function submitAccountPassword(event) {
    event.preventDefault();
    const btn = event.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('/api/account/me', {
        method: 'PUT',
        body: JSON.stringify({
          currentPassword: $('#acCurrent').value,
          password: $('#acNew').value
        })
      });
      const data = await res.json();
      if (!res.ok) return accountMessage(esc(data.error || 'Could not change your password.'));
      accountMessage('Password updated ♡', 'ok');
      event.target.reset();
      $('#acctPasswordForm').hidden = true;
    } catch {
      accountMessage('Network problem — please try again.');
    } finally {
      btn.disabled = false;
    }
  }

  function signOut() {
    saveToken('');
    state.auth.customer = null;
    state.auth.orders = [];
    accountMessage('');
    renderAccount();
    toast('Signed out.');
  }

  /** Copy the account's saved details into the checkout form. */
  function prefillCheckout() {
    const c = state.auth.customer;
    if (!c) return;
    if (!$('#coName').value) $('#coName').value = c.name || '';
    if (!$('#coPhone').value) $('#coPhone').value = c.phone || '';
    if (!$('#coLocation').value && c.address && c.address.location) {
      $('#coLocation').value = c.address.location;
    }
    if (!state.checkout.coords && c.address && c.address.lat && c.address.lng) {
      state.checkout.coords = { lat: c.address.lat, lng: c.address.lng };
      fetchQuote();
    }
  }

  /* ---------------------------------------------------------- checkout */
  function updateCheckoutTotals() {
    const t = cartTotals();
    const deliveryLabel = t.delivery === 0
      ? 'Free'
      : `${money(t.delivery)}${t.estimated ? ' (est.)' : ''}`;
    $('#checkoutTotals').innerHTML = `
      <div><span>Items (${state.cart.reduce((s, l) => s + l.qty, 0)})</span><span>${money(t.subtotal)}</span></div>
      <div><span>Delivery</span><span>${deliveryLabel}</span></div>
      <div class="grand"><span>Total</span><span>${money(t.total)}</span></div>`;
  }

  function openCheckout() {
    if (!cartLines().length) return toast('Your bag is empty.');
    closeDrawers();

    // Everything is paid by M-Pesa. When it is not switched on yet we say so
    // plainly rather than offering a way to pay later.
    $('#mpesaOffNotice').hidden = Boolean(state.settings.mpesaEnabled);

    // Prefill the M-Pesa number from the phone field if empty.
    if (!$('#coMpesaPhone').value) $('#coMpesaPhone').value = $('#coPhone').value;

    updateCheckoutTotals();
    $('#checkoutMsg').innerHTML = '';
    renderAccount();   // shows the sign-in gate when there is no account yet
    prefillCheckout();
    openDrawer('#checkoutDrawer');
    initMap(); // lazy — only builds once, only if a Maps key is set
  }

  /* --------------------------------------------------------- delivery map */
  function loadMaps() {
    if (window.google && window.google.maps) return Promise.resolve();
    if (!state.settings.mapsApiKey) return Promise.reject(new Error('no-key'));
    if (state.checkout.mapsLoading) return state.checkout.mapsLoading;
    state.checkout.mapsLoading = new Promise((resolve, reject) => {
      window.__tessoraMapsReady = () => resolve();
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js'
        + `?key=${encodeURIComponent(state.settings.mapsApiKey)}`
        + '&libraries=places&loading=async&callback=__tessoraMapsReady';
      s.async = true;
      s.onerror = () => reject(new Error('maps-failed'));
      document.head.appendChild(s);
    });
    return state.checkout.mapsLoading;
  }

  async function initMap() {
    if (!state.settings.mapsApiKey) return;         // no key: keep the text field only
    $('#mapSearchField').hidden = false;
    $('#mapWrap').hidden = false;
    try { await loadMaps(); } catch { $('#mapSearchField').hidden = true; $('#mapWrap').hidden = true; return; }
    if (state.checkout.map) return;                 // already built

    const center = {
      lat: Number(state.settings.storeLat) || -1.286389,
      lng: Number(state.settings.storeLng) || 36.817223
    };
    const map = new google.maps.Map($('#checkoutMap'), {
      center, zoom: 12, mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false
    });
    const marker = new google.maps.Marker({ map, position: center, draggable: true });
    state.checkout.map = map;
    state.checkout.marker = marker;
    state.checkout.geocoder = new google.maps.Geocoder();

    const setPoint = (latLng, fillAddress) => {
      marker.setPosition(latLng);
      map.panTo(latLng);
      state.checkout.coords = { lat: latLng.lat(), lng: latLng.lng() };
      if (fillAddress) reverseGeocode(latLng);
      fetchQuote();
    };
    marker.addListener('dragend', () => setPoint(marker.getPosition(), true));
    map.addListener('click', (e) => setPoint(e.latLng, true));

    const ac = new google.maps.places.Autocomplete($('#mapSearch'), {
      fields: ['geometry', 'formatted_address', 'name'],
      componentRestrictions: { country: 'ke' }
    });
    ac.bindTo('bounds', map);
    ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (!place.geometry) return;
      map.setZoom(15);
      setPoint(place.geometry.location, false);
      $('#coLocation').value = place.formatted_address || place.name || $('#coLocation').value;
      state.checkout.addressTouched = true;
    });
  }

  function reverseGeocode(latLng) {
    const g = state.checkout.geocoder;
    if (!g) return;
    g.geocode({ location: latLng }, (results, status) => {
      // Only auto-fill when the buyer hasn't typed their own address.
      if (status === 'OK' && results[0] && !state.checkout.addressTouched) {
        $('#coLocation').value = results[0].formatted_address;
      }
    });
  }

  async function fetchQuote() {
    const c = state.checkout.coords;
    if (!c) return;
    try {
      const res = await fetch('/api/delivery/quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: c.lat, lng: c.lng, subtotal: cartTotals().subtotal })
      });
      const data = await res.json();
      if (res.ok) {
        state.checkout.quote = data;
        showEstimate(data);
        updateCheckoutTotals();
      }
    } catch { /* leave the estimate as-is */ }
  }

  function showEstimate(q) {
    const el = $('#deliveryEstimate');
    el.hidden = false;
    el.className = 'notice notice--ok';

    // How the charge was worked out, so the price never looks arbitrary.
    let line;
    if (q.basis === 'free') line = '<b>Free delivery</b> to your location ♡';
    else if (q.basis === 'distance' && q.distanceKm != null) {
      line = `About <b>${q.distanceKm} km</b> away — ${q.distanceKm} × ${money(q.perKm)}/km`
        + `${q.baseFee ? ` + ${money(q.baseFee)} base` : ''} = <b>${money(q.fee)}</b>`;
    } else line = `Delivery: <b>${money(q.fee)}</b>`;

    const eta = q.label ? `<div class="est-eta">Arrives in <b>${esc(q.label)}</b></div>` : '';
    el.innerHTML = line + eta;
  }

  /* ---------------------------------------------------------- payment ui */
  async function submitOrder(event) {
    event.preventDefault();
    const btn = $('#placeOrder');
    const c = state.checkout.coords;

    // Ordering needs an account, so the shop can keep the order history and the
    // customer can come back to their receipts.
    if (!signedIn()) {
      closeDrawers();
      openDrawer('#accountDrawer');
      showAuthPane('register');
      return toast('Please create an account or sign in first.', true);
    }

    const customer = {
      name: $('#coName').value.trim(),
      phone: $('#coPhone').value.trim(),
      email: state.auth.customer.email,
      location: $('#coLocation').value.trim(),
      notes: $('#coNotes').value.trim(),
      lat: c ? c.lat : null,
      lng: c ? c.lng : null
    };

    // Phone and location are both required.
    if (!customer.phone) { $('#coPhone').focus(); return toast('Please enter your phone number.', true); }
    if (!customer.location) { $('#coLocation').focus(); return toast('Please enter your delivery location.', true); }

    btn.disabled = true;
    btn.textContent = 'Placing order…';

    try {
      // Sent with the account token so the order is tied to the customer.
      // Everything is paid by M-Pesa; there is no method to choose.
      const res = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({ customer, items: state.cart, paymentMethod: 'mpesa' })
      });
      const data = await res.json();

      if (!res.ok) {
        $('#checkoutMsg').innerHTML = `<div class="notice notice--error">${esc(data.error || 'Could not place the order.')}</div>`;
        if (data.productId) { await refreshProducts(); renderCart(); render(); }
        return;
      }

      // Build the WhatsApp message now, before the cart is cleared.
      const waMsg = cartMessage(customer) + `\n\nOrder no: ${data.order.code}`;
      state.cart = [];
      saveCart();
      await refreshProducts();
      render();
      renderCart();
      $('#checkoutTotals').innerHTML = '';
      toast(`Order ${data.order.code} placed ♡`);

      // Straight into the M-Pesa prompt. If the shop has not switched M-Pesa on
      // yet, the order is still saved and we point them at WhatsApp — we never
      // offer to settle it on delivery.
      if (state.settings.mpesaEnabled) {
        await payWithMpesa(data.order, waMsg);
      } else {
        $('#checkoutForm').reset();
        state.checkout.quote = null;
        $('#deliveryEstimate').hidden = true;
        $('#checkoutMsg').innerHTML = `
          <div class="notice notice--ok">
            <b>Thank you, ${esc(customer.name.split(' ')[0])}! ♡</b><br>
            Your order <b>${esc(data.order.code)}</b> has been saved.
            ${data.order.delivery && data.order.delivery.label
              ? `It should arrive in <b>${esc(data.order.delivery.label)}</b> once paid.` : ''}
            Send it on WhatsApp and we'll arrange your M-Pesa payment.
          </div>
          ${receiptButton(data.order)}
          <a class="btn btn--gold btn--block" style="margin-bottom:1rem"
             href="${esc(waLink(waMsg))}" target="_blank" rel="noopener">Send order on WhatsApp</a>`;
        refreshAccount();
      }
    } catch {
      $('#checkoutMsg').innerHTML = `<div class="notice notice--error">Network problem — please try again.</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Place order & pay';
    }
  }

  /* -------------------------------------------------------- M-Pesa flow */
  /** Link to the order's receipt — the token lets the customer open it later. */
  function receiptButton(order) {
    return `<a class="btn btn--outline btn--block" style="margin-bottom:.6rem"
      href="/api/orders/${esc(order.id)}/receipt?token=${encodeURIComponent(order.payToken)}"
      target="_blank" rel="noopener">View your receipt</a>`;
  }

  function waButton(waMsg, label) {
    return `<a class="btn btn--outline btn--block" style="margin-top:.6rem"
      href="${esc(waLink(waMsg))}" target="_blank" rel="noopener">${label || 'Send order on WhatsApp'}</a>`;
  }

  async function payWithMpesa(order, waMsg) {
    const box = $('#checkoutMsg');
    const phone = $('#coMpesaPhone').value.trim() || order.customer.phone;
    box.innerHTML = `<div class="notice notice--ok">Sending an M-Pesa request to <b>${esc(phone)}</b>…</div>`;
    try {
      const res = await fetch('/api/mpesa/stkpush', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.id, payToken: order.payToken, phone })
      });
      const data = await res.json();
      if (!res.ok) {
        box.innerHTML = `<div class="notice notice--error">${esc(data.error || 'Could not start M-Pesa.')}</div>`
          + `<p style="font-size:.82rem;color:var(--muted);margin:.6rem 0">Order <b>${esc(order.code)}</b> is saved. You can still complete it on WhatsApp.</p>`
          + waButton(waMsg);
        return;
      }
      box.innerHTML = `<div class="notice notice--ok"><b>Check your phone ♡</b><br>${esc(data.message || 'Enter your M-Pesa PIN to complete payment.')}</div>
        <p class="pay-wait" id="payWait">Waiting for your payment…</p>`;
      pollPayment(order, waMsg, 0);
    } catch {
      box.innerHTML = `<div class="notice notice--error">Network problem starting M-Pesa.</div>` + waButton(waMsg);
    }
  }

  function pollPayment(order, waMsg, tries) {
    if (tries > 24) { // ~2 minutes
      $('#checkoutMsg').innerHTML =
        `<div class="notice notice--warn">We haven't seen the payment yet. If you completed it, we'll confirm on WhatsApp. Order <b>${esc(order.code)}</b>.</div>`
        + waButton(waMsg);
      return;
    }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/orders/${order.id}/payment?token=${encodeURIComponent(order.payToken)}`);
        const data = await res.json();
        if (data.status === 'paid') {
          $('#checkoutForm').reset();
          state.checkout.quote = null;
          $('#deliveryEstimate').hidden = true;
          $('#checkoutMsg').innerHTML =
            `<div class="notice notice--ok"><b>Payment received ♡</b><br>Order <b>${esc(order.code)}</b> is paid${data.receipt ? ` — M-Pesa ${esc(data.receipt)}` : ''}. We'll deliver shortly.</div>`
            + receiptButton(order)
            + waButton(waMsg, 'Send order details on WhatsApp');
          toast('Payment received ♡');
          refreshAccount();
          return;
        }
        if (data.status === 'failed') {
          $('#checkoutMsg').innerHTML =
            `<div class="notice notice--error">The payment didn't go through. Order <b>${esc(order.code)}</b> is saved — try the prompt again from WhatsApp and we'll help you finish it.</div>`
            + waButton(waMsg);
          return;
        }
        pollPayment(order, waMsg, tries + 1);
      } catch {
        pollPayment(order, waMsg, tries + 1);
      }
    }, 5000);
  }

  async function refreshProducts() {
    try {
      const res = await fetch('/api/storefront');
      const data = await res.json();
      state.products = data.products || [];
      state.cart = state.cart.filter((l) => {
        const p = findProduct(l.id);
        if (!p) return false;
        l.qty = Math.min(l.qty, p.stock);
        return l.qty > 0;
      });
      saveCart();
    } catch { /* keep showing what we have */ }
  }

  /* -------------------------------------------------------- quick view */
  function openProduct(id) {
    const p = findProduct(id);
    if (!p) return;
    const stock = stockLabel(p);
    const out = p.stock <= 0;
    const media = p.images.length
      ? `<img id="modalImg" src="${esc(p.images[0])}" alt="${esc(p.name)}">
         ${p.images.length > 1 ? `<div class="modal__thumbs">${p.images.map((u, i) =>
            `<img src="${esc(u)}" class="${i === 0 ? 'is-active' : ''}" data-thumb="${esc(u)}" alt="">`).join('')}</div>` : ''}`
      : `<div class="modal__ph">${esc(p.name.charAt(0).toUpperCase())}</div>`;

    $('#modalPanel').innerHTML = `
      <div class="modal__media">
        <button class="modal__close" data-close-modal aria-label="Close">&times;</button>
        ${media}
      </div>
      <div class="modal__body">
        <span class="card__cat">${esc(p.category)}</span>
        <h2 style="font-size:1.7rem">${esc(p.name)}</h2>
        ${p.brand ? `<span class="card__brand">by ${esc(p.brand)}</span>` : ''}
        <div class="price">
          <span class="price__now" style="font-size:1.5rem">${money(p.salePrice)}</span>
          ${p.discount > 0 ? `<span class="price__was">${money(p.price)}</span>
            <span class="price__off">${p.discount}% off</span>` : ''}
        </div>
        <span class="stock ${stock.cls}">${stock.text}</span>
        <p style="color:var(--muted);font-size:.92rem">${esc(p.description) || 'A Tessora Beauty favourite, carefully selected for you.'}</p>
        <small style="color:var(--muted)">SKU: ${esc(p.sku)}</small>
        <div style="display:flex;gap:.6rem;align-items:center;margin-top:.6rem">
          <div class="qty">
            <button data-mdec aria-label="Decrease">−</button><span id="modalQty">1</span><button data-minc aria-label="Increase">+</button>
          </div>
          <button class="btn ${out ? 'btn--outline' : 'btn--gold'}" data-madd="${p.id}" ${out ? 'disabled' : ''}>
            ${out ? 'Sold out' : 'Add to bag'}
          </button>
        </div>
        <a class="btn btn--outline" style="margin-top:.4rem" target="_blank" rel="noopener"
           href="${esc(waLink(`Hi ♡ Is "${p.name}" (${money(p.salePrice)}) available?`))}">Ask about this item</a>
      </div>`;
    $('#modal').classList.add('is-open');
    $('#overlay').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $('#modal').classList.remove('is-open');
    if (!document.querySelector('.drawer.is-open')) {
      $('#overlay').classList.remove('is-open');
      document.body.style.overflow = '';
    }
  }

  /* ------------------------------------------------------------ drawer */
  function openDrawer(sel) {
    if (sel === '#cartDrawer') renderCart();
    $(sel).classList.add('is-open');
    $('#overlay').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawers() {
    document.querySelectorAll('.drawer').forEach((d) => d.classList.remove('is-open'));
    if (!$('#modal').classList.contains('is-open')) {
      $('#overlay').classList.remove('is-open');
      document.body.style.overflow = '';
    }
  }

  /* ------------------------------------------------------------- wiring */
  function wire() {
    $('#cartOpen').addEventListener('click', () => openDrawer('#cartDrawer'));
    $('#cartClose').addEventListener('click', closeDrawers);
    $('#checkoutClose').addEventListener('click', closeDrawers);

    /* ---- account ---- */
    $('#accountOpen').addEventListener('click', () => {
      closeDrawers();
      renderAccount();
      openDrawer('#accountDrawer');
    });
    $('#accountClose').addEventListener('click', closeDrawers);
    $('#registerForm').addEventListener('submit', submitRegister);
    $('#loginForm').addEventListener('submit', submitLogin);
    $('#acctPasswordForm').addEventListener('submit', submitAccountPassword);
    $('#acctSignOut').addEventListener('click', signOut);
    $('#acctTogglePassword').addEventListener('click', () => {
      const f = $('#acctPasswordForm');
      f.hidden = !f.hidden;
    });
    document.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.addEventListener('click', () => showAuthPane(tab.dataset.auth));
    });
    $('#gateSignIn').addEventListener('click', () => {
      closeDrawers();
      showAuthPane('register');
      openDrawer('#accountDrawer');
    });
    $('#signedAs').addEventListener('click', (e) => {
      if (e.target.id === 'signedAsSwitch') {
        closeDrawers();
        openDrawer('#accountDrawer');
      }
    });
    $('#overlay').addEventListener('click', () => { closeDrawers(); closeModal(); });
    $('#checkoutForm').addEventListener('submit', submitOrder);
    $('#coLocation').addEventListener('input', () => { state.checkout.addressTouched = true; });
    $('#burger').addEventListener('click', () => $('#nav').classList.toggle('is-open'));
    $('#nav').addEventListener('click', () => $('#nav').classList.remove('is-open'));

    $('#search').addEventListener('input', (e) => { state.filter.query = e.target.value; render(); });
    $('#sort').addEventListener('change', (e) => { state.filter.sort = e.target.value; render(); });
    $('#inStockOnly').addEventListener('change', (e) => { state.filter.inStock = e.target.checked; render(); });
    $('#onSaleOnly').addEventListener('change', (e) => { state.filter.onSale = e.target.checked; render(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeDrawers(); closeModal(); }
    });

    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-add],[data-view],[data-chip],[data-cat],[data-inc],[data-dec],'
        + '[data-remove],[data-close-cart],[data-close-modal],[data-madd],[data-minc],[data-mdec],[data-thumb]');
      if (!t) return;
      const d = t.dataset;

      if (d.add) { addToCart(d.add); return; }
      if (d.view) { openProduct(d.view); return; }
      if (d.closeModal !== undefined) { closeModal(); return; }
      if (d.closeCart !== undefined) { closeDrawers(); return; }

      if (d.chip) {
        state.filter.category = d.chip;
        renderChips(); render();
        return;
      }
      if (d.cat) {
        state.filter.category = d.cat;
        renderChips(); render();
        document.getElementById('shop').scrollIntoView({ behavior: 'smooth' });
        return;
      }

      if (d.inc) { const l = state.cart.find((x) => x.id === d.inc); setQty(d.inc, (l?.qty || 0) + 1); return; }
      if (d.dec) { const l = state.cart.find((x) => x.id === d.dec); setQty(d.dec, (l?.qty || 1) - 1); return; }
      if (d.remove) { setQty(d.remove, 0); return; }

      if (d.thumb) {
        $('#modalImg').src = d.thumb;
        document.querySelectorAll('[data-thumb]').forEach((i) => i.classList.toggle('is-active', i.dataset.thumb === d.thumb));
        return;
      }
      if (d.minc !== undefined || d.mdec !== undefined) {
        const el = $('#modalQty');
        const next = Number(el.textContent) + (d.minc !== undefined ? 1 : -1);
        el.textContent = Math.max(1, next);
        return;
      }
      if (d.madd) {
        addToCart(d.madd, Number($('#modalQty').textContent) || 1);
        closeModal();
        openDrawer('#cartDrawer');
      }
    });
  }

  boot();
})();
