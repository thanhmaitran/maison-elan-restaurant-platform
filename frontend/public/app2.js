// Extends the base SPA: accounts, reviews, journal, admin dashboard, Élan Concierge.
(() => {
const _f = window.fetch; window.fetch = (u, o) => _f(u, o && { ...o, headers: { ...o.headers, 'X-Requested-With': 'me' } });   // CSRF guard header
let ME = null; const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
async function loadMe() { try { ME = (await api('/me')).user; } catch { ME = null; } const a = document.getElementById('acct'); if (a) a.textContent = ME ? ME.name.split(' ')[0] : 'Sign in'; }
const nav = document.getElementById('nav');
nav.insertAdjacentHTML('beforeend', '<a href="#/journal" data-r="journal">Journal</a><a href="#/account" data-r="account" id="acct">Sign in</a>');
const msg = (el, e) => { el.innerHTML = `<p class="err">${esc(e.message || e)}</p>`; };
const jimg = ['plated-seafood', 'table-spread', 'menus-on-table', 'service-green-curtain'];

pages.account = async () => {
  await loadMe();
  if (!ME) return `<section class="s"><div class="wrap split" style="align-items:start"><div><div class="eyebrow">Account</div><h1>Sign in</h1><form id="lf"><label>Email<input name="email" type="email" required autocomplete="email"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><p><button class="btn">Sign in</button></p><div class="m"></div></form></div><div><div class="eyebrow">New here?</div><h2>Create an account</h2><form id="rf2"><label>Name<input name="name" required maxlength="80"></label><label>Email<input name="email" type="email" required></label><label>Password (8+ characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><p><button class="btn ghost">Create account</button></p><div class="m"></div></form></div></div></section>`;
  const [o, r] = await Promise.all([api('/me/orders'), api('/me/reservations')]);
  const fm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  return `<section class="s"><div class="wrap"><div class="eyebrow">My account</div><h1>Welcome, ${esc(ME.name.split(' ')[0])}</h1><p>${esc(ME.email)} · <button class="chip" id="lo">Sign out</button> ${['staff', 'admin'].includes(ME.role) ? '<a class="btn" href="#/admin">Admin dashboard</a>' : ''}</p>
<div class="split" style="align-items:start"><div><h3>My orders</h3>${o.orders.map(x => `<div class="line"><span><b>${x.order_number}</b><br><small>${x.items.map(i => i.quantity + '× ' + esc(i.name)).join(', ')}</small></span><span>${gbp(x.total)}<br><small>${x.status.replace(/_/g, ' ')}</small></span></div>`).join('') || '<p>No orders yet.</p>'}</div>
<div><h3>My reservations</h3>${r.reservations.map(x => `<div class="line"><span><b>${x.reservation_number}</b><br><small>${x.party_size} guests · ${x.date} ${fm(x.start_min)}</small></span><span>${x.status}${['confirmed', 'pending_confirmation'].includes(x.status) ? ` <button class="chip" data-cx="${x.reservation_number}">Cancel</button>` : ''}</span></div>`).join('') || '<p>No reservations yet.</p>'}</div></div><div id="am"></div></div></section>`;
};
after.account = () => {
  const go = (id, path) => { const f = document.getElementById(id); if (!f) return; f.onsubmit = async e => { e.preventDefault(); try { await api(path, Object.fromEntries(new FormData(f))); await route(); toast('Signed in'); } catch (x) { msg(f.querySelector('.m'), x); } }; };
  go('lf', '/auth/login'); go('rf2', '/auth/register');
  const lo = document.getElementById('lo'); if (lo) lo.onclick = async () => { await api('/auth/logout', {}); ME = null; await route(); };
  document.querySelectorAll('[data-cx]').forEach(b => b.onclick = async () => { if (!confirm('Cancel this reservation?')) return; try { await api('/me/reservations/' + b.dataset.cx + '/cancel', {}); route(); } catch (x) { msg(document.getElementById('am'), x); } });
};
loadMe();
// Reviews on dish page
const od = pages.dish;
pages.dish = async s => (await od(s)).replace('<p class="notice">Reviews are not yet available for this dish.</p>', '') + '<section class="s" style="padding-top:0"><div class="wrap narrow" id="rev"></div></section>';
after.dish = async slug => {
  const box = document.getElementById('rev'); if (!box) return; await loadMe();
  try {
    const d = await api(`/menu/${encodeURIComponent(slug)}/reviews`);
    box.innerHTML = `<h2>Reviews</h2>` + (d.count ? `<p><b style="font-size:1.6rem">${d.average}</b> / 5 · ${d.count} review${d.count > 1 ? 's' : ''}</p>` + d.reviews.map(r => `<div class="line" style="display:block"><b>${stars(r.rating)}</b> ${esc(r.title)} ${r.verified ? '<span class="tag">Verified purchase</span>' : ''}<p style="margin:4px 0">${esc(r.body)}</p><small>${esc(r.author)} · ${r.date}</small></div>`).join('') : '<p>No reviews yet.</p>') +
      (ME ? `<h3 style="margin-top:28px">Write a review</h3><form id="rvf"><label>Rating<select name="rating"><option value="5">5 — Excellent</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></label><label>Title<input name="title" maxlength="100"></label><label>Your review<textarea name="body" rows="4" required minlength="10" maxlength="2000"></textarea></label><p><button class="btn">Submit review</button></p><div class="m"></div></form><p class="notice">Reviews are published after moderation. “Verified purchase” appears only if you have a completed order containing this dish.</p>` : '<p class="notice"><a href="#/account">Sign in</a> to write a review.</p>');
    const f = document.getElementById('rvf'); if (f) f.onsubmit = async e => { e.preventDefault(); try { await api(`/menu/${slug}/reviews`, Object.fromEntries(new FormData(f))); f.outerHTML = '<div class="ok">Thank you — your review is awaiting moderation.</div>'; } catch (x) { msg(f.querySelector('.m'), x); } };
  } catch (e) { msg(box, e); }
};
// Journal
pages.journal = async slug => {
  if (slug) { try { const p = await api('/journal/' + encodeURIComponent(slug)); return `<section class="s"><div class="wrap narrow"><a href="#/journal">← Journal</a><div class="eyebrow" style="margin-top:20px">${esc(p.category)} · ${p.reading_time_minutes} min read</div><h1>${esc(p.title)}</h1><img src="/images/${p.image}" alt="" style="width:100%;height:380px;object-fit:cover;margin:16px 0">${p.body.map(x => `<p style="font-size:1.1rem">${esc(x)}</p>`).join('')}</div></section>`; } catch { return '<section class="s"><div class="wrap"><h1>Post not found</h1><a class="btn" href="#/journal">Back to the journal</a></div></section>'; } }
  const d = await api('/journal');
  return `<section class="s"><div class="wrap"><div class="eyebrow">Journal</div><h1>Stories from the kitchen</h1><div class="grid">${d.posts.map(p => `<article class="card"><a class="ph" href="#/journal/${p.slug}" style="display:block"><img src="/images/${p.image}" alt="" loading="lazy"></a><div class="b"><span class="eyebrow">${esc(p.category)} · ${p.reading_time_minutes} min</span><h3><a href="#/journal/${p.slug}" style="text-decoration:none">${esc(p.title)}</a></h3><p style="margin:0;color:var(--taupe)">${esc(p.excerpt)}</p></div></article>`).join('')}</div></div></section>`;
};
// Admin dashboard
let tab = 'overview';
pages.admin = async () => { await loadMe(); if (!ME || !['staff', 'admin'].includes(ME.role)) return '<section class="s"><div class="wrap"><h1>Staff area</h1><p>Please <a href="#/account">sign in</a> with a staff account.</p></div></section>'; return `<section class="s"><div class="wrap"><div class="eyebrow">Operations</div><h1>Admin dashboard</h1><div class="filters">${['overview', 'orders', 'reservations', 'reviews', 'messages', 'menu'].map(t => `<button class="chip ${t === tab ? 'on' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div><div id="ad">Loading…</div></div></section>`; };
after.admin = async () => {
  const ad = document.getElementById('ad'); if (!ad) return;
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; route(); });
  const fm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const act = (sel, fn) => ad.querySelectorAll(sel).forEach(b => b.onclick = async () => { try { await fn(b); await after.admin(); } catch (x) { toast(x.message); } });
  try {
    if (tab === 'overview') { const s = await api('/admin/summary'); ad.innerHTML = `<div class="grid">${[['Orders in progress', s.orders_pending], ['Orders total', s.orders_total], ['Revenue (completed orders)', gbp(s.revenue_completed)], ['Reservations today', s.reservations_today], ['Reviews to moderate', s.reviews_pending], ['New messages', s.messages_new], ['Customers', s.customers]].map(([k, v]) => `<div class="card"><div class="b"><span class="eyebrow">${k}</span><h2 style="margin:0">${v}</h2></div></div>`).join('')}</div><p class="notice">All figures are calculated live from the database.</p>`; }
    if (tab === 'orders') { const d = await api('/admin/orders'); ad.innerHTML = d.orders.map(o => `<div class="line" style="display:block"><b>${o.order_number}</b> · ${o.table_number ? '<b>TABLE ' + esc(o.table_number) + '</b>' : 'collection'} · ${esc(o.name)} · ${gbp(o.total)} · ${(o.payment_method || '').replace(/_/g, ' ')} · <b>${o.status.replace(/_/g, ' ')}</b> · ${o.payment_status.replace(/_/g, ' ')}<br><small>${o.items.map(i => i.quantity + '× ' + esc(i.name)).join(', ')}${o.notes ? ' — Note: ' + esc(o.notes) : ''}</small><br>${o.next.map(n => `<button class="chip" data-o="${o.order_number}" data-s="${n}">→ ${n.replace(/_/g, ' ')}</button>`).join(' ')}</div>`).join('') || '<p>No orders yet.</p>'; act('[data-o]', b => api(`/admin/orders/${b.dataset.o}/status`, { status: b.dataset.s })); }
    if (tab === 'reservations') { const d = await api('/admin/reservations'); ad.innerHTML = d.reservations.map(r => `<div class="line"><span><b>${r.reservation_number}</b> · ${esc(r.name)} · ${r.party_size} guests<br><small>${r.date} ${fm(r.start_min)} · table ${r.table_label} · ${r.status}</small></span>${['confirmed', 'pending_confirmation'].includes(r.status) ? `<button class="chip" data-rc="${r.reservation_number}">Cancel</button>` : ''}</div>`).join('') || '<p>No reservations.</p>'; act('[data-rc]', b => api(`/admin/reservations/${b.dataset.rc}/cancel`, {})); }
    if (tab === 'reviews') { const d = await api('/admin/reviews'); ad.innerHTML = d.reviews.map(r => `<div class="line" style="display:block"><b>${stars(r.rating)}</b> ${esc(r.dish)} — ${esc(r.author)} ${r.verified ? '<span class="tag">verified</span>' : ''}<p style="margin:4px 0">${esc(r.title)} ${esc(r.body)}</p>${['published', 'rejected', 'flagged'].map(a => `<button class="chip" data-r="${r.id}" data-a="${a}">${a}</button>`).join(' ')}</div>`).join('') || '<p>No reviews awaiting moderation.</p>'; act('[data-r]', b => api(`/admin/reviews/${b.dataset.r}`, { action: b.dataset.a, reason: 'Moderated in dashboard' })); }
    if (tab === 'messages') { const d = await api('/admin/messages'); ad.innerHTML = d.messages.map(m => `<div class="line" style="display:block"><b>${esc(m.name)}</b> &lt;${esc(m.email)}&gt; · ${m.kind} · ${m.status}<p style="margin:4px 0;white-space:pre-wrap">${esc(m.body)}</p>${m.status === 'new' ? `<button class="chip" data-m="${m.id}">Mark done</button>` : ''}</div>`).join('') || '<p>No messages.</p>'; act('[data-m]', b => api(`/admin/messages/${b.dataset.m}/done`, {})); }
    if (tab === 'menu') { const d = await api('/menu'); ad.innerHTML = d.items.map(m => `<div class="line"><span>${esc(m.name)}</span><span><input type="number" step="0.5" min="1" value="${m.price}" data-p="${m.slug}" style="width:90px"> <button class="chip" data-sv="${m.slug}">Save price</button> <button class="chip" data-av="${m.slug}" data-on="${m.available ? 1 : 0}">${m.available ? 'Mark unavailable' : 'Mark available'}</button></span></div>`).join(''); act('[data-sv]', b => api('/admin/menu/' + b.dataset.sv, { price: document.querySelector(`[data-p="${b.dataset.sv}"]`).value })); act('[data-av]', b => api('/admin/menu/' + b.dataset.av, { available: b.dataset.on !== '1' })); }
  } catch (e) { msg(ad, e); }
};
// Élan Concierge
document.body.insertAdjacentHTML('beforeend', `<button id="cb" class="btn" style="position:fixed;right:20px;bottom:20px;z-index:25;border-radius:28px;background:var(--gold);border-color:var(--gold);color:#16241f">Élan Concierge</button><div id="cp" role="dialog" aria-label="Élan Concierge" style="display:none;position:fixed;right:20px;bottom:20px;z-index:45;width:min(380px,calc(100% - 24px));height:min(560px,80vh);background:var(--white);border:1px solid var(--line);box-shadow:0 10px 40px rgba(0,0,0,.25);flex-direction:column"><div class="row" style="margin:0;padding:12px 16px;background:var(--green);color:#fff"><b style="font-family:var(--serif);font-size:1.3rem">Élan Concierge</b><span><button class="chip" id="cc2">Clear</button> <button class="chip" id="cx">Close</button></span></div><div id="cm" style="flex:1;overflow:auto;padding:12px" aria-live="polite"></div><div class="filters" style="margin:0;padding:0 12px 8px">${['Explore the menu', 'Book a table', 'Dietary information', 'Track an order'].map(x => `<button class="chip" data-qq="${x}">${x}</button>`).join('')}</div><form id="cf2" style="display:flex;gap:6px;padding:10px;border-top:1px solid var(--line)"><input id="ci" maxlength="300" placeholder="Ask about the menu, hours, tables…" aria-label="Message"><button class="btn" style="padding:8px 14px">Send</button></form></div>`);
const cp = document.getElementById('cp'), cm = document.getElementById('cm'), bub = (t, me) => { const d = document.createElement('div'); d.style.cssText = `margin:8px 0;padding:10px 12px;max-width:88%;${me ? 'margin-left:auto;background:var(--green);color:#fff' : 'background:var(--sage)'}`; d.textContent = t; cm.append(d); cm.scrollTop = cm.scrollHeight; return d; };
const greet = () => { cm.innerHTML = ''; bub('Welcome to Maison Élan. I can help with the menu, prices, opening hours, table availability, your orders and private dining. I cannot confirm allergy safety — for that, our team will help.'); };
document.getElementById('cb').onclick = () => { cp.style.display = 'flex'; document.getElementById('cb').style.display = 'none'; if (!cm.children.length) greet(); };
document.getElementById('cx').onclick = () => { cp.style.display = 'none'; document.getElementById('cb').style.display = ''; };
document.getElementById('cc2').onclick = greet;
async function ask(t) {
  bub(t, true); const w = bub('…');
  try {
    const r = await api('/concierge/messages', { message: t }); w.textContent = r.reply;
    r.cards.forEach(m => { const c = document.createElement('div'); c.className = 'line'; c.innerHTML = `<span><a href="#/dish/${m.slug}" onclick="document.getElementById('cx').click()"><b>${esc(m.name)}</b></a><br><small>${gbp(m.price)}${m.available ? '' : ' · unavailable'}</small></span><button class="chip" data-add="${m.slug}" ${m.available ? '' : 'disabled'}>Add</button>`; cm.append(c); });
    r.links.forEach(l => { const a = document.createElement('a'); a.className = 'btn ghost'; a.style.cssText = 'display:inline-block;margin:4px 0;padding:8px 12px'; a.href = l.href; a.textContent = l.label; a.onclick = () => document.getElementById('cx').click(); cm.append(a); });
    cm.scrollTop = cm.scrollHeight;
  } catch (e) { w.innerHTML = ''; w.textContent = e.message + ' '; const b = document.createElement('button'); b.className = 'chip'; b.textContent = 'Retry'; b.onclick = () => { w.remove(); ask(t); }; w.append(b); }
}
document.getElementById('cf2').onsubmit = e => { e.preventDefault(); const i = document.getElementById('ci'); if (i.value.trim()) { ask(i.value.trim()); i.value = ''; } };
cp.onclick = e => { const b = e.target.closest('[data-qq]'); if (b) ask({ 'Explore the menu': 'Show me the menu', 'Book a table': 'I want to book a table', 'Dietary information': 'Which dishes are vegetarian?', 'Track an order': 'Track my order' }[b.dataset.qq]); };

// Checkout: dine-in (table number) or collection, with payment method choice
pages.checkout = async () => {
  const L = cart.map(l => ({ ...l, m: find(l.slug) })).filter(l => l.m);
  if (!L.length) return '<section class="s"><div class="wrap"><h1>Your basket is empty</h1><a class="btn" href="#/menu">Explore the menu</a></div></section>';
  const [o] = await Promise.all([api('/checkout/options'), loadMe()]); const sub = L.reduce((a, l) => a + l.m.price * l.quantity, 0);
  const rad = (n, v, t, ck, dis) => `<label style="font-weight:500"><input type="radio" name="${n}" value="${v}" style="width:auto" ${ck ? 'checked' : ''} ${dis ? 'disabled' : ''}> ${t}</label>`;
  const fs = 'border:1px solid var(--line);padding:12px;margin:14px 0';
  return `<section class="s"><div class="wrap narrow"><h1>Checkout</h1>${L.map(l => `<div class="line"><span>${l.quantity} × ${esc(l.m.name)}</span><b>${gbp(l.m.price * l.quantity)}</b></div>`).join('')}<div class="line"><b>Total</b><b>${gbp(sub)}</b></div>
<form id="f"><fieldset style="${fs}"><legend>How would you like your order?</legend>${rad('service_type', 'dine_in', 'Dine in — bring it to my table', 1)}<br>${rad('service_type', 'collection', 'Collection')}</fieldset>
<div id="tb"><label>Table number<select name="table_number">${o.tables.map(t => `<option>${esc(t)}</option>`).join('')}</select></label><p class="notice">Choose the table you are seated at. Staff confirm every table order before the kitchen starts.</p></div>
<label>Name<input name="name" required maxlength="80" value="${esc(ME ? ME.name : '')}"></label><label>Email<input name="email" type="email" required value="${esc(ME ? ME.email : '')}"></label><label>Phone (optional)<input name="phone"></label><label>Notes for the kitchen (optional)<textarea name="notes" maxlength="500" rows="2"></textarea></label>
<fieldset style="${fs}"><legend>Payment</legend>${rad('payment', 'venue', '<span id="vl"></span>', 1)}<br>${rad('payment', 'card', 'Visa / credit or debit card' + (o.card ? '' : ' — not available yet'), 0, !o.card)}<br>${rad('payment', 'qr', 'Pay by QR code — scan with your phone' + (o.qr ? '' : ' — not available yet'), 0, !o.qr)}</fieldset>
<p><button class="btn" id="go">Place order</button></p><div id="msg" role="alert"></div></form></div></section>`;
};
const loadQr = () => window.QRCode ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = ok; s.onerror = no; document.head.append(s); });
after.checkout = () => {
  const f = document.getElementById('f'); if (!f) return; const key = crypto.randomUUID();
  const sync = () => { const dine = f.service_type.value === 'dine_in'; document.getElementById('tb').style.display = dine ? '' : 'none'; document.getElementById('vl').textContent = dine ? 'Pay at the table (staff bring the bill or card machine)' : 'Pay on collection'; };
  f.addEventListener('change', sync); sync();
  f.onsubmit = async e => {
    e.preventDefault(); const b = document.getElementById('go'), m = document.getElementById('msg'); b.disabled = true; m.textContent = '';
    const d = Object.fromEntries(new FormData(f)), dine = d.service_type === 'dine_in', pay = d.payment; d.payment_method = pay === 'venue' ? (dine ? 'at_table' : 'on_collection') : pay; if (!dine) delete d.table_number;
    let r; try { r = await api('/orders', { ...d, items: cart, idempotency_key: key }); } catch (x) { msg(m, x); b.disabled = false; return; }
    cart = []; saveCart(); try { localStorage.setItem('me_last', JSON.stringify({ n: r.order_number, e: d.email })); } catch { }
    const box = document.createElement('div'); f.replaceWith(box); const info = `Order <b>${r.order_number}</b> · ${gbp(r.total)} · ${dine ? 'table ' + esc(r.table_number) : 'collection'}`;
    if (pay === 'venue') { box.innerHTML = `<div class="ok"><h2>Order received</h2><p>${info}. Status: <b>${r.status.replace(/_/g, ' ')}</b> — the restaurant will confirm it. ${dine ? 'Pay at your table.' : 'Pay on collection.'}</p></div>`; return; }
    const start = async () => {
      try {
        const p = await api(`/orders/${r.order_number}/pay`, { email: d.email }); if (pay === 'card') { location.href = p.url; return; }
        box.innerHTML = `<div class="ok"><h2>Scan to pay ${gbp(r.total)}</h2><p>${info}</p><div id="qr" style="background:#fff;padding:12px;display:inline-block"></div><p><a href="${esc(p.url)}" target="_blank" rel="noopener">Or open the secure payment page</a></p><p id="qs" role="status">Waiting for payment…</p></div>`;
        loadQr().then(() => new QRCode(document.getElementById('qr'), { text: p.url, width: 220, height: 220 })).catch(() => { });
        let n = 0; const t = setInterval(async () => { try { const o = await api(`/orders/${r.order_number}?email=${encodeURIComponent(d.email)}`); if (o.payment_status === 'paid_online') { clearInterval(t); document.getElementById('qs').textContent = 'Payment received — thank you!'; } } catch { } if (++n > 225) clearInterval(t); }, 4000);
      } catch (x) { box.innerHTML = `<div class="ok"><h2>Order ${r.order_number} created</h2><p class="err">${esc(x.message)}</p><p>Your order is waiting for payment. Try again, or ask staff to take payment at the venue.</p><button class="btn" id="rt">Try again</button></div>`; document.getElementById('rt').onclick = start; }
    };
    start();
  };
};
pages.paid = n => `<section class="s"><div class="wrap narrow"><h1>Thank you</h1><p id="pp" role="status">Checking your payment for order ${esc(n)}…</p><a class="btn" href="#/menu">Back to the menu</a></div></section>`;
after.paid = async n => { let l = {}; try { l = JSON.parse(localStorage.getItem('me_last') || '{}'); } catch { } const el = document.getElementById('pp'); for (let i = 0; i < 8; i++) { try { const o = await api(`/orders/${encodeURIComponent(n)}?email=${encodeURIComponent(l.e || '')}`); if (o.payment_status === 'paid_online') { el.textContent = `Payment received for order ${n}. The restaurant will confirm your order shortly.`; return; } } catch { } await new Promise(r => setTimeout(r, 3000)); } if (el) el.textContent = 'We have not received confirmation of your payment yet. It may take a moment — or contact the restaurant.'; };
})();
