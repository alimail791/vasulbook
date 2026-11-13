const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const wa = require('./wa');
const pay = require('./pay');
const bot = require('./bot');
const invoice = require('./invoice');
const dashboard = require('./dashboard');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.raw = buf; } }));

app.get('/', (_req, res) => res.send(`${cfg.BRAND} WhatsApp bot is running.`));
app.get('/health', (_req, res) => res.json({ ok: true }));

const page = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} – ${cfg.BRAND}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;line-height:1.6;color:#222}h1{font-size:22px}h2{font-size:17px;margin-top:22px}</style></head><body>${body}</body></html>`;
app.get('/privacy', (_req, res) => res.send(page('Privacy Policy', `<h1>${cfg.BRAND} – Privacy Policy</h1>
<p>${cfg.BRAND} (operated by VasulBook, vasulbook.com) lets customers order from local shops on WhatsApp.</p>
<h2>What we collect</h2><p>Your WhatsApp number and profile name, the messages you send to our WhatsApp number, your orders, and the delivery address you share. Shops provide their name, area, owner number, UPI ID, items, prices and stock.</p>
<h2>How we use it</h2><p>Only to take and deliver your orders, send order updates and invoices, show shops their orders and sales, and bill shops for our service. We do not sell your data or use it for third-party advertising.</p>
<h2>Who sees it</h2><p>The shop you order from sees your name, number, order and address. Our delivery staff see delivery details. Data is processed by Meta (WhatsApp), our hosting provider and, for shop payments, Razorpay.</p>
<h2>Retention & deletion</h2><p>Order records are kept for accounting. To delete your data, send "delete my data" to our WhatsApp number or email info@vasulbook.com.</p>
<h2>Contact</h2><p>info@vasulbook.com</p>`)));
app.get('/terms', (_req, res) => res.send(page('Terms', `<h1>${cfg.BRAND} – Terms of Service</h1>
<p>Shops listed on ${cfg.BRAND} are independent sellers responsible for their products, prices, stock and invoices. Customers pay the shop directly (UPI or cash). Shops pay a one-time setup fee of ₹${cfg.SETUP_FEE} and a service fee of ${cfg.COMM * 100}% of monthly sales. Home delivery, where offered, is provided by ${cfg.BRAND}. Contact: info@vasulbook.com</p>`)));
app.get('/delete-data', (_req, res) => res.send(page('Data deletion', `<h1>Delete your data</h1><p>Send "delete my data" to our WhatsApp number or email info@vasulbook.com with your phone number. We delete your data within 30 days, except records the law requires us to keep.</p>`)));

// --- Meta webhook verification
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.WA_VERIFY) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

// --- one message at a time per phone, ignore duplicates
const queues = new Map();
const seen = new Set();
function enqueue(phone, job) {
  const prev = queues.get(phone) || Promise.resolve();
  const next = prev.then(job).catch((e) => console.error(e)).finally(() => { if (queues.get(phone) === next) queues.delete(phone); });
  queues.set(phone, next);
}

app.post('/webhook', (req, res) => {
  if (cfg.WA_APP_SECRET) {
    const sig = 'sha256=' + crypto.createHmac('sha256', cfg.WA_APP_SECRET).update(req.raw || '').digest('hex');
    if (sig !== req.get('x-hub-signature-256')) return res.sendStatus(401);
  }
  res.sendStatus(200);
  for (const e of req.body.entry || []) for (const ch of e.changes || []) {
    const val = ch.value || {};
    // Ignore events for other numbers on the same Meta app (e.g. the Raise Academy bot)
    if (cfg.WA_PHONE_ID && val.metadata && val.metadata.phone_number_id && val.metadata.phone_number_id !== cfg.WA_PHONE_ID) continue;
    const names = Object.fromEntries((val.contacts || []).map((x) => [x.wa_id, x.profile && x.profile.name]));
    for (const m of val.messages || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id); if (seen.size > 5000) seen.delete(seen.values().next().value);
      let v = null, btn = false;
      if (m.type === 'text') v = m.text.body;
      else if (m.type === 'interactive') { const r = m.interactive.button_reply || m.interactive.list_reply; v = r && r.id; btn = true; }
      else if (m.type === 'button') { v = m.button.payload || m.button.text; btn = !!m.button.payload; }
      else if (m.type === 'location') { const L = m.location; v = [L.name, L.address, `https://maps.google.com/?q=${L.latitude},${L.longitude}`].filter(Boolean).join(', '); }
      if (!v) { enqueue(m.from, () => wa.sendText(m.from, 'Please send a text message, or type *menu*.')); continue; }
      wa.markRead(m.id);
      enqueue(m.from, () => bot.handle(m.from, names[m.from] || '', v, btn));
    }
  }
});

// --- Razorpay webhook (setup fee + monthly bill)
app.post('/razorpay/webhook', async (req, res) => {
  if (!pay.verifyWebhook(req.raw, req.get('x-razorpay-signature'))) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    if (req.body.event !== 'payment_link.paid') return;
    const link = req.body.payload.payment_link.entity;
    const p = await db.one(`update payments set status='paid', paid_at=now() where link_id=$1 and status<>'paid' returning *`, [link.id]);
    if (!p) return;
    const s = await db.shops.get(p.ref);
    if (p.kind === 'setup') await bot.activate(s);
    if (p.kind === 'bill') {
      await bot.notify(s.owner_phone, `✅ Payment of ${bot.rs(p.amount)} received. Thank you!`);
      await bot.notifyAdmins(`💰 ${s.name} paid the ${p.month} bill: ${bot.rs(p.amount)}`);
    }
  } catch (e) { console.error('razorpay webhook', e); }
});

// --- invoice PDF
app.get('/inv/:token.pdf', async (req, res) => {
  const o = await db.one('select * from orders where token=$1', [req.params.token]);
  if (!o) return res.sendStatus(404);
  const s = await db.shops.get(o.shop_id);
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${o.inv}.pdf"`).send(await invoice.pdf(o, s));
});

// --- web dashboard for the admin
app.get('/admin', async (req, res) => {
  if (req.query.key !== cfg.ADMIN_KEY) return res.status(401).send('Unauthorized');
  res.send(await dashboard.html(req.query.key));
});

async function start() {
  await db.init();
  return app.listen(cfg.PORT, () => console.log(`${cfg.BRAND} listening on ${cfg.PORT} · admins ${cfg.ADMINS.join(',')}`));
}
if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start };
