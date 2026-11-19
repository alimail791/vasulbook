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
app.use(async (_req, _res, next) => { try { await bot.ensureCats(); } catch (e) { console.error('cats', e.message); } next(); });

const page = (title, body, extraCss = '') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="/edeal-icon.png"><meta property="og:image" content="/edeal-whatsapp-dp.png">
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:20px;line-height:1.6;color:#14231a}h1{font-size:24px}h2{font-size:18px;margin-top:24px}
.btn{display:inline-block;background:#00a884;color:#fff;text-decoration:none;padding:12px 20px;border-radius:24px;font-weight:600}.muted{color:#5b6b60;font-size:14px}
table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #e5ece7;text-align:left}${extraCss}</style></head><body>${body}</body></html>`;

// ---------- public landing page (categories come live from the admin's list)
const HELP_PHONE = (process.env.HELP_PHONE || '9443424064').replace(/\D/g, '');
app.get('/', async (_req, res) => {
  const P = await db.plans();
  const botNo = (process.env.BOT_PHONE || '').replace(/\D/g, ''), wa = botNo.length === 10 ? '91' + botNo : botNo;
  const waL = (t) => (wa ? `https://wa.me/${wa}?text=${encodeURIComponent(t)}` : '/offers');
  const cats = await db.all(`select c.*, (select count(*)::int from ads a where a.status='live' and (a.valid_until is null or a.valid_until > now()) and ((c.kind='property' and a.type='property' and a.sub=c.name) or (c.kind<>'property' and a.type='deal' and a.cat=c.name))) live
    from categories c where c.active order by sort, id`);
  const st = await db.one(`select (select count(*)::int from ads where status='live' and (valid_until is null or valid_until > now())) ads,
    (select count(*)::int from ads where status='live' and type='event' and (valid_until is null or valid_until > now())) events,
    (select count(*)::int from advertisers where active) advs, (select count(*)::int from localities where active) areas`);
  const areas = await db.all('select name from localities where active order by name');
  const tile = (href, emoji, name, live) => `<a class="tile" href="${href}"><span class="em">${esc(emoji || '🏷')}</span><span class="nm">${esc(name)}</span>${live ? `<span class="lv">${live} live</span>` : ''}</a>`;
  const grp = (k) => cats.filter((c) => (c.kind || 'shop') === k);
  const group = (title, sub, href, tiles) => tiles ? `<div class="grp"><div class="gh"><h3>${title}</h3><a href="${href}">See all ›</a></div><p class="gs">${sub}</p><div class="tiles">${tiles}</div></div>` : '';
  const shopTiles = grp('shop').map((c) => tile('/offers?f=' + encodeURIComponent('cat:' + c.name), c.emoji, c.name, c.live)).join('') + tile('/offers?f=events', '🎉', 'Events', st.events);
  const eduTiles = grp('edu').map((c) => tile('/offers?f=' + encodeURIComponent('cat:' + c.name), c.emoji, c.name, c.live)).join('');
  const propTiles = grp('property').map((c) => tile('/offers?f=' + encodeURIComponent('sub:' + c.name), c.emoji, c.name, c.live)).join('');
  // Small numbers look empty, so ad and business counts show only once they are worth showing
  const stats = [[st.ads >= 25 ? st.ads : 0, 'live ads'], [cats.length + 1, 'categories'], [st.areas, st.areas === 1 ? 'area' : 'areas'], [st.advs >= 15 ? st.advs : 0, 'local businesses']].filter(([n]) => n > 0);
  const ben = [['📲', 'Real customer leads', "Coupon, enquiry, demo and visit requests come to your WhatsApp with the customer's name and number."],
    ['🚫', 'No pamphlets, no printing', 'No notices to print or hand out. Your ad goes straight to phones nearby, and you can change it anytime.'],
    ['📍', 'Seen within 2–5 km', 'Shown to people near you on WhatsApp and on this website.'],
    ['☀️', 'Daily 9 AM message', 'Your offer goes out in the morning offers message people nearby get.'],
    ['🎟', 'Coupons bring footfall', 'Customers show the coupon code at your shop. You redeem it on WhatsApp.'],
    ['📊', 'Live reports', 'See views, leads and coupons used for every ad.'],
    ['🔗', 'Your own ad page', 'A link to share on your WhatsApp status and groups.'],
    ['🗣', 'Tamil, English, Hindi', 'Post in 1 minute, all on WhatsApp. No app, no login.']];
  const css = `body{max-width:none;padding:0;margin:0;background:#fff7ed;color:#1c1917;font-family:Poppins,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.w{max-width:1040px;margin:0 auto;padding:0 18px}.ta{font-family:"Noto Sans Tamil",Poppins,sans-serif}
.hero{background:#c2410c;color:#fff;padding:26px 0 34px}.hero .w{display:grid;grid-template-columns:auto 1fr;gap:26px;align-items:center}
.hero img{width:190px;height:auto;border-radius:20px;display:block}.hero h1{font-size:38px;line-height:1.12;margin:0 0 10px;font-weight:800}.hero h1 span{color:#facc15}
.hero p{font-size:17px;margin:0 0 6px;color:#ffedd5}.hero .ta{font-size:16px;font-weight:600;color:#ffedd5;margin-bottom:16px}
.cta{display:flex;flex-wrap:wrap;gap:10px}.b{display:inline-flex;align-items:center;gap:8px;text-decoration:none;font-weight:700;font-size:16px;padding:13px 20px;border-radius:28px}
.b.y{background:#facc15;color:#431407}.b.wh{background:#25d366;color:#fff}.b.o{background:#fff;color:#9a3412}.b.ol{border:2px solid #fff;color:#fff}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.stats div{background:rgba(255,255,255,.14);border-radius:14px;padding:8px 14px;font-size:14px}.stats b{font-size:20px;display:block;line-height:1.1}
section{padding:30px 0 6px}h2{font-size:26px;margin:0 0 4px;font-weight:800}.sub{color:#57534e;margin:0 0 16px}
.grp{background:#fff;border-radius:18px;padding:16px;margin-bottom:14px;box-shadow:0 0 0 1.5px #fed7aa}.gh{display:flex;align-items:center;justify-content:space-between}.gh h3{margin:0;font-size:19px}.gh a{color:#c2410c;font-weight:700;text-decoration:none;font-size:14px}
.gs{margin:2px 0 12px;color:#57534e;font-size:14px}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.tile{display:flex;flex-direction:column;gap:2px;text-decoration:none;color:#1c1917;background:#fff7ed;border:1.5px solid #fed7aa;border-radius:14px;padding:12px;min-height:44px}.tile:hover{border-color:#c2410c}
.tile .em{font-size:26px}.tile .nm{font-weight:700;font-size:15px;line-height:1.25}.tile .lv{font-size:12px;font-weight:700;color:#15803d}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.step{background:#fff;border-radius:16px;padding:16px;box-shadow:0 0 0 1.5px #fed7aa}.step b{display:inline-flex;width:34px;height:34px;border-radius:50%;background:#c2410c;color:#fff;align-items:center;justify-content:center;margin-bottom:8px}
.biz{background:#431407;color:#fff;margin-top:26px;padding:34px 0}.biz h2{color:#fff}.biz .sub{color:#fed7aa}.ben{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}
.ben div{background:rgba(255,255,255,.08);border-radius:16px;padding:14px}.ben .e{font-size:26px}.ben b{display:block;margin:4px 0 2px}.ben p{margin:0;font-size:14px;color:#fed7aa;line-height:1.5}
.ben div.hl{background:#facc15;color:#431407}.ben div.hl p{color:#713f12}.free{display:inline-block;background:#facc15;color:#431407;font-weight:800;border-radius:10px;padding:2px 10px}
.help{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:16px;font-size:15px}.help a{color:#facc15;font-weight:700}
.areas{font-size:14px;color:#57534e}footer{padding:22px 0 30px;font-size:14px;color:#57534e}footer a{color:#9a3412}
@media(max-width:720px){.hero .w{grid-template-columns:1fr;text-align:left}.hero img{width:130px}.hero h1{font-size:30px}.steps{grid-template-columns:1fr}.ben{grid-template-columns:1fr 1fr}.tiles{grid-template-columns:repeat(2,1fr)}}`;
  res.send(page(`${cfg.BRAND} – Offers, classes & homes near you on WhatsApp`, `<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;800&family=Noto+Sans+Tamil:wght@600&display=swap" rel="stylesheet">
<div class="hero"><div class="w"><img src="/edeal-logo.png" alt="${esc(cfg.BRAND)} – Local offers on WhatsApp">
<div><h1>Offers, classes &amp; homes <span>near you</span> – on WhatsApp</h1>
<p>Today's sales, discounts, tuition &amp; schools, events, and houses, flats, plots &amp; PG within 2–5 km. No app, no login.</p>
<div class="ta">உங்கள் அருகிலுள்ள ஆஃபர்கள், வகுப்புகள், வீடுகள் – WhatsApp-இல்</div>
<div class="cta"><a class="b y" href="/offers">🔥 See offers near you</a><a class="b wh" href="${waL('Hi')}">💬 Say Hi on WhatsApp</a><a class="b ol" href="#business">🏪 Advertise free</a></div>
${stats.length ? `<div class="stats">${stats.map(([n, l]) => `<div><b>${n}</b>${l}</div>`).join('')}</div>` : ''}</div></div></div>

<section><div class="w"><h2>Browse by category</h2><p class="sub">Tap a category to see what's on near you.</p>
${group('🛍 Shops &amp; services', 'Sales, discounts and coupons from shops near you.', '/offers?f=offers', shopTiles)}
${group('🎓 Education', 'Tuition, coaching and schools – book a free demo.', '/offers?f=edu', eduTiles)}
${group('🏠 Property', 'Houses, flats, plots, shops and PG – rent or buy, contact owners directly.', '/offers?f=property', propTiles)}
${areas.length ? `<p class="areas">📍 Now in: ${areas.map((a) => esc(a.name)).join(', ')}</p>` : ''}</div></section>

<section><div class="w"><h2>How it works</h2><p class="sub">For everyone nearby – free.</p><div class="steps">
<div class="step"><b>1</b><div><strong>Say Hi</strong> on WhatsApp and share your location.</div></div>
<div class="step"><b>2</b><div><strong>See offers</strong>, classes and homes within 2–5 km.</div></div>
<div class="step"><b>3</b><div><strong>Get a coupon</strong>, book a demo or contact the owner in one tap.</div></div></div></div></section>

<div class="biz" id="business"><div class="w"><h2>Own a shop, teach, or have property?</h2>
<p class="sub">Shops, restaurants, salons, tutors, coaching centres, schools, owners and brokers: reach every customer within 5 km. <span class="free">Start FREE – ${P.trial.days}-day trial</span></p>
<div class="ben">${ben.map(([e, t, d], i) => `<div${i < 2 ? ' class="hl"' : ''}><span class="e">${e}</span><b>${t}</b><p>${d}</p></div>`).join('')}</div>
<div class="cta"><a class="b y" href="${waL('business')}">🏪 Post your ad free on WhatsApp</a><a class="b o" href="${waL('business')}">🏠 List your property</a></div>
<div class="help">📞 Help &amp; enquiries: <a href="tel:+91${HELP_PHONE}">${HELP_PHONE.replace(/(\d{5})(\d{5})/, '$1 $2')}</a> · <a href="https://wa.me/91${HELP_PHONE}">WhatsApp us</a></div></div></div>

<footer><div class="w">${esc(cfg.BRAND)} · Local offers on WhatsApp · <a href="/offers">All offers</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/delete-data">Delete your data</a> · info@vasulbook.com</div></footer>`, css));
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
  res.send(page(`Pay ₹${p.amount} – ${cfg.BRAND}`, `<div style="text-align:center"><img src="/edeal-logo.png" style="height:110px;border-radius:14px" alt=""><h1>Pay ₹${p.amount}</h1>
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
// Flood guard: if one number sends more than 20 messages in 3 minutes (e.g. another bot),
// stop replying to it for 30 minutes.
const hits = new Map(), muted = new Map();
function flooding(phone) {
  const now = Date.now();
  if ((muted.get(phone) || 0) > now) return true;
  const arr = (hits.get(phone) || []).filter((t) => now - t < 3 * 60e3); arr.push(now); hits.set(phone, arr);
  if (arr.length > 20) { muted.set(phone, now + 30 * 60e3); console.warn('flood guard: muted', phone); return true; }
  if (hits.size > 5000) hits.clear();
  return false;
}
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
      if (cfg.IGNORE_PHONES.includes(m.from)) { seen.add(m.id); continue; }
      if (flooding(m.from)) { seen.add(m.id); continue; }
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

// ---------- public offer pages
app.use('/', require('./web'));

// ---------- web admin panel
app.use('/panel', require('./panel'));

// Zone admin posters and QR codes (public: they only carry the referral link)
const network = require('./network'); const poster = require('./poster');
wa.setTemplateHook(() => network.countMsg('template'));
const zoneByCode = (c) => db.one('select * from localities where upper(ref_code)=$1', [String(c || '').toUpperCase()]);
app.get('/poster/:code.pdf', async (req, res) => {
  const z = await zoneByCode(req.params.code); if (!z) return res.sendStatus(404);
  const p = z.admin_phone ? await db.one('select name from payees where phone=$1', [z.admin_phone]) : null;
  res.type('application/pdf').set('Content-Disposition', `inline; filename="${cfg.BRAND}-poster-${z.ref_code}.pdf"`).send(await poster.pdf(z, 'edeal', p && p.name));
});
app.get('/qr/:code.png', async (req, res) => {
  const z = await zoneByCode(req.params.code); if (!z) return res.sendStatus(404);
  res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(await poster.qrPng(network.refLink(z, 'business')));
});
// Shop sticker poster for advertisers (live categories and prices)
const sticker = require('./sticker');
const sendSticker = async (req, res, code) => res.type('application/pdf').set('Content-Disposition', `inline; filename="${cfg.BRAND}-sticker${code ? '-' + code : ''}.pdf"`)
  .send(await sticker.pdf({ size: req.query.size === 'A4' ? 'A4' : 'A5', code }));
app.get('/sticker.pdf', (req, res) => sendSticker(req, res, null));
app.get('/sticker/:code.pdf', async (req, res) => { const z = await zoneByCode(req.params.code); if (!z) return res.sendStatus(404); sendSticker(req, res, z.ref_code); });

// From EMart: a new zone admin agreed there, so open the same locality here
app.post('/internal/zone', express.json(), async (req, res) => {
  if (!network.peerAuth(req)) return res.sendStatus(401);
  const b = req.body || {};
  const t = await network.talukByName(b.district, b.taluk, b.supervisor);
  const z = await network.createZone({ name: b.name, admin_phone: cfg.norm(b.admin_phone), lat: +b.lat, lng: +b.lng, taluk_id: t ? t.id : null });
  if (b.payee) await db.q(`insert into payees(phone,name,upi,pan) values($1,$2,$3,$4) on conflict(phone) do update set name=$2, upi=$3, pan=$4, updated_at=now()`, [z.admin_phone, b.payee.name, b.payee.upi, b.payee.pan]);
  if (!b.quiet) await bot.welcomeAreaAdmin(z);
  res.json({ ok: true, id: z.id, ref_code: z.ref_code });
});
// From EMart: a shop paid its setup fee, so it gets EDeal Premium free for 30 days (once per number)
app.post('/internal/bundle', express.json(), async (req, res) => {
  if (!network.peerAuth(req)) return res.sendStatus(401);
  const b = req.body || {}, phone = cfg.norm(b.phone), days = Math.min(60, Number(b.days) || 30);
  if (!phone || !(await db.one(`insert into kv(key,value) values($1,'1') on conflict do nothing returning key`, ['bundle:' + phone]))) return res.json({ ok: false, reason: 'already given' });
  let loc = b.admin_phone ? (await db.localities.byAdmin(cfg.norm(b.admin_phone)))[0] : null;
  if (!loc && b.lat != null) { let bd = Infinity; for (const l of await db.localities.active()) if (l.lat != null) { const d = bot.km({ lat: +b.lat, lng: +b.lng }, l); if (d < bd) { bd = d; loc = l; } } }
  let adv = await db.advertisers.byPhone(phone);
  if (!adv) adv = await db.one(`insert into advertisers(phone,name,cat,lat,lng,locality_id) values($1,$2,'Grocery',$3,$4,$5) returning *`, [phone, String(b.name || 'Shop').slice(0, 80), b.lat ?? null, b.lng ?? null, loc ? loc.id : null]);
  const base = adv.plan_until && new Date(adv.plan_until) > new Date() ? new Date(adv.plan_until) : new Date();
  adv = await db.advertisers.set(adv.id, { plan: 'premium', plan_until: new Date(base.getTime() + days * 864e5), active: true });
  await bot.notify(phone, `🎁 *${cfg.BRAND} Premium is free for ${days} days* — a gift with your EMart shop.\n\nPost your offers and people within 5 km see them every day.`, [['➕ Post an offer', 'post:deal'], ['🏪 Business menu', 'menu']]);
  await network.log(null, 'bundle', `${adv.name} +${phone} premium ${days} days`);
  res.json({ ok: true, adv_id: adv.id });
});
app.get('/admin', (_req, res) => res.redirect('/panel'));

// ---------- WhatsApp setup check: token, webhook subscription, templates, business profile
async function waDiagnose() {
  if (!cfg.WA_TOKEN) return { error: 'WA_TOKEN not set' };
  const out = {};
  const g = (p, method = 'GET', body) => wa.graph(p, { method, ...(body ? { body: JSON.stringify(body) } : {}) }).catch((e) => ({ error: e.message }));
  if (!cfg.WA_PHONE_ID) out.phone = 'WA_PHONE_NUMBER_ID not set – bot runs in dry-run until EDeal has its own number';
  else out.phone = await g(`${cfg.WA_PHONE_ID}?fields=display_phone_number,verified_name,code_verification_status,quality_rating,status`);
  if (process.env.WA_PIN && out.phone && out.phone.status && out.phone.status !== 'CONNECTED') out.register = await g(`${cfg.WA_PHONE_ID}/register`, 'POST', { messaging_product: 'whatsapp', pin: process.env.WA_PIN });
  // Point just this phone number's webhook at this server (Meta "webhook override")
  if (process.env.WA_WEBHOOK_OVERRIDE === '1' && cfg.PUBLIC_URL && cfg.WA_PHONE_ID) {
    out.webhook_override = await g(cfg.WA_PHONE_ID, 'POST', { webhook_configuration: { override_callback_uri: `${cfg.PUBLIC_URL}/webhook`, verify_token: cfg.WA_VERIFY } });
  }
  const w = process.env.WA_WABA_ID;
  if (w) {
    out.subscribe = await g(`${w}/subscribed_apps`, 'POST');
    // Each template exists in English, Tamil and Hindi (same name, one per language)
    const ensure = async (name, category, texts, example) => {
      const found = await g(`${w}/message_templates?name=${name}&fields=name,status,category,language&limit=50`);
      const have = new Set(((found && found.data) || []).filter((t) => t.name === name).map((t) => t.language));
      const ex = ((found && found.data) || []).find((t) => t.name === name);
      if (ex && ex.category) category = ex.category; // new languages must match the existing template's category
      const res = {};
      for (const [lang, text] of Object.entries(texts)) {
        const code = lang === 'en' ? cfg.WA_TEMPLATE_LANG : lang;
        res[code] = have.has(code) ? 'exists' : await g(`${w}/message_templates`, 'POST', { name, language: code, category, components: [{ type: 'BODY', text, example: { body_text: [[example]] } }] });
      }
      return res;
    };
    if (cfg.WA_TEMPLATE) out.template = await ensure(cfg.WA_TEMPLATE, 'UTILITY', {
      en: `${cfg.BRAND} update: {{1}}\n\nReply here to see your menu.`,
      ta: `${cfg.BRAND} அறிவிப்பு: {{1}}\n\nஉங்கள் மெனுவைப் பார்க்க இங்கே பதில் அனுப்பவும்.`,
      hi: `${cfg.BRAND} अपडेट: {{1}}\n\nअपना मेनू देखने के लिए यहाँ जवाब दें।`,
    }, 'Your ad “Weekend sale” is now live for people within 2 km.');
    if (cfg.WA_DIGEST_TEMPLATE) out.digest_template = await ensure(cfg.WA_DIGEST_TEMPLATE, 'MARKETING', {
      en: `☀️ Good morning! Top offers near you today: {{1}}\n\nReply HI to see all offers. Reply STOP to stop these messages.`,
      ta: `☀️ காலை வணக்கம்! இன்று உங்கள் அருகில் சிறந்த சலுகைகள்: {{1}}\n\nஅனைத்தையும் பார்க்க HI அனுப்பவும். நிறுத்த STOP அனுப்பவும்.`,
      hi: `☀️ सुप्रभात! आज आपके पास के बेहतरीन ऑफ़र: {{1}}\n\nसभी ऑफ़र देखने के लिए HI भेजें। बंद करने के लिए STOP भेजें।`,
    }, '1. Weekend grocery sale – Flat 20% off on oils (Fresh Mart, 600 m) | 2. Lunch combo – Meals at ₹99 (Annapoorna, 1.2 km)');
  }
  if (process.env.WA_SET_PROFILE !== '0' && cfg.WA_PHONE_ID) {
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
  db.all('select name from categories where active order by sort, name').then((cs) => console.log(`categories (${cs.length}): ${cs.map((c) => c.name).join(' | ')}`)).catch(() => {});
  await db.init();
  waDiagnose().then((d) => console.log('WA check:', JSON.stringify(d))).catch((e) => console.error('WA check failed', e.message));
  jobs.start();
  return app.listen(cfg.PORT, () => console.log(`${cfg.BRAND} listening on ${cfg.PORT} · admins ${cfg.ADMINS.join(',')}`));
}
if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
module.exports = { app, start };
