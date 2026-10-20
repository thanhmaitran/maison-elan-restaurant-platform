'use strict';
// Accounts, reviews, admin, journal and the rule-based AI Concierge. Mounted by server.js.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
module.exports = function (db, routes, H) {
  const { E, clean, okEmail, limited, now, item, slotsFor, london, BRAND, CONFIG, ROOT } = H;
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, pw TEXT, role TEXT DEFAULT 'customer', created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), expires TEXT);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, user_id INTEGER, menu_item_id TEXT, rating INTEGER, title TEXT, body TEXT, status TEXT DEFAULT 'pending_moderation', verified INTEGER DEFAULT 0, mod_reason TEXT, mod_by INTEGER, created_at TEXT, UNIQUE(user_id, menu_item_id));
CREATE TABLE IF NOT EXISTS order_status_history(id INTEGER PRIMARY KEY, order_id INTEGER, old_status TEXT, new_status TEXT, changed_by INTEGER, created_at TEXT);`);
  for (const t of ['orders', 'reservations']) try { db.exec(`ALTER TABLE ${t} ADD COLUMN user_id INTEGER`); } catch { }
  const imgs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/dish_images.json'), 'utf8'));
  for (const [s, i] of Object.entries(imgs)) db.prepare('UPDATE menu_items SET image=? WHERE slug=?').run(i, s);
  const hp = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
  const chk = (pw, st) => { const [s, h] = st.split(':'); return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, s, 64)); };
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
    const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.prepare("INSERT INTO users(name,email,pw,role,created_at) VALUES(?,?,?,?,?)").run(CONFIG.owner, (process.env.ADMIN_EMAIL || CONFIG.email).toLowerCase(), hp(pw), 'admin', now());
    console.log(`ADMIN ACCOUNT CREATED: ${(process.env.ADMIN_EMAIL || CONFIG.email)}${process.env.ADMIN_PASSWORD ? '' : ' / generated password: ' + pw + '  (shown once — set ADMIN_PASSWORD to choose your own)'}`);
  }
  const getUser = req => {
    const m = /(?:^|; )me_s=([\w-]+)/.exec(req.headers.cookie || ''); if (!m) return null;
    return db.prepare('SELECT u.id,u.name,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(sha(m[1]), now()) || null;
  };
  const login = (ctx, u) => {
    const tok = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(tok), u.id, new Date(Date.now() + 14 * 864e5).toISOString());
    ctx.res.setHeader('Set-Cookie', `me_s=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600${ctx.req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
  };
  const need = u => { if (!u) throw E(401, 'Please sign in.'); return u; };
  const staff = u => { need(u); if (!['staff', 'admin'].includes(u.role)) throw E(403, 'Staff only.'); return u; };
  const pub = u => u && { id: u.id, name: u.name, email: u.email, role: u.role };

  Object.assign(routes, {
    'POST /api/auth/register': ctx => {
      const { body } = ctx; if (limited(ctx.ip, 'reg', 5)) throw E(429, 'Too many attempts');
      const name = clean(body.name, 80), email = clean(body.email, 254).toLowerCase(), pw = String(body.password || '');
      if (!name || !okEmail(email) || pw.length < 8 || pw.length > 128) throw E(400, 'Enter your name, a valid email and a password of at least 8 characters.');
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw E(409, 'An account with that email already exists.');
      const id = db.prepare('INSERT INTO users(name,email,pw,created_at) VALUES(?,?,?,?)').run(name, email, hp(pw), now()).lastInsertRowid;
      login(ctx, { id }); return { user: { id, name, email, role: 'customer' } };
    },
    'POST /api/auth/login': ctx => {
      if (limited(ctx.ip, 'login', 10)) throw E(429, 'Too many attempts. Please wait a minute.');
      const u = db.prepare('SELECT * FROM users WHERE email=?').get(clean(ctx.body.email, 254).toLowerCase());
      if (!u || !chk(String(ctx.body.password || ''), u.pw)) throw E(401, 'Incorrect email or password.');
      login(ctx, u); return { user: pub(u) };
    },
    'POST /api/auth/logout': ctx => { const m = /me_s=([\w-]+)/.exec(ctx.req.headers.cookie || ''); if (m) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(m[1])); ctx.res.setHeader('Set-Cookie', 'me_s=; HttpOnly; Path=/; Max-Age=0'); return { ok: true }; },
    'GET /api/me': ({ user }) => ({ user: pub(user) }),
    'GET /api/me/orders': ({ user }) => ({ orders: db.prepare('SELECT order_number,status,payment_status,total_pence/100.0 total,created_at,id FROM orders WHERE user_id=? ORDER BY id DESC').all(need(user).id).map(o => ({ ...o, items: db.prepare('SELECT name_snapshot name,quantity FROM order_items WHERE order_id=?').all(o.id), id: undefined })) }),
    'GET /api/me/reservations': ({ user }) => ({ reservations: db.prepare('SELECT reservation_number,party_size,date,start_min,status FROM reservations WHERE user_id=? ORDER BY date DESC,start_min DESC').all(need(user).id) }),
    'POST /api/me/reservations/:num/cancel': ({ user, params }) => {
      const r = db.prepare('SELECT * FROM reservations WHERE reservation_number=? AND user_id=?').get(params.num, need(user).id);   // ownership enforced in SQL
      if (!r) throw E(404, 'Reservation not found.'); if (!['confirmed', 'pending_confirmation'].includes(r.status)) throw E(409, 'This reservation cannot be cancelled.');
      db.prepare("UPDATE reservations SET status='cancelled' WHERE id=?").run(r.id); return { status: 'cancelled' };
    },
    // Reviews: only published reviews are public; average counts published only.
    'GET /api/menu/:slug/reviews': ({ params }) => {
      const m = db.prepare('SELECT id FROM menu_items WHERE slug=?').get(params.slug); if (!m) throw E(404, 'Dish not found');
      const rows = db.prepare("SELECT r.*,u.name uname FROM reviews r JOIN users u ON u.id=r.user_id WHERE menu_item_id=? AND r.status='published' ORDER BY r.id DESC").all(m.id), n = rows.length;
      return { count: n, average: n ? Math.round(rows.reduce((a, r) => a + r.rating, 0) / n * 10) / 10 : null, distribution: [5, 4, 3, 2, 1].map(s => rows.filter(r => r.rating === s).length), reviews: rows.map(r => { const p = r.uname.split(' '); return { rating: r.rating, title: r.title, body: r.body, verified: !!r.verified, date: r.created_at.slice(0, 10), author: p[0] + (p[1] ? ' ' + p[1][0] + '.' : '') }; }) };
    },
    'POST /api/menu/:slug/reviews': ({ user, params, body, ip }) => {
      need(user); if (limited(ip, 'rev', 5)) throw E(429, 'Too many requests');
      const m = db.prepare('SELECT id FROM menu_items WHERE slug=?').get(params.slug); if (!m) throw E(404, 'Dish not found');
      const rating = +body.rating, text = clean(body.body, 2000);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5 || text.length < 10) throw E(400, 'Choose 1–5 stars and write at least 10 characters.');
      if (db.prepare('SELECT 1 FROM reviews WHERE user_id=? AND menu_item_id=?').get(user.id, m.id)) throw E(409, 'You have already reviewed this dish.');
      const verified = db.prepare("SELECT 1 FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.user_id=? AND o.status='completed' AND i.menu_item_id=?").get(user.id, m.id) ? 1 : 0;
      db.prepare('INSERT INTO reviews(user_id,menu_item_id,rating,title,body,verified,created_at) VALUES(?,?,?,?,?,?,?)').run(user.id, m.id, rating, clean(body.title, 100), text, verified, now());
      return { status: 'pending_moderation', verified: !!verified };
    },
    // Admin / staff
    'GET /api/admin/summary': ({ user }) => {
      staff(user); const c = (q, ...a) => db.prepare(q).get(...a).c, d = london().date;
      return { orders_total: c('SELECT COUNT(*) c FROM orders'), orders_pending: c("SELECT COUNT(*) c FROM orders WHERE status IN('pending_confirmation','confirmed','preparing','ready_for_collection')"), revenue_completed: c("SELECT COALESCE(SUM(total_pence),0)/100.0 c FROM orders WHERE status='completed'"), reservations_today: c("SELECT COUNT(*) c FROM reservations WHERE date=? AND status='confirmed'", d), reviews_pending: c("SELECT COUNT(*) c FROM reviews WHERE status='pending_moderation'"), messages_new: c("SELECT COUNT(*) c FROM messages WHERE status='new'"), customers: c("SELECT COUNT(*) c FROM users WHERE role='customer'") };
    },
    'GET /api/admin/orders': ({ user }) => (staff(user), { orders: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100').all().map(o => ({ order_number: o.order_number, name: o.name, email: o.email, notes: o.notes, table_number: o.table_number, service_type: o.service_type, payment_method: o.payment_method, status: o.status, payment_status: o.payment_status, total: o.total_pence / 100, created_at: o.created_at, next: NEXT[o.status] || [], items: db.prepare('SELECT name_snapshot name,quantity FROM order_items WHERE order_id=?').all(o.id) })) }),
    'POST /api/admin/orders/:num/status': ({ user, params, body }) => {
      staff(user); const o = db.prepare('SELECT * FROM orders WHERE order_number=?').get(params.num); if (!o) throw E(404, 'Order not found');
      const to = clean(body.status, 40); if (!(NEXT[o.status] || []).includes(to)) throw E(409, `Cannot move an order from ${o.status} to ${to}.`);
      db.prepare('UPDATE orders SET status=?, payment_status=? WHERE id=?').run(to, to === 'completed' && o.payment_status.startsWith('unpaid') ? o.payment_status.replace('unpaid', 'paid') : o.payment_status, o.id);
      db.prepare('INSERT INTO order_status_history(order_id,old_status,new_status,changed_by,created_at) VALUES(?,?,?,?,?)').run(o.id, o.status, to, user.id, now()); return { status: to };
    },
    'GET /api/admin/reservations': ({ user }) => ({ reservations: (staff(user), db.prepare('SELECT reservation_number,name,email,party_size,date,start_min,table_label,status,notes FROM reservations ORDER BY date DESC,start_min DESC LIMIT 100').all()) }),
    'POST /api/admin/reservations/:num/cancel': ({ user, params }) => { staff(user); const r = db.prepare("UPDATE reservations SET status='cancelled' WHERE reservation_number=? AND status IN('confirmed','pending_confirmation')").run(params.num); if (!r.changes) throw E(409, 'Cannot cancel.'); return { status: 'cancelled' }; },
    'GET /api/admin/reviews': ({ user, q }) => ({ reviews: (staff(user), db.prepare('SELECT r.id,r.rating,r.title,r.body,r.status,r.verified,r.created_at,u.name author,m.name dish FROM reviews r JOIN users u ON u.id=r.user_id JOIN menu_items m ON m.id=r.menu_item_id WHERE r.status=? ORDER BY r.id DESC').all(q.status || 'pending_moderation')) }),
    'POST /api/admin/reviews/:id': ({ user, params, body }) => {
      staff(user); const a = clean(body.action, 20); if (!['published', 'rejected', 'flagged'].includes(a)) throw E(400, 'Invalid action');
      const r = db.prepare('UPDATE reviews SET status=?,mod_reason=?,mod_by=? WHERE id=?').run(a, clean(body.reason, 300), user.id, +params.id); if (!r.changes) throw E(404, 'Review not found'); return { status: a };
    },
    'GET /api/admin/messages': ({ user }) => ({ messages: (staff(user), db.prepare('SELECT id,kind,name,email,body,status,created_at FROM messages ORDER BY id DESC LIMIT 100').all()) }),
    'POST /api/admin/messages/:id/done': ({ user, params }) => { staff(user); db.prepare("UPDATE messages SET status='done' WHERE id=?").run(+params.id); return { ok: true }; },
    'POST /api/admin/menu/:slug': ({ user, params, body }) => {
      staff(user); if (user.role !== 'admin') throw E(403, 'Admin only.'); const m = db.prepare('SELECT * FROM menu_items WHERE slug=?').get(params.slug); if (!m) throw E(404, 'Dish not found');
      const price = body.price === undefined ? m.price_pence : Math.round(+body.price * 100); if (!(price > 0 && price < 100000)) throw E(400, 'Invalid price');
      db.prepare('UPDATE menu_items SET price_pence=?,is_available=?,updated_at=? WHERE id=?').run(price, body.available === undefined ? m.is_available : body.available ? 1 : 0, now(), m.id); return { ok: true };
    },
    // Journal (published posts only)
    'GET /api/journal': () => ({ posts: JOURNAL().map(({ body, ...p }) => p) }),
    'GET /api/journal/:slug': ({ params }) => { const p = JOURNAL().find(x => x.slug === params.slug); if (!p) throw E(404, 'Post not found'); return p; },
  });
  const NEXT = { pending_confirmation: ['confirmed', 'cancelled'], confirmed: ['preparing', 'cancelled'], preparing: ['ready_for_collection'], ready_for_collection: ['completed'] };
  const JOURNAL = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/journal_posts.json'), 'utf8'));
  // Attach signed-in user to orders/reservations created through the existing routes.
  for (const [k, col] of [['POST /api/orders', 'orders'], ['POST /api/reservations', 'reservations']]) {
    const orig = routes[k]; routes[k] = ctx => { const r = orig(ctx); if (ctx.user) db.prepare(`UPDATE ${col} SET user_id=? WHERE ${col === 'orders' ? 'order_number' : 'reservation_number'}=?`).run(ctx.user.id, r.order_number || r.reservation_number); return r; };
  }
  // AI Concierge: deterministic orchestration over verified tools. It never invents prices, never certifies allergen safety
  // and never creates orders or bookings by itself.
  const STOP = new Set(['what', 'does', 'price', 'cost', 'much', 'this', 'that', 'have', 'your', 'dish', 'menu', 'contain', 'ingredients', 'allergy', 'with', 'tell', 'about', 'gluten', 'free']);
  const findDish = (t, all) => { let b = null, sc = 0; for (const m of all) { const s = m.name.toLowerCase().replace(/[^a-z ]/g, ' ').split(' ').filter(w => w.length > 3 && !STOP.has(w)).filter(w => t.includes(w)).length; if (s > sc) { sc = s; b = m; } } return b; };
  const WD = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const parseDate = t => { const L = london().date, iso = /\d{4}-\d{2}-\d{2}/.exec(t); if (iso) return iso[0]; if (/today/.test(t)) return L; const base = new Date(L + 'T12:00:00Z'); if (/tomorrow/.test(t)) return new Date(+base + 864e5).toISOString().slice(0, 10); const w = WD.findIndex(d => t.includes(d)); if (w >= 0) return new Date(+base + ((w - base.getUTCDay() + 7) % 7) * 864e5).toISOString().slice(0, 10); return null; };
  routes['POST /api/concierge/messages'] = ({ body, user, ip }) => {
    if (limited(ip, 'ai', 20)) throw E(429, 'Please slow down a moment.');
    const raw = clean(body.message, 300); if (!raw) throw E(400, 'Please type a message.'); const t = raw.toLowerCase(), all = db.prepare('SELECT * FROM menu_items WHERE is_hidden=0 ORDER BY rowid').all().map(item), d = findDish(t, all), money = n => '£' + n.toFixed(2);
    const out = (reply, cards = [], links = []) => ({ reply, cards: cards.slice(0, 6), links });
    const staffLine = `For anything allergy-related please contact the team directly at ${CONFIG.email}.`;
    if (/ignore (all |previous|your)|system prompt|api key|password|sql|database|other (customer|guest)/.test(t)) return out('I can only help with the menu, opening hours, reservations, your own orders and private dining enquiries.');
    if (/allerg|nut|gluten|coeliac|celiac|dairy|lactose|intoleran|safe for/.test(t)) {
      if (d) return out(`I can't confirm that ${d.name} is safe for an allergy. The recorded information (demo data, not a verified declaration) lists: ${d.allergens.map(a => a.name + ' — ' + a.status).join('; ') || 'nothing recorded — which does not mean it is allergen-free'}. ${staffLine}`, [d]);
      return out(`I can't guarantee that any dish is safe for a particular allergy, and the allergen records on this demo site are illustrative only. Each dish page shows what is recorded. ${staffLine}`);
    }
    if (/order status|track|my order|where is my order/.test(t)) {
      if (!user) return out('Please sign in to your account (Account in the menu) and I can show the status of your orders.', [], [{ label: 'Sign in', href: '#/account' }]);
      const o = db.prepare('SELECT order_number,status,total_pence FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 3').all(user.id);
      return out(o.length ? 'Your latest orders: ' + o.map(x => `${x.order_number} — ${x.status.replace(/_/g, ' ')} (${money(x.total_pence / 100)})`).join('; ') + '.' : 'You have no orders on this account yet.');
    }
    if (/book|reserv|table/.test(t)) {
      const date = parseDate(t), p = /(\d+)\s*(people|guests|persons|pax|of us)|for\s+(\d+)|party of (\d+)/.exec(t), party = p ? +(p[1] || p[3] || p[4]) : null;
      if (!date || !party) return out('I can check live availability. Tell me the date (e.g. tomorrow, Friday or 2026-11-01) and the number of guests.', [], [{ label: 'Open reservations', href: '#/reserve' }]);
      if (party > 8) return out('For more than 8 guests please send a private dining enquiry.', [], [{ label: 'Private dining', href: '#/private' }]);
      const r = slotsFor(date, party);
      return out(r.slots.length ? `Available times for ${party} on ${date}: ${r.slots.slice(0, 8).map(s => s.time).join(', ')}. Nothing is booked until you confirm on the reservations page.` : `No tables for ${party} on ${date}${r.reason ? ' — ' + r.reason : ''}.`, [], [{ label: 'Go to reservations', href: '#/reserve' }]);
    }
    if (/open|hour|closing|what time/.test(t)) return out('Opening hours: ' + BRAND.opening_hours.map(h => h.day.slice(0, 3) + ' ' + (h.status === 'open' ? h.open + '–' + h.close : 'closed')).join(', ') + '.');
    if (/private|event|party room|birthday|anniversary|celebrat/.test(t)) return out('For celebrations of 9 or more, send a private dining enquiry. It is a request only — the team will reply to confirm.', [], [{ label: 'Private dining', href: '#/private' }]);
    if (/vegan|vegetarian|veggie/.test(t)) { const k = /vegan/.test(t) ? 'vegan' : 'vegetarian'; const r = all.filter(m => m.dietary_tags.some(x => x.toLowerCase().startsWith(k))); return out(r.length ? `Dishes tagged ${k} (demo data — please confirm with the team):` : `No dishes are tagged ${k}.`, r); }
    if (d) return out(`${d.name} is ${money(d.price)} and is ${d.available ? 'available' : 'currently unavailable'}. Listed ingredients: ${d.ingredients.join(', ')}.`, [d]);
    if (/starter|main|dessert|drink|special|menu|recommend/.test(t)) { const c = /starter/.test(t) ? 'Starters' : /main/.test(t) ? 'Main Courses' : /dessert/.test(t) ? 'Desserts' : /drink/.test(t) ? 'Drinks' : /special/.test(t) ? 'Seasonal Specials' : null; return out(c ? `Some of our ${c.toLowerCase()}:` : 'Here are a few signature dishes:', all.filter(m => c ? m.category === c : m.featured)); }
    return out('I can help with the menu and prices, dietary information, opening hours, checking table availability, your order status and private dining. What would you like to know?');
  };
  return { getUser, staff, need, NEXT };
};
