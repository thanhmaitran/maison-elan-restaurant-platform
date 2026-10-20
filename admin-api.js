'use strict';
// Admin API. Every route calls staff(user) first (session check happens server-side, never only in the UI).
module.exports = function (db, routes, H) {
  const { E, clean, now, item, staff, NEXT } = H;
  db.exec(`CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT, entity TEXT, entity_ref TEXT, detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS price_history(id INTEGER PRIMARY KEY, menu_item_id TEXT, old_pence INTEGER, new_pence INTEGER, changed_by INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS reservation_history(id INTEGER PRIMARY KEY, reservation_id INTEGER, old_status TEXT, new_status TEXT, changed_by INTEGER, created_at TEXT);`);
  for (const a of ['ALTER TABLE menu_items ADD COLUMN is_hidden INTEGER DEFAULT 0', 'ALTER TABLE messages ADD COLUMN note TEXT']) try { db.exec(a); } catch { }
  const audit = (u, action, entity, ref, detail) => db.prepare('INSERT INTO audit_logs(actor_id,action,entity,entity_ref,detail,created_at) VALUES(?,?,?,?,?,?)').run(u.id, action, entity, String(ref), detail ? JSON.stringify(detail).slice(0, 500) : null, now());
  H.audit = audit;
  const pg = q => { const per = Math.min(100, Math.max(1, +q.per || 20)), page = Math.max(1, +q.page || 1); return { per, page, off: (page - 1) * per }; };
  const D = /^\d{4}-\d{2}-\d{2}$/, hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const where = (conds) => ({ W: conds.length ? 'WHERE ' + conds.map(c => c[0]).join(' AND ') : '', A: conds.flatMap(c => c.slice(1)) });
  const ordView = o => ({ order_number: o.order_number, name: o.name, email: o.email, phone: o.phone, notes: o.notes, table_number: o.table_number, service_type: o.service_type, payment_method: o.payment_method, status: o.status, payment_status: o.payment_status, total: o.total_pence / 100, created_at: o.created_at, next: NEXT[o.status] || [], items: db.prepare('SELECT name_snapshot name, unit_price_pence/100.0 unit_price, quantity, line_total_pence/100.0 line_total FROM order_items WHERE order_id=?').all(o.id) });
  const page = (rows, total, p) => ({ total, page: p.page, pages: Math.max(1, Math.ceil(total / p.per)), rows });

  // ---- Overview (definitions are returned with the numbers so they can be audited)
  routes['GET /api/admin/overview'] = ({ user, q }) => {
    staff(user); const days = Math.min(90, Math.max(1, +q.days || 14)), to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const o = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_pence),0) v FROM orders WHERE status NOT IN('cancelled','failed') AND substr(created_at,1,10) BETWEEN ? AND ?").get(from, to);
    const done = db.prepare("SELECT COALESCE(SUM(total_pence),0) v FROM orders WHERE status='completed' AND substr(created_at,1,10) BETWEEN ? AND ?").get(from, to).v;
    const res = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM reservations WHERE date BETWEEN ? AND ? GROUP BY status').all(from, to).map(r => [r.status, r.n]));
    const od = Object.fromEntries(db.prepare("SELECT substr(created_at,1,10) d, COUNT(*) n, SUM(total_pence) v FROM orders WHERE status NOT IN('cancelled','failed') AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY d").all(from, to).map(r => [r.d, r]));
    const rd = Object.fromEntries(db.prepare("SELECT date d, COUNT(*) n FROM reservations WHERE status!='cancelled' AND date BETWEEN ? AND ? GROUP BY d").all(from, to).map(r => [r.d, r.n]));
    const trend = Array.from({ length: days }, (_, i) => { const d = new Date(Date.now() - (days - 1 - i) * 864e5).toISOString().slice(0, 10); return { date: d, orders: od[d]?.n || 0, value: (od[d]?.v || 0) / 100, reservations: rd[d] || 0 }; });
    const recent = [...db.prepare("SELECT 'order' kind, order_number ref, name, created_at at, status FROM orders ORDER BY id DESC LIMIT 6").all(), ...db.prepare("SELECT 'reservation' kind, reservation_number ref, name, created_at at, status FROM reservations ORDER BY id DESC LIMIT 6").all(), ...db.prepare("SELECT 'enquiry' kind, CAST(id AS TEXT) ref, name, created_at at, status FROM messages ORDER BY id DESC LIMIT 6").all()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
    return { range: { from, to, days }, orders: o.n, order_value: o.v / 100, completed_value: done / 100, reservations_by_status: res, enquiries_open: db.prepare("SELECT COUNT(*) c FROM messages WHERE status!='done'").get().c, orders_in_progress: db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN('pending_confirmation','confirmed','preparing','ready_for_collection')").get().c, trend, recent, definitions: 'Order value = total of orders not cancelled or failed, by order created date (UTC). Reservations are counted by reservation date (restaurant local date), excluding cancelled in the trend.' };
  };
  // ---- Orders
  routes['GET /api/admin/orders'] = ({ user, q }) => {
    staff(user); const p = pg(q), c = [], s = '%' + clean(q.q, 40).toLowerCase() + '%';
    if (q.status) c.push(['status=?', clean(q.status, 40)]); if (q.q) c.push(['(lower(order_number) LIKE ? OR lower(name) LIKE ? OR lower(email) LIKE ?)', s, s, s]);
    if (D.test(q.from || '')) c.push(['substr(created_at,1,10)>=?', q.from]); if (D.test(q.to || '')) c.push(['substr(created_at,1,10)<=?', q.to]);
    const { W, A } = where(c), total = db.prepare(`SELECT COUNT(*) c FROM orders ${W}`).get(...A).c, r = page(db.prepare(`SELECT * FROM orders ${W} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...A, p.per, p.off).map(ordView), total, p);
    return { total: r.total, page: r.page, pages: r.pages, orders: r.rows };
  };
  routes['GET /api/admin/orders/:num'] = ({ user, params }) => {
    staff(user); const o = db.prepare('SELECT * FROM orders WHERE order_number=?').get(params.num); if (!o) throw E(404, 'Order not found');
    return { ...ordView(o), history: db.prepare('SELECT h.old_status, h.new_status, h.created_at, u.name by FROM order_status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.order_id=? ORDER BY h.id').all(o.id), payments: db.prepare('SELECT provider, status, amount_pence/100.0 amount, created_at FROM payments WHERE order_id=?').all(o.id) };
  };
  // ---- Reservations (status changes re-check conflicts inside a write transaction)
  const RN = { pending_confirmation: ['confirmed', 'cancelled'], confirmed: ['seated', 'cancelled', 'no_show'], seated: ['completed'] };
  const resView = r => ({ reservation_number: r.reservation_number, name: r.name, email: r.email, phone: r.phone, party_size: r.party_size, date: r.date, time: hm(r.start_min), until: hm(r.end_min), table_label: r.table_label, status: r.status, occasion: r.occasion, notes: r.notes, conflict: !!r.conflict, next: RN[r.status] || [] });
  const CONF = "SELECT r.*, (r.status IN('confirmed','pending_confirmation','seated') AND EXISTS(SELECT 1 FROM reservations x WHERE x.id<>r.id AND x.table_label=r.table_label AND x.date=r.date AND x.status IN('confirmed','pending_confirmation','seated') AND x.start_min<r.end_min AND x.end_min>r.start_min)) conflict FROM reservations r";
  routes['GET /api/admin/reservations'] = ({ user, q }) => {
    staff(user); const p = pg(q), c = [], s = '%' + clean(q.q, 40).toLowerCase() + '%';
    if (D.test(q.date || '')) c.push(['r.date=?', q.date]); if (q.status) c.push(['r.status=?', clean(q.status, 40)]); if (+q.party) c.push(['r.party_size=?', +q.party]);
    if (q.q) c.push(['(lower(r.reservation_number) LIKE ? OR lower(r.name) LIKE ? OR lower(r.email) LIKE ?)', s, s, s]);
    const { W, A } = where(c), total = db.prepare(`SELECT COUNT(*) c FROM reservations r ${W}`).get(...A).c, r = page(db.prepare(`${CONF} ${W} ORDER BY r.date DESC, r.start_min DESC LIMIT ? OFFSET ?`).all(...A, p.per, p.off).map(resView), total, p);
    return { total: r.total, page: r.page, pages: r.pages, reservations: r.rows };
  };
  routes['GET /api/admin/reservations/:num'] = ({ user, params }) => {
    staff(user); const r = db.prepare(`${CONF} WHERE r.reservation_number=?`).get(params.num); if (!r) throw E(404, 'Reservation not found');
    return { ...resView(r), history: db.prepare('SELECT h.old_status, h.new_status, h.created_at, u.name by FROM reservation_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.reservation_id=? ORDER BY h.id').all(r.id) };
  };
  routes['POST /api/admin/reservations/:num/status'] = ({ user, params, body }) => {
    staff(user); db.exec('BEGIN IMMEDIATE');
    try {
      const r = db.prepare('SELECT * FROM reservations WHERE reservation_number=?').get(params.num); if (!r) throw E(404, 'Reservation not found'); const to = clean(body.status, 30);
      if (!(RN[r.status] || []).includes(to)) throw E(409, `Cannot move a reservation from ${r.status} to ${to}.`);
      if (to === 'confirmed' && db.prepare("SELECT 1 FROM reservations WHERE id<>? AND table_label=? AND date=? AND status IN('confirmed','seated') AND start_min<? AND end_min>?").get(r.id, r.table_label, r.date, r.end_min, r.start_min)) throw E(409, 'Another booking already holds this table at that time.');
      db.prepare('UPDATE reservations SET status=? WHERE id=?').run(to, r.id); db.prepare('INSERT INTO reservation_history(reservation_id,old_status,new_status,changed_by,created_at) VALUES(?,?,?,?,?)').run(r.id, r.status, to, user.id, now());
      audit(user, 'reservation_status', 'reservation', r.reservation_number, { from: r.status, to }); db.exec('COMMIT'); return { status: to };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  // ---- Menu management (admin only for writes). Hiding keeps rows so old orders keep their links and price snapshots.
  const admin = u => { staff(u); if (u.role !== 'admin') throw E(403, 'Admin only.'); return u; };
  const CATS = () => [...new Set(db.prepare('SELECT category FROM menu_items').all().map(r => r.category))];
  const full = r => ({ ...item(r), subcategory: r.subcategory, hidden: !!r.is_hidden });
  const list = (v, n) => { if (!Array.isArray(v)) throw E(400, 'Expected a list.'); return v.map(x => clean(x, n)).filter(Boolean).slice(0, 40); };
  function vMenu(b, partial) {
    const o = {};
    if (!partial || b.name !== undefined) { const n = clean(b.name, 100); if (n.length < 2) throw E(400, 'Name is required (2–100 characters).'); o.name = n; }
    if (!partial || b.price !== undefined) { const p = Math.round(+b.price * 100); if (!Number.isFinite(+b.price) || !(p > 0 && p < 100000)) throw E(400, 'Price must be a positive number under £1000.'); o.price_pence = p; }
    if (!partial || b.category !== undefined) { if (!CATS().includes(b.category)) throw E(400, 'Choose a valid category.'); o.category = b.category; }
    for (const [k, n] of [['short_description', 200], ['description', 2000], ['serving', 200], ['chef_notes', 500], ['subcategory', 60]]) if (b[k] !== undefined) o[k] = clean(b[k], n);
    if (b.ingredients !== undefined) o.ingredients = JSON.stringify(list(b.ingredients, 80)); if (b.dietary_tags !== undefined) o.dietary_tags = JSON.stringify(list(b.dietary_tags, 80));
    if (b.allergens !== undefined) { if (!Array.isArray(b.allergens)) throw E(400, 'Expected a list.'); o.allergens = JSON.stringify(b.allergens.slice(0, 20).map(a => ({ name: clean(a && a.name, 60), status: clean(a && a.status, 80) || 'verify' })).filter(a => a.name)); }
    return o;
  }
  routes['GET /api/admin/menu'] = ({ user }) => (staff(user), { items: db.prepare('SELECT * FROM menu_items ORDER BY rowid').all().map(full), categories: CATS() });
  routes['POST /api/admin/menu'] = ({ user, body }) => {
    admin(user); const o = vMenu(body, false), n = db.prepare('SELECT COUNT(*) c FROM menu_items').get().c;
    let slug = o.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dish', s = slug, i = 2; while (db.prepare('SELECT 1 FROM menu_items WHERE slug=?').get(s)) s = slug + '-' + i++;
    const id = 'ME-' + String(n + 1).padStart(3, '0') + '-' + Math.random().toString(36).slice(2, 5);
    db.prepare('INSERT INTO menu_items(id,slug,name,category,subcategory,price_pence,serving,short_description,description,ingredients,allergens,dietary_tags,spice,is_available,featured,chef_notes,image,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, s, o.name, o.category, o.subcategory || '', o.price_pence, o.serving || '', o.short_description || '', o.description || '', o.ingredients || '[]', o.allergens || '[]', o.dietary_tags || '[]', 'none', 1, 0, o.chef_notes || '', null, now());
    audit(user, 'menu_create', 'menu_item', s, { price_pence: o.price_pence }); return { slug: s };
  };
  routes['GET /api/admin/menu/:slug'] = ({ user, params }) => { staff(user); const r = db.prepare('SELECT * FROM menu_items WHERE slug=?').get(params.slug); if (!r) throw E(404, 'Dish not found'); return { ...full(r), price_history: db.prepare('SELECT old_pence/100.0 old_price, new_pence/100.0 new_price, created_at FROM price_history WHERE menu_item_id=? ORDER BY id DESC LIMIT 20').all(r.id) }; };
  routes['POST /api/admin/menu/:slug/update'] = ({ user, params, body }) => {
    admin(user); const m = db.prepare('SELECT * FROM menu_items WHERE slug=?').get(params.slug); if (!m) throw E(404, 'Dish not found'); const o = vMenu(body, true), k = Object.keys(o);
    if (!k.length) throw E(400, 'Nothing to update.'); db.prepare(`UPDATE menu_items SET ${k.map(x => x + '=?').join(',')}, updated_at=? WHERE id=?`).run(...k.map(x => o[x]), now(), m.id);
    if (o.price_pence !== undefined && o.price_pence !== m.price_pence) db.prepare('INSERT INTO price_history(menu_item_id,old_pence,new_pence,changed_by,created_at) VALUES(?,?,?,?,?)').run(m.id, m.price_pence, o.price_pence, user.id, now());
    audit(user, 'menu_update', 'menu_item', m.slug, { fields: k }); return { ok: true };
  };
  routes['POST /api/admin/menu/:slug/visibility'] = ({ user, params, body }) => {
    admin(user); const m = db.prepare('SELECT * FROM menu_items WHERE slug=?').get(params.slug); if (!m) throw E(404, 'Dish not found'); const h = body.hidden ? 1 : 0;
    db.prepare('UPDATE menu_items SET is_hidden=?, is_available=?, updated_at=? WHERE id=?').run(h, h ? 0 : 1, now(), m.id); audit(user, h ? 'menu_hide' : 'menu_show', 'menu_item', m.slug); return { hidden: !!h };
  };
  // ---- Enquiries, email outbox, audit, settings
  routes['GET /api/admin/enquiries'] = ({ user, q }) => { staff(user); const c = []; if (q.kind) c.push(['kind=?', clean(q.kind, 30)]); if (q.status) c.push(['status=?', clean(q.status, 30)]); const { W, A } = where(c); return { enquiries: db.prepare(`SELECT id,kind,name,email,subject,body,status,note,created_at FROM messages ${W} ORDER BY id DESC LIMIT 200`).all(...A) }; };
  routes['POST /api/admin/enquiries/:id/status'] = ({ user, params, body }) => {
    staff(user); const s = clean(body.status, 20); if (!['new', 'in_progress', 'done'].includes(s)) throw E(400, 'Invalid status.');
    const r = db.prepare('UPDATE messages SET status=?, note=COALESCE(?,note) WHERE id=?').run(s, body.note === undefined ? null : clean(body.note, 1000), +params.id); if (!r.changes) throw E(404, 'Enquiry not found');
    audit(user, 'enquiry_status', 'enquiry', params.id, { status: s }); return { status: s };
  };
  routes['GET /api/admin/email-outbox'] = ({ user }) => (staff(user), { note: 'Rows are records only. Email delivery is not configured, so nothing here has been sent.', emails: db.prepare('SELECT id,to_addr,subject,sent,created_at FROM email_outbox ORDER BY id DESC LIMIT 100').all().map(e => ({ ...e, sent: !!e.sent, delivery: e.sent ? 'sent' : 'recorded only — not sent' })) });
  routes['GET /api/admin/audit'] = ({ user }) => (staff(user), { logs: db.prepare('SELECT a.action, a.entity, a.entity_ref, a.detail, a.created_at, u.name actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 50').all() });
  routes['GET /api/admin/settings'] = ({ user }) => (staff(user), { llm_configured: !!process.env.OLLAMA_URL, llm_model: process.env.OLLAMA_URL ? process.env.OLLAMA_MODEL || 'llama3.2' : null, online_payments: !!process.env.STRIPE_SECRET_KEY, email_delivery: 'not configured (outbox only)', timezone_note: 'Stored timestamps are UTC; reservation dates are restaurant local dates.' });
};
