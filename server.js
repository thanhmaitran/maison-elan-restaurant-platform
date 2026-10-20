'use strict';
// Maison Élan — zero-dependency server (Node >= 22.5, built-in node:sqlite).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PORT = +process.env.PORT || 3000;
const ROOT = __dirname, PUB = path.join(ROOT, 'frontend/public'), SEED = path.join(ROOT, 'data/seed');
const J = f => JSON.parse(fs.readFileSync(path.join(SEED, f), 'utf8'));
const CONFIG = {
  owner: process.env.OWNER_NAME || 'Thanh Mai Tran',
  email: process.env.CONTACT_EMAIL || 'tranmai15984@gmail.com',
  phone: process.env.CONTACT_PHONE || '07403860400',
  address: process.env.ADDRESS || 'Demo location — not a real trading address',
};
const db = new DatabaseSync(process.env.DB_PATH || path.join(ROOT, 'data/maison_elan.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS menu_items(id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, category TEXT, subcategory TEXT, price_pence INTEGER, serving TEXT, short_description TEXT, description TEXT, ingredients TEXT, allergens TEXT, dietary_tags TEXT, spice TEXT, is_available INTEGER DEFAULT 1, featured INTEGER DEFAULT 0, chef_notes TEXT, image TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, order_number TEXT UNIQUE, idem_key TEXT UNIQUE, name TEXT, email TEXT, phone TEXT, notes TEXT, order_type TEXT DEFAULT 'collection', status TEXT, payment_status TEXT, subtotal_pence INTEGER, total_pence INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), menu_item_id TEXT, name_snapshot TEXT, unit_price_pence INTEGER, quantity INTEGER, line_total_pence INTEGER);
CREATE TABLE IF NOT EXISTS tables_(label TEXT PRIMARY KEY, capacity INTEGER, area TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS reservations(id INTEGER PRIMARY KEY, reservation_number TEXT UNIQUE, table_label TEXT REFERENCES tables_(label), name TEXT, email TEXT, phone TEXT, party_size INTEGER, date TEXT, start_min INTEGER, end_min INTEGER, occasion TEXT, notes TEXT, status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, kind TEXT, name TEXT, email TEXT, subject TEXT, body TEXT, status TEXT DEFAULT 'new', created_at TEXT);
CREATE TABLE IF NOT EXISTS email_outbox(id INTEGER PRIMARY KEY, to_addr TEXT, subject TEXT, body TEXT, sent INTEGER DEFAULT 0, created_at TEXT);`);
const now = () => new Date().toISOString();
if (!db.prepare('SELECT 1 FROM menu_items LIMIT 1').get()) {
  const imgs = J('dish_images.json'), ins = db.prepare('INSERT INTO menu_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const m of J('menu_items.json')) ins.run(m.id, m.slug, m.name, m.category, m.subcategory, Math.round(m.price_gbp * 100), m.serving_size, m.short_description, m.description, JSON.stringify(m.ingredients), JSON.stringify(m.allergens), JSON.stringify(m.dietary_tags), m.spice_level, m.availability === 'available' ? 1 : 0, m.featured ? 1 : 0, m.chef_notes, imgs[m.slug] || null, now());
  const t = db.prepare('INSERT INTO tables_ VALUES(?,?,?,1)');
  for (const x of J('operations_demo.json').demo_tables) t.run(x.table_label, x.nominal_capacity, x.area);
}
const BRAND = J('brand_profile.json'), CONTENT = J('website_content.json'), FAQS = J('faqs.json');
const RULES = J('operations_demo.json').reservation_rules;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hm = s => { const [h, m] = s.split(':'); return +h * 60 + +m; };
const hours = d => BRAND.opening_hours.find(x => x.day === DAYS[new Date(d + 'T12:00:00Z').getUTCDay()]);
const london = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; };
const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const item = r => r && ({ id: r.id, slug: r.slug, name: r.name, category: r.category, subcategory: r.subcategory, price: r.price_pence / 100, currency: 'GBP', serving: r.serving, short_description: r.short_description, description: r.description, ingredients: JSON.parse(r.ingredients), allergens: JSON.parse(r.allergens), dietary_tags: JSON.parse(r.dietary_tags), spice: r.spice, available: !!r.is_available, featured: !!r.featured, chef_notes: r.chef_notes, image: r.image ? '/images/' + r.image : null, image_alt: r.image && r.image.includes('illustrative-') ? 'Illustrative photograph of a plated dish' : r.name });

// Availability: dynamic from opening hours, tables and existing bookings (server is the source of truth).
function slotsFor(date, party) {
  const h = hours(date); if (!h || h.status !== 'open') return { slots: [], reason: 'Closed on this day.' };
  const L = london(); if (date < L.date) return { slots: [], reason: 'Date is in the past.' };
  if (date > new Date(Date.parse(L.date) + RULES.advance_booking_days * 864e5).toISOString().slice(0, 10)) return { slots: [], reason: `Bookings open ${RULES.advance_booking_days} days ahead.` };
  const dur = party >= RULES.large_party_threshold ? RULES.large_party_duration_minutes : RULES.standard_duration_minutes;
  const tabs = db.prepare('SELECT * FROM tables_ WHERE active=1 AND capacity>=? ORDER BY capacity').all(party);
  const out = [];
  for (let s = hm(h.open); s + dur <= hm(h.close) + 30; s += RULES.slot_interval_minutes) {
    if (date === L.date && s < L.min + RULES.same_day_cutoff_hours * 60) continue;
    const t = tabs.find(t => !db.prepare("SELECT 1 FROM reservations WHERE table_label=? AND date=? AND status IN('confirmed','pending_confirmation','seated') AND start_min<? AND end_min>?").get(t.label, date, s + dur, s));
    if (t) out.push({ time: fmt(s), table: t.label });
  }
  return { slots: out, duration_minutes: dur };
}
const clean = (v, n) => String(v ?? '').trim().slice(0, n);
const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const E = (code, msg) => Object.assign(new Error(msg), { code });
const hits = new Map();
const limited = (ip, key, max) => { const k = ip + key, t = Date.now(), a = (hits.get(k) || []).filter(x => t - x < 60000); a.push(t); hits.set(k, a); return a.length > max; };

const routes = {
  'GET /api/info': () => ({ brand: BRAND.brand_name, tagline: BRAND.tagline, owner: CONFIG.owner, contact: { email: CONFIG.email, phone: CONFIG.phone, address: CONFIG.address }, opening_hours: BRAND.opening_hours, demo_notice: 'Maison Élan is a portfolio concept: the menu, prices and allergen records are sample data.', content: CONTENT, categories: [...new Set(db.prepare('SELECT category FROM menu_items WHERE is_hidden=0 ORDER BY rowid').all().map(r => r.category))] }),
  'GET /api/menu': ({ q }) => {
    let rows = db.prepare('SELECT * FROM menu_items WHERE is_hidden=0 ORDER BY rowid').all().map(item);
    const s = clean(q.q, 60).toLowerCase();
    if (q.category) rows = rows.filter(r => r.category === q.category);
    if (s) rows = rows.filter(r => (r.name + r.short_description + r.ingredients.join(' ')).toLowerCase().includes(s));
    if (q.diet) rows = rows.filter(r => r.dietary_tags.some(t => t.toLowerCase().startsWith(q.diet)));
    if (q.featured) rows = rows.filter(r => r.featured);
    if (q.sort === 'price') rows.sort((a, b) => a.price - b.price); else if (q.sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    return { items: rows, total: rows.length };
  },
  'GET /api/menu/:slug': ({ params }) => { const r = item(db.prepare('SELECT * FROM menu_items WHERE slug=? AND is_hidden=0').get(params.slug)); if (!r) throw E(404, 'Dish not found'); return r; },
  'GET /api/reservations/availability': ({ q }) => { const p = +q.party; if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date || '') || !(p >= 1)) throw E(400, 'date and party are required'); if (p > 8) return { slots: [], reason: 'For parties over 8 please send a private dining enquiry.' }; return slotsFor(q.date, p); },
  'POST /api/reservations': ({ body, ip }) => {
    if (limited(ip, 'res', 10)) throw E(429, 'Too many requests');
    const name = clean(body.name, 80), email = clean(body.email, 254), party = +body.party_size, date = clean(body.date, 10), time = clean(body.time, 5);
    if (!name || !okEmail(email) || !(party >= 1 && party <= 8) || !/^\d{2}:\d{2}$/.test(time)) throw E(400, 'Please provide a valid name, email, party size (1–8) and time.');
    db.exec('BEGIN IMMEDIATE');           // serialises writers: two guests cannot take the same table
    try {
      const slot = slotsFor(date, party).slots.find(s => s.time === time);
      if (!slot) throw E(409, 'Sorry, that time is no longer available. Please choose another.');
      const dur = party >= RULES.large_party_threshold ? RULES.large_party_duration_minutes : RULES.standard_duration_minutes;
      const num = 'RES-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      db.prepare('INSERT INTO reservations(reservation_number,table_label,name,email,phone,party_size,date,start_min,end_min,occasion,notes,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(num, slot.table, name, email, clean(body.phone, 30), party, date, hm(time), hm(time) + dur, clean(body.occasion, 60), clean(body.notes, 500), 'confirmed', now());
      db.prepare('INSERT INTO email_outbox(to_addr,subject,body,created_at) VALUES(?,?,?,?)').run(email, `Reservation ${num}`, `Hello ${name}, your table for ${party} on ${date} at ${time} is confirmed.`, now());
      db.exec('COMMIT'); return { status: 'confirmed', reservation_number: num, date, time, party_size: party };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  'POST /api/orders': ({ body, ip }) => {
    if (limited(ip, 'ord', 10)) throw E(429, 'Too many requests');
    const name = clean(body.name, 80), email = clean(body.email, 254), key = clean(body.idempotency_key, 64);
    if (!name || !okEmail(email)) throw E(400, 'Please provide a valid name and email.');
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) throw E(400, 'Your order is empty.');
    if (key) { const d = db.prepare('SELECT * FROM orders WHERE idem_key=?').get(key); if (d) return { order_number: d.order_number, status: d.status, total: d.total_pence / 100, duplicate: true }; }
    db.exec('BEGIN IMMEDIATE');
    try {
      let lines = [], sub = 0;
      for (const l of body.items) {          // prices and availability come ONLY from the database
        const q = Math.floor(+l.quantity), r = db.prepare('SELECT * FROM menu_items WHERE slug=?').get(clean(l.slug, 100));
        if (!r) throw E(422, 'An item in your basket no longer exists.');
        if (!r.is_available) throw E(409, `${r.name} is currently unavailable. Please remove it.`);
        if (!(q >= 1 && q <= 20)) throw E(400, 'Quantity must be between 1 and 20.');
        lines.push([r, q]); sub += r.price_pence * q;
      }
      const num = 'ME-' + new Date().getFullYear() + '-' + (1100 + db.prepare('SELECT COUNT(*) c FROM orders').get().c + 1);
      const oid = db.prepare('INSERT INTO orders(order_number,idem_key,name,email,phone,notes,status,payment_status,subtotal_pence,total_pence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(num, key || null, name, email, clean(body.phone, 30), clean(body.notes, 500), 'pending_confirmation', 'unpaid_pay_on_collection', sub, sub, now()).lastInsertRowid;
      for (const [r, q] of lines) db.prepare('INSERT INTO order_items(order_id,menu_item_id,name_snapshot,unit_price_pence,quantity,line_total_pence) VALUES(?,?,?,?,?,?)').run(oid, r.id, r.name, r.price_pence, q, r.price_pence * q);
      db.prepare('INSERT INTO email_outbox(to_addr,subject,body,created_at) VALUES(?,?,?,?)').run(email, `Order ${num} received`, `Thank you ${name}. Total £${(sub / 100).toFixed(2)}, pay on collection.`, now());
      db.exec('COMMIT'); return { order_number: num, status: 'pending_confirmation', total: sub / 100 };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  'GET /api/orders/:num': ({ params, q }) => {
    const o = db.prepare('SELECT * FROM orders WHERE order_number=? AND lower(email)=lower(?)').get(params.num, clean(q.email, 254));
    if (!o) throw E(404, 'No order found for that number and email.');
    return { order_number: o.order_number, status: o.status, payment_status: o.payment_status, total: o.total_pence / 100, created_at: o.created_at, items: db.prepare('SELECT name_snapshot name, unit_price_pence/100.0 unit_price, quantity FROM order_items WHERE order_id=?').all(o.id) };
  },
  'POST /api/contact': ({ body, ip }) => {
    if (limited(ip, 'msg', 5)) throw E(429, 'Too many requests');
    const name = clean(body.name, 80), email = clean(body.email, 254), msg = clean(body.message, 3000);
    if (!name || !okEmail(email) || msg.length < 5) throw E(400, 'Please provide your name, a valid email and a message.');
    db.prepare('INSERT INTO messages(kind,name,email,subject,body,created_at) VALUES(?,?,?,?,?,?)').run(body.kind === 'private_dining' ? 'private_dining' : 'contact', name, email, clean(body.subject, 120), msg, now());
    return { status: 'received' };
  },
  'GET /api/faqs': () => FAQS,
  'GET /api/health': () => ({ status: 'ok' }),
};
const mods = require('./extra')(db, routes, { E, clean, okEmail, limited, now, item, slotsFor, london, BRAND, CONFIG, ROOT });
require('./payments')(db, routes, { E, clean, limited, now });
const HH = { E, clean, limited, now, item, slotsFor, london, ROOT, CONFIG, BRAND, staff: mods.staff, NEXT: mods.NEXT };
require('./admin-api')(db, routes, HH);
require('./ai')(db, routes, HH);
const compiled = Object.entries(routes).map(([k, fn]) => { const [m, p] = k.split(' '); return { m, keys: [...p.matchAll(/:(\w+)/g)].map(x => x[1]), re: new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$'), fn }; });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const send = (res, code, data, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
  if (u.pathname.startsWith('/api/')) {
    const route = compiled.map(r => ({ r, mt: r.re.exec(u.pathname) })).find(x => x.mt && x.r.m === req.method);
    if (!route) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'me' && u.pathname !== '/api/payments/webhook') return send(res, 403, { error: 'Forbidden' });   // CSRF guard
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        const params = Object.fromEntries(route.r.keys.map((k, i) => [k, decodeURIComponent(route.mt[i + 1])]));
        send(res, 200, await route.r.fn({ raw, q: Object.fromEntries(u.searchParams), params, body, ip, user: mods.getUser(req), req, res }));
      } catch (e) { send(res, e.code >= 400 && e.code < 600 ? e.code : e instanceof SyntaxError ? 400 : 500, { error: e.code ? e.message : e instanceof SyntaxError ? 'Invalid JSON' : 'Server error' }); if (!e.code) console.error(e); }
    });
    return;
  }
  let f = path.normalize(path.join(PUB, decodeURIComponent(u.pathname)));
  if (!f.startsWith(PUB)) return send(res, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');   // SPA fallback
  const ext = path.extname(f); res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=86400');
  send(res, 200, fs.readFileSync(f), MIME[ext] || 'application/octet-stream');
}).listen(PORT, () => console.log(`Maison Élan running on http://localhost:${PORT}`));
