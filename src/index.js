const crypto = require('crypto');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const cfg = require('./config');
const db = require('./db');
const wa = require('./wa');
const pay = require('./pay');
const bot = require('./bot');
const jobs = require('./jobs');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.raw = buf; } }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.get('/health', (_req, res) => res.json({ ok: true }));

const page = (title, body, extraCss = '') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/edeal-icon.svg"><meta property="og:image" content="/edeal-whatsapp-dp.png">
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:20px;line-height:1.6;color:#14231a}h1{font-size:24px}h2{font-size:18px;margin-top:24px}
.btn{display:inline-block;background:#00a884;color:#fff;text-decoration:none;padding:12px 20px;border-radius:24px;font-weight:600}.muted{color:#5b6b60;font-size:14px}
table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #e5ece7;text-align:left}${extraCss}</style></head><body>${body}</body></html>`;

// ---------- public landing page
app.get('/', async (_req, res) => {
  const P = await db.plans();
  const botNo = (process.env.BOT_PHONE || '').replace(/\D/g, '');
  const wa_link = botNo ? `https://wa.me/${botNo.length === 10 ? '91' + botNo : botNo}?text=Hi` : null;
  res.send(page(`${cfg.BRAND} – Local offers on WhatsApp`, `<p><img src="/edeal-logo.svg" alt="${esc(cfg.BRAND)}" style="height:64px"></p>
<h1>Offers, events, classes and homes near you – on WhatsApp</h1>
<p>Say <b>Hi</b> on WhatsApp, share your location and see today's sales, discounts, tuition &amp; schools, local events, and houses for rent or sale within 2–5 km. No app, no login.</p>
${wa_link ? `<p><a class="btn" href="${wa_link}">💬 Open ${esc(cfg.BRAND)} on WhatsApp</a></p>` : ''}
<h2>For businesses</h2><p>Shops, restaurants, salons, tutors, coaching centres, schools, house owners and brokers: reach people near you every day. Send <b>business</b> to the bot to start with a <b>${P.trial.days}-day free trial</b>.</p>
<table><tr><th>Plan</th><th>Price</th><th>What you get</th></tr>
<tr><td>Free trial</td><td>₹0 · ${P.trial.days} days</td><td>1 ad, 2 km</td></tr><tr><td>1 Day</td><td>₹${P.day.price}</td><td>1 ad for a day, 2 km</td></tr>
<tr><td>7 Days</td><td>₹${P.week.price}</td><td>1 ad for a week, 2 km</td></tr><tr><td>Monthly</td><td>₹${P.month.price}/month</td><td>Unlimited ads &amp; events, 2 km</td></tr>
<tr><td>Premium</td><td>₹${P.premium.price}/month</td><td>Unlimited ads, 5 km, featured on top and in the 9 AM daily message</td></tr></table>
<p class="muted"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/delete-data">Delete your data</a> · info@vasulbook.com</p>`));
});
app.get('/privacy', (_req, res) => res.send(page('Privacy Policy', `<h1>${esc(cfg.BRAND)} – Privacy Policy</h1>
<p>${esc(cfg.BRAND)} (operated by VasulBook, vasulbook.com) shows local offers, events, education and property ads on WhatsApp.</p>
<h2>What we collect</h2><p>Your WhatsApp number and profile name, messages you send to our number, the location you share (to show ads near you), your distance setting, coupons you take, and enquiries you send. Businesses provide their name, category, location, ads and photos.</p>
<h2>How we use it</h2><p>To show ads near you, send the daily offers message if you turned it on, and pass your enquiry to the business you chose. When you tap Contact, Book a demo, Book a visit or I'm interested, your name and number are shared with that business. We do not sell your data.</p>
<h2>Processors</h2><p>Meta (WhatsApp), our hosting provider, and Razorpay for business payments.</p>
<h2>Deletion</h2><p>Send "delete my data" to our WhatsApp number, or email info@vasulbook.com. Send STOP to stop daily messages.</p>`)));
app.get('/terms', async (_req, res) => {
  const P = await db.plans();
  res.send(page('Terms', `<h1>${esc(cfg.BRAND)} – Terms</h1><p>Businesses are responsible for their ads, offers, prices and listings, and must honour coupons shown to customers. Ads are reviewed before going live and can be removed if misleading or not allowed. Plans: ₹${P.day.price} (1 day), ₹${P.week.price} (7 days), ₹${P.month.price}/month, ₹${P.premium.price}/month Premium; a ${P.trial.days}-day free trial once per business. Payments are non-refundable once an ad has gone live. Contact: info@vasulbook.com</p>`));
});
app.get('/delete-data', (_req, res) => res.send(page('Data deletion', `<h1>Delete your data</h1><p>Send "delete my data" to our WhatsApp number or email info@vasulbook.com with your phone number. We delete your data within 30 days, except records the law requires us to keep.</p>`)));

// ---------- ad photos
app.get('/m/:id.jpg', async (req, res) => {
  const m = await db.one('select mime, data from media where id=$1', [+req.params.id || 0]);
  if (!m) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=604800').type(m.mime || 'image/jpeg').send(m.data);
});

// ---------- direct UPI payment page (QR + open UPI app)
app.get('/pay/:id', async (req, res) => {
  const p = await db.one('select p.*, v.name from payments p join advertisers v on v.id=p.adv_id where p.id=$1', [+req.params.id || 0]);
  if (!p || !cfg.ADMIN_UPI) return res.status(404).send(page('Not found', '<p>Payment not found.</p>'));
  const P = await db.plans();
  if (p.status === 'paid') return res.send(page('Paid', `<h1>✅ Paid</h1><p>${esc(p.name)} – ${esc(P[p.plan].name)} plan is active. You can close this page.</p>`));
  const uri = pay.upiUri(p), qr = await QRCode.toDataURL(uri, { margin: 1, width: 260 });
  res.send(page(`Pay ₹${p.amount} – ${cfg.BRAND}`, `<div style="text-align:center"><img src="/edeal-logo.svg" style="height:52px" alt=""><h1>Pay ₹${p.amount}</h1>
<p>${esc(p.name)} · ${esc(P[p.plan].name)} plan · Ref ${pay.ref(p)}</p>
<p><a class="btn" href="${esc(uri)}">Open GPay / PhonePe / Paytm</a></p><p class="muted">or scan this QR from another phone</p><img src="${qr}" width="240" height="240" alt="UPI QR">
<p>UPI ID: <b>${esc(cfg.ADMIN_UPI)}</b></p><p class="muted">After paying, go back to WhatsApp, tap <b>I've paid</b> and send the UPI reference number.</p>
${p.link_url ? `<p class="muted">Prefer card / auto-confirm? <a href="${esc(p.link_url)}">Pay with Razorpay</a></p>` : ''}</div>`));
});

// ---------- Meta webhook
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.WA_VERIFY) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});
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
      else if (m.type === 'image') { v = 'img:' + m.image.id; btn = true; }
      if (!v) { enqueue(m.from, () => wa.sendText(m.from, 'Please send a text message, or type *menu*.')); continue; }
      wa.markRead(m.id);
      enqueue(m.from, () => bot.handle(m.from, names[m.from] || '', v, btn));
    }
  }
});

// ---------- Razorpay webhook (event: payment_link.paid)
app.post('/razorpay/webhook', async (req, res) => {
  if (!pay.verifyWebhook(req.raw, req.get('x-razorpay-signature'))) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    if (req.body.event !== 'payment_link.paid') return;
    const link = req.body.payload.payment_link.entity;
    const p = await db.one(`update payments set method='razorpay' where link_id=$1 and status<>'paid' returning *`, [link.id]);
    if (p) await bot.confirmPayment(p.id);
  } catch (e) { console.error('razorpay webhook', e); }
});

// ---------- web admin panel
app.use('/panel', require('./panel'));
app.get('/admin', (_req, res) => res.redirect('/panel'));

// ---------- WhatsApp setup check: token, webhook subscription, templates, business profile
async function waDiagnose() {
  if (!cfg.WA_TOKEN) return { error: 'WA_TOKEN not set' };
  const out = {};
  const g = (p, method = 'GET', body) => wa.graph(p, { method, ...(body ? { body: JSON.stringify(body) } : {}) }).catch((e) => ({ error: e.message }));
  out.phone = await g(`${cfg.WA_PHONE_ID}?fields=display_phone_number,verified_name,code_verification_status,quality_rating,status`);
  if (process.env.WA_PIN && out.phone && out.phone.status && out.phone.status !== 'CONNECTED') out.register = await g(`${cfg.WA_PHONE_ID}/register`, 'POST', { messaging_product: 'whatsapp', pin: process.env.WA_PIN });
  // Point just this phone number's webhook at this server (Meta "webhook override")
  if (process.env.WA_WEBHOOK_OVERRIDE === '1' && cfg.PUBLIC_URL) {
    out.webhook_override = await g(cfg.WA_PHONE_ID, 'POST', { webhook_configuration: { override_callback_uri: `${cfg.PUBLIC_URL}/webhook`, verify_token: cfg.WA_VERIFY } });
  }
  const w = process.env.WA_WABA_ID;
  if (w) {
    out.subscribe = await g(`${w}/subscribed_apps`, 'POST');
    const ensure = async (name, category, text, example) => {
      const found = await g(`${w}/message_templates?name=${name}&fields=name,status,category`);
      if (found && found.data && found.data.length) return found.data;
      return g(`${w}/message_templates`, 'POST', { name, language: cfg.WA_TEMPLATE_LANG, category, components: [{ type: 'BODY', text, example: { body_text: [[example]] } }] });
    };
    if (cfg.WA_TEMPLATE) out.template = await ensure(cfg.WA_TEMPLATE, 'UTILITY', `${cfg.BRAND} update: {{1}}\n\nReply here to see your menu.`, 'Your ad “Weekend sale” is now live for people within 2 km.');
    if (cfg.WA_DIGEST_TEMPLATE) out.digest_template = await ensure(cfg.WA_DIGEST_TEMPLATE, 'MARKETING', `☀️ Good morning! Top offers near you today: {{1}}\n\nReply HI to see all offers. Reply STOP to stop these messages.`, '1. Weekend grocery sale – Flat 20% off on oils (Fresh Mart, 600 m) | 2. Lunch combo – Meals at ₹99 (Annapoorna, 1.2 km)');
  }
  if (process.env.WA_SET_PROFILE !== '0') {
    out.profile = await g(`${cfg.WA_PHONE_ID}/whatsapp_business_profile`, 'POST', {
      messaging_product: 'whatsapp', about: 'Local offers, events, classes & homes near you'.slice(0, 139),
      description: `${cfg.BRAND}: sales, discounts, tuition & schools, events and houses for rent or sale within 2–5 km of you – on WhatsApp. Businesses: send "business" to advertise.`,
      vertical: 'RETAIL', websites: [cfg.WEBSITE],
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
  jobs.start();
  return app.listen(cfg.PORT, () => console.log(`${cfg.BRAND} listening on ${cfg.PORT} · admins ${cfg.ADMINS.join(',')}`));
}
if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start };
