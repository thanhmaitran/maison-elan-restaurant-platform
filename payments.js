'use strict';
// Payment methods: pay at table / pay on collection (always on) and card + QR via Stripe Checkout (needs STRIPE_SECRET_KEY).
// Card details never touch this server: customers pay on Stripe's hosted page; the QR code simply encodes that page's URL.
const crypto = require('crypto');
module.exports = function (db, routes, H) {
  const { E, clean, now, limited } = H;
  const KEY = process.env.STRIPE_SECRET_KEY, WH = process.env.STRIPE_WEBHOOK_SECRET;
  db.exec(`CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, order_id INTEGER, provider TEXT, provider_ref TEXT, amount_pence INTEGER, status TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS payment_events(event_id TEXT PRIMARY KEY, type TEXT, processed_at TEXT);`);
  for (const c of ["service_type TEXT DEFAULT 'collection'", 'table_number TEXT', 'payment_method TEXT']) try { db.exec('ALTER TABLE orders ADD COLUMN ' + c); } catch { }
  const base = req => process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const orig = routes['POST /api/orders'];
  routes['POST /api/orders'] = ctx => {
    const b = ctx.body, dine = b.service_type === 'dine_in', st = dine ? 'dine_in' : 'collection', venue = dine ? 'at_table' : 'on_collection';
    const method = clean(b.payment_method, 20) || venue;
    if (![venue, 'card', 'qr'].includes(method)) throw E(400, 'Please choose a valid payment method.');
    if (method !== venue && !KEY) throw E(400, 'Online payment is not available yet.');
    let table = null;
    if (dine) { table = clean(b.table_number, 10).toUpperCase(); if (!db.prepare('SELECT 1 FROM tables_ WHERE label=? AND active=1').get(table)) throw E(400, 'Please choose a valid table number.'); }
    const r = orig(ctx);
    if (!r.duplicate) db.prepare('UPDATE orders SET order_type=?,service_type=?,table_number=?,payment_method=?,payment_status=? WHERE order_number=?').run(st, st, table, method, method === venue ? 'unpaid_' + method : 'awaiting_payment', r.order_number);
    return { ...r, service_type: st, table_number: table, payment_method: method };
  };
  routes['GET /api/checkout/options'] = () => ({ tables: db.prepare('SELECT label FROM tables_ WHERE active=1 ORDER BY label').all().map(t => t.label), card: !!KEY, qr: !!KEY });
  routes['POST /api/orders/:num/pay'] = async ({ params, body, req, ip }) => {
    if (!KEY) throw E(503, 'Online payment is not available yet.');
    if (limited(ip, 'pay', 10)) throw E(429, 'Too many requests');
    const o = db.prepare('SELECT * FROM orders WHERE order_number=? AND lower(email)=lower(?)').get(params.num, clean(body.email, 254));
    if (!o) throw E(404, 'Order not found.');
    if (o.payment_status !== 'awaiting_payment' || ['cancelled', 'failed'].includes(o.status)) throw E(409, 'This order cannot be paid online.');
    const u = base(req), f = new URLSearchParams({ mode: 'payment', 'payment_method_types[0]': 'card', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'gbp', 'line_items[0][price_data][unit_amount]': String(o.total_pence), 'line_items[0][price_data][product_data][name]': 'Maison Élan order ' + o.order_number, client_reference_id: o.order_number, customer_email: o.email, success_url: `${u}/#/paid/${o.order_number}`, cancel_url: `${u}/#/checkout`, 'metadata[order_number]': o.order_number });
    let r; try { r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: f }); } catch { throw E(502, 'Could not reach the payment provider. Please try again.'); }
    const s = await r.json().catch(() => ({}));
    if (!r.ok || !s.url) throw E(502, 'The payment provider could not start the payment.');
    db.prepare('INSERT INTO payments(order_id,provider,provider_ref,amount_pence,status,created_at) VALUES(?,?,?,?,?,?)').run(o.id, 'stripe', s.id, o.total_pence, 'created', now());
    return { url: s.url };
  };
  // Webhook: verifies Stripe's HMAC signature, ignores repeated events, and only marks an order paid if amount and currency match.
  routes['POST /api/payments/webhook'] = ({ raw, req, body }) => {
    if (!WH) throw E(503, 'Webhook is not configured.');
    const p = Object.fromEntries(String(req.headers['stripe-signature'] || '').split(',').map(x => x.split('=')));
    const exp = crypto.createHmac('sha256', WH).update(`${p.t}.${raw}`).digest('hex');
    if (!p.v1 || p.v1.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(p.v1), Buffer.from(exp)) || Math.abs(Date.now() / 1000 - +p.t) > 300) throw E(400, 'Invalid signature');
    if (!db.prepare('INSERT OR IGNORE INTO payment_events(event_id,type,processed_at) VALUES(?,?,?)').run(String(body.id), String(body.type), now()).changes) return { received: true, duplicate: true };
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(body.type)) {
      const s = body.data.object, o = db.prepare('SELECT * FROM orders WHERE order_number=?').get(s.client_reference_id);
      if (o && s.payment_status === 'paid' && s.amount_total === o.total_pence && s.currency === 'gbp') {
        db.prepare("UPDATE orders SET payment_status='paid_online' WHERE id=? AND payment_status='awaiting_payment'").run(o.id);
        db.prepare("UPDATE payments SET status='paid' WHERE provider_ref=?").run(s.id);
      }
    }
    return { received: true };
  };
};
