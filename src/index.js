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
      else if (m.type === 'location') { const L = m.location; v = `loc:${L.latitude},${L.longitude}|${[L.name, L.address].filter(Boolean).join(', ')}`; btn = true; }
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

// --- web admin panel (WhatsApp OTP login)
app.use('/panel', require('./panel'));

// --- web dashboard for the admin
app.get('/admin', async (req, res) => {
  if (req.query.key !== cfg.ADMIN_KEY) return res.status(401).send('Unauthorized');
  res.send(await dashboard.html(req.query.key));
});

// Checks the token and links the WhatsApp Business Account to this app's webhook.
async function waDiagnose() {
  const out = {};
  if (!cfg.WA_TOKEN) return { error: 'WA_TOKEN not set' };
  const g = async (path, method = 'GET') => {
    const r = await fetch(`https://graph.facebook.com/${cfg.WA_API_VERSION}/${path}`, { method, headers: { Authorization: 'Bearer ' + cfg.WA_TOKEN } });
    return r.json().catch(() => ({ status: r.status }));
  };
  out.phone = await g(`${cfg.WA_PHONE_ID}?fields=display_phone_number,verified_name,code_verification_status,quality_rating,platform_type,status`);
  // Real numbers must be registered on Cloud API once (needs a 6-digit PIN in WA_PIN).
  if (process.env.WA_PIN && out.phone && out.phone.status && out.phone.status !== 'CONNECTED') {
    const r = await fetch(`https://graph.facebook.com/${cfg.WA_API_VERSION}/${cfg.WA_PHONE_ID}/register`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + cfg.WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin: process.env.WA_PIN }),
    });
    out.register = await r.json().catch(() => ({ status: r.status }));
  }
  // What does this token cover? (scopes + WhatsApp account IDs)
  const dbg = await g(`debug_token?input_token=${encodeURIComponent(cfg.WA_TOKEN)}`);
  const d = (dbg && dbg.data) || {};
  out.token = { valid: d.is_valid, app_id: d.app_id, type: d.type, expires_at: d.expires_at, scopes: d.scopes, granular_scopes: d.granular_scopes, error: dbg.error && dbg.error.message };
  const ids = new Set();
  if (process.env.WA_WABA_ID) ids.add(process.env.WA_WABA_ID);
  for (const gs of d.granular_scopes || []) if (/whatsapp/.test(gs.scope)) (gs.target_ids || []).forEach((x) => ids.add(x));
  out.wabas = {};
  for (const id of ids) {
    const info = await g(`${id}?fields=id,name`);
    const phones = await g(`${id}/phone_numbers?fields=id,display_phone_number`);
    const sub = await g(`${id}/subscribed_apps`, 'POST');
    const list = await g(`${id}/subscribed_apps`);
    out.wabas[id] = { info, phones, subscribe: sub, subscribed_apps: list };
  }
  const post = async (path, body) => {
    const r = await fetch(`https://graph.facebook.com/${cfg.WA_API_VERSION}/${path}`, { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.WA_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => ({ status: r.status }));
  };
  // Alert template for messages outside WhatsApp's 24-hour window (created once, then Meta reviews it)
  if (cfg.WA_TEMPLATE && process.env.WA_WABA_ID) {
    const w = process.env.WA_WABA_ID;
    const found = await g(`${w}/message_templates?name=${cfg.WA_TEMPLATE}&fields=name,status,category,language`);
    if (found && found.data && found.data.length) out.template = found.data;
    else {
      out.template_create = await post(`${w}/message_templates`, {
        name: cfg.WA_TEMPLATE, language: cfg.WA_TEMPLATE_LANG, category: 'UTILITY',
        components: [{ type: 'BODY', text: `${cfg.BRAND} update: {{1}}\n\nReply here to see your menu.`, example: { body_text: [['Your order #1023 is ready for pickup at Fresh Mart.']] } }],
      });
    }
  }
  // WhatsApp business profile (about, description, category, website)
  if (process.env.WA_SET_PROFILE !== '0') {
    out.profile = await post(`${cfg.WA_PHONE_ID}/whatsapp_business_profile`, {
      messaging_product: 'whatsapp',
      about: `Order from local shops on WhatsApp – ${cfg.BRAND}`.slice(0, 139),
      description: `${cfg.BRAND}: order groceries from shops near you on WhatsApp. Pickup or home delivery, pay by UPI or cash, invoice in chat.`,
      vertical: 'GROCERY',
      websites: [process.env.BRAND_WEBSITE || 'https://emart.vasulbook.com'],
    });
  }
  return out;
}
app.get('/admin/wa-check', async (req, res) => {
  if (req.query.key !== cfg.ADMIN_KEY) return res.status(401).send('Unauthorized');
  res.json(await waDiagnose());
});

async function start() {
  await db.init();
  waDiagnose().then((d) => console.log('WA check:', JSON.stringify(d))).catch((e) => console.error('WA check failed', e.message));
  return app.listen(cfg.PORT, () => console.log(`${cfg.BRAND} listening on ${cfg.PORT} · admins ${cfg.ADMINS.join(',')}`));
}
if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start };
