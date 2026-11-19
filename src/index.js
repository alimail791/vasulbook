const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const wa = require('./wa');
const pay = require('./pay');
const bot = require('./bot');
const invoice = require('./invoice');
const dashboard = require('./dashboard');
const network = require('./network');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.raw = buf; } }));

app.get('/', (_req, res) => res.redirect('/shops'));
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
    if (p.kind === 'setup') { if (!(await bot.activate(s, p))) await bot.earn(p, s); }
    if (p.kind === 'bill') await bot.billPaid(p);
  } catch (e) { console.error('razorpay webhook', e); }
});

// --- invoice PDF
app.get('/inv/:token.pdf', async (req, res) => {
  const o = await db.one('select * from orders where token=$1', [req.params.token]);
  if (!o) return res.sendStatus(404);
  const s = await db.shops.get(o.shop_id);
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${o.inv}.pdf"`).send(await invoice.pdf(o, s));
});

// --- website shop: browse shops, cart and order in the browser
app.use('/', require('./web'));

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
    // Same template in English, Tamil and Hindi (one per language; Meta reviews each)
    const found = await g(`${w}/message_templates?name=${cfg.WA_TEMPLATE}&fields=name,status,category,language&limit=50`);
    const have = new Set(((found && found.data) || []).filter((t) => t.name === cfg.WA_TEMPLATE).map((t) => t.language));
    const ex = ((found && found.data) || []).find((t) => t.name === cfg.WA_TEMPLATE), cat = (ex && ex.category) || 'UTILITY';
    const texts = {
      [cfg.WA_TEMPLATE_LANG]: `${cfg.BRAND} update: {{1}}\n\nReply here to see your menu.`,
      ta: `${cfg.BRAND} அறிவிப்பு: {{1}}\n\nஉங்கள் மெனுவைப் பார்க்க இங்கே பதில் அனுப்பவும்.`,
      hi: `${cfg.BRAND} अपडेट: {{1}}\n\nअपना मेनू देखने के लिए यहाँ जवाब दें।`,
    };
    out.template = {};
    for (const [lang, text] of Object.entries(texts)) {
      out.template[lang] = have.has(lang) ? 'exists' : await post(`${w}/message_templates`, {
        name: cfg.WA_TEMPLATE, language: lang, category: cat,
        components: [{ type: 'BODY', text, example: { body_text: [['Your order #1023 is ready for pickup at Fresh Mart.']] } }],
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

// Monthly bills: last month's 2% bill goes out on the 1st (from 10 AM IST); reminders on the 5th and 10th.
// EMart 3-month target: at least 15 shops in the zone have paid the setup fee since the admin started
const SHOP_TARGET = Number(process.env.NET_SHOP_TARGET || 15);
async function zoneTarget(a) {
  const n = (await db.one(`select count(*)::int n from shops where area_id=$1 and paid and paid_at >= $2`, [a.id, a.admin_since])).n;
  return { ok: n >= SHOP_TARGET, line: `${n} of ${SHOP_TARGET} shops onboarded` };
}
network.setIdleCheck(async (a) => !(await db.one(`select 1 from shops where area_id=$1 and created_at > now() - interval '60 days'
  union all select 1 from payments where area_id=$1 and status='paid' and paid_at > now() - interval '60 days' limit 1`, [a.id])));
require('./wa').setTemplateHook(() => network.countMsg('template'));
async function billingJob() {
  const ist = new Date(Date.now() + 5.5 * 36e5), day = ist.getUTCDate(), hour = ist.getUTCHours();
  if (hour < 10 || process.env.AUTO_BILLS === '0') return;
  const mk = bot.PREV_MONTH_KEY();
  const once = async (key, fn) => {
    const r = await db.one(`insert into kv(key,value) values($1,'1') on conflict(key) do nothing returning key`, [key]);
    if (r) { const n = await fn(); console.log(key, n); }
  };
  await once('bills:' + mk, () => bot.sendBills(mk));
  // Monthly statement to every zone admin and supervisor
  await once('stmt:' + mk, async () => { const ps = await network.statementPhones(mk); for (const p of ps) await bot.notify(p, await network.statementText(p, mk), [['💰 My earnings', 'myearn']]); return ps.length; });
  await once('gold:' + mk, () => network.goldCheck(bot.notify));
  // Daily: 3-month reviews and zones with no activity
  await once('review:' + new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10), async () => (await network.reviewZones(zoneTarget, bot.notify, bot.notifyAdmins)).length);
  if (day >= 5) await once('remind5:' + mk, () => bot.remindBills(mk));
  if (day >= 10) await once('remind10:' + mk, () => bot.remindBills(mk));
}
app.get('/r/:code', (req, res) => res.redirect(`/?ref=${encodeURIComponent(req.params.code)}`));

// Zone admin posters and QR codes (public: they only carry the referral link)
const poster = require('./poster');
const zoneByCode = (c) => db.one('select * from areas where upper(ref_code)=$1', [String(c || '').toUpperCase()]);
app.get('/poster/:code.pdf', async (req, res) => {
  const z = await zoneByCode(req.params.code); if (!z) return res.sendStatus(404);
  const p = z.admin_phone ? await db.one('select name from payees where phone=$1', [z.admin_phone]) : null;
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${cfg.BRAND}-poster-${z.ref_code}.pdf"`).send(await poster.pdf(z, 'emart', p && p.name));
});
app.get('/qr/:code.png', async (req, res) => {
  const z = await zoneByCode(req.params.code); if (!z) return res.sendStatus(404);
  res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(await poster.qrPng(network.refLink(z)));
});
// From EDeal: a new zone admin agreed there, so open the same zone here
app.post('/internal/zone', async (req, res) => {
  if (!network.peerAuth(req)) return res.sendStatus(401);
  const b = req.body || {};
  const t = await network.talukByName(b.district, b.taluk, b.supervisor);
  const z = await network.createZone({ name: b.name, admin_phone: cfg.norm(b.admin_phone), lat: +b.lat, lng: +b.lng, taluk_id: t ? t.id : null });
  if (b.payee) await db.q(`insert into payees(phone,name,upi,pan) values($1,$2,$3,$4) on conflict(phone) do update set name=$2, upi=$3, pan=$4, updated_at=now()`, [z.admin_phone, b.payee.name, b.payee.upi, b.payee.pan]);
  if (!b.quiet) await bot.newAreaAdminWelcome(z);
  res.json({ ok: true, id: z.id, ref_code: z.ref_code });
});

async function start() {
  await db.init();
  setInterval(() => billingJob().catch((e) => console.error('billing job', e)), 30 * 60e3);
  setTimeout(() => billingJob().catch((e) => console.error('billing job', e)), 60e3);
  waDiagnose().then((d) => console.log('WA check:', JSON.stringify(d))).catch((e) => console.error('WA check failed', e.message));
  return app.listen(cfg.PORT, () => console.log(`${cfg.BRAND} listening on ${cfg.PORT} · admins ${cfg.ADMINS.join(',')}`));
}
if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start, billingJob };
