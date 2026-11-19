// Conversation logic for EDeal: Customer, Advertiser (business) and Admin
// (main admin + area admins). Mirrors the approved prototype.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const wa = require('./wa');
const pay = require('./pay');
const i18n = require('./strings');
const network = require('./network');

// ---- language of each person (cached; stored on the customers row)
const langCache = new Map();
async function langOf(phone) {
  if (langCache.has(phone)) return langCache.get(phone);
  const r = await db.one('select lang from customers where phone=$1', [phone]).catch(() => null);
  const l = (r && r.lang) || 'en'; langCache.set(phone, l); return l;
}
async function setLang(phone, l) { await db.q('update customers set lang=$2 where phone=$1', [phone, l]); langCache.set(phone, l); }
wa.setLangResolver(langOf);

const rs = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const MENU_WORDS = ['hi', 'hello', 'hey', 'hii', 'hai', 'menu', 'start', '0', 'vanakkam', 'namaste'];
// Categories are managed by the admin (WhatsApp or web panel) and loaded from the database.
// These arrays are filled in place by loadCats(), so every module always sees the current list.
const CATS = ['Grocery', 'Food', 'Fashion', 'Electronics', 'Salon & Spa', 'Kids', 'Tuition', 'Coaching', 'Schools'];
const EDU = ['Tuition', 'Coaching', 'Schools'];
const EMO = { Grocery: '🛒', Food: '🍛', Fashion: '👗', Electronics: '📱', 'Salon & Spa': '💇', Kids: '🧸', Tuition: '📖', Coaching: '🎯', Schools: '🏫', Events: '🎉', Property: '🏠' };
let catsLoaded = false;
async function loadCats() {
  const rows = await db.all('select * from categories order by sort, id');
  CATS.length = 0; EDU.length = 0; PROPS.length = 0;
  for (const o of [SUBS, SUBEMO, RENT, PSAMPLE]) for (const k of Object.keys(o)) delete o[k];
  for (const r of rows) {
    const kind = r.kind || (r.edu ? 'edu' : 'shop');
    if (kind === 'property') {
      SUBS[r.name] = `${r.emoji || '🏠'} ${r.name}`; SUBEMO[r.name] = r.emoji || '🏠'; RENT[r.name] = !!r.rent; PSAMPLE[r.name] = r.sample || '';
      if (r.active) PROPS.push(r.name);
      continue;
    }
    EMO[r.name] = r.emoji || '🏷';
    if (r.active) { CATS.push(r.name); if (kind === 'edu') EDU.push(r.name); }
  }
  catsLoaded = true;
}
const ensureCats = () => (catsLoaded ? null : loadCats());
// Property types (admin-managed, group "property"): name -> label / emoji / rent? / example title
const SUBS = { 'Houses for rent': '🔑 Houses for rent', 'Flats for sale': '🏢 Flats for sale', 'Houses for sale': '🏡 Houses for sale' };
const SUBEMO = { 'Houses for rent': '🔑', 'Flats for sale': '🏢', 'Houses for sale': '🏡' };
const PROPS = ['Houses for rent', 'Flats for sale', 'Houses for sale']; // shown (active) property types, in order
const RENT = { 'Houses for rent': true };
const PSAMPLE = {};
const SAMPLE = {
  Tuition: ['Maths & Science tuition, Class 6–10', 'First month 50% off + free demo class'],
  Coaching: ['NEET / JEE weekend batch', '₹2,000 off for early joiners'],
  Schools: ['Admissions open 2027–28', 'No admission fee for first 50 seats'],
  Food: ['Weekend sweets sale', 'Flat 25% off on all sweets'],
  _: ['Weekend sale', 'Flat 25% off on all items'],
};
const PER_PAGE = 5;

/* ------------------------------------------------------------------ helpers */
const km = (a, b) => {
  const R = 6371, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const fmtKm = (d) => (d < 1 ? `${Math.max(50, Math.round(d * 1000 / 50) * 50)} m` : `${d.toFixed(1)} km`);
const istDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const endOfTodayIST = () => { const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); return new Date(s + 'T23:59:00+05:30'); };
const addDays = (n) => new Date(Date.now() + n * 864e5);
const emojiOf = (a) => (a.type === 'property' ? SUBEMO[a.sub] || '🏠' : a.type === 'event' ? '🎉' : EMO[a.cat] || '🏷');
const imgOf = (a) => (a.media_id && cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/m/${a.media_id}.jpg` : null);
const planActive = (adv) => !!(adv && adv.plan && adv.plan_until && new Date(adv.plan_until) > new Date());

function cardText(a, dist) {
  const L = [`${emojiOf(a)} *${a.title}*`];
  if (a.type === 'property') L.push(`💰 *${a.offer}*`, SUBS[a.sub] || '', a.details || '');
  else L.push(`🏷 *${a.offer}*`);
  L.push(`${a.type === 'property' ? '👤' : EDU.includes(a.cat) ? '🎓' : '🏪'} ${a.shop}${dist != null ? ' · 📍 ' + fmtKm(dist) : ''}`);
  if (a.valid_until && a.type !== 'property') L.push(`⏳ Valid till ${istDate(a.valid_until)}`);
  if (a.featured) L.push('⭐ Featured');
  return L.filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ outbound */
const PER = 8;
async function sendPage(to, text, btns, p) {
  const slice = btns.slice(p * PER, p * PER + PER);
  if (p > 0) slice.push(['◀ Previous', 'pg:' + (p - 1)]);
  if ((p + 1) * PER < btns.length) slice.push(['More options ▶', 'pg:' + (p + 1)]);
  return wa.send(to, p === 0 ? text : `More options (page ${p + 1}) 👇`, slice);
}
async function out(to, text, btns = [], image = null) {
  if (btns.length > 10) {
    await db.q(`insert into menus(phone,text,items) values($1,$2,$3) on conflict(phone) do update set text=$2, items=$3`, [to, text, JSON.stringify(btns)]);
    return sendPage(to, text, btns, 0);
  }
  return wa.send(to, text, btns, image);
}
// Message to someone other than the sender (may be outside the 24h window).
async function notify(to, text, btns = [], image = null) {
  try { await out(to, text, btns, image); return true; }
  catch (e) {
    console.error('notify failed', to, e.code, e.message);
    try { await wa.sendTemplate(to, text); return true; } catch (e2) { console.error('template failed', to, e2.message); return false; }
  }
}
const notifyAdmins = (text, btns, image) => Promise.all(cfg.ADMINS.map((a) => notify(a, text, btns, image)));
// Who approves ads for a locality: its area admin, otherwise the main admins
async function approvers(localityId) {
  const l = localityId ? await db.localities.get(localityId) : null;
  return l && l.admin_phone && l.active ? [l.admin_phone] : cfg.ADMINS;
}
async function nearestLocality(lat, lng) {
  const ls = await db.localities.active();
  let best = null, bd = Infinity;
  for (const l of ls) if (l.lat != null) { const d = km({ lat, lng }, l); if (d < bd) { bd = d; best = l; } }
  return best;
}

/* ------------------------------------------------------------- ads & search */
async function nearby(cust, f = {}) {
  const me = { lat: cust.lat, lng: cust.lng }, R = Number(cust.radius_km) || 2;
  const list = [];
  for (const a of await db.ads.live()) {
    const d = km(me, a);
    if (d > R || d > Number(a.radius_km)) continue;
    if (f.type && a.type !== f.type) continue;
    if (f.cat && a.cat !== f.cat) continue;
    if (f.sub && a.sub !== f.sub) continue;
    if (f.notEdu && EDU.includes(a.cat)) continue;
    if (f.q) { const t = `${a.title} ${a.offer} ${a.shop} ${a.cat} ${a.sub || ''} ${a.details || ''}`.toLowerCase(); if (!f.q.split(/\s+/).every((w) => t.includes(w))) continue; }
    list.push({ ...a, dist: d });
  }
  return list.sort((x, y) => (y.featured - x.featured) || x.dist - y.dist);
}
function adButtons(a) {
  if (a.type === 'property') return [['📞 Contact owner', 'enq:' + a.id], ['📅 Book a visit', 'visit:' + a.id], ['📍 Location', 'dir:' + a.id]];
  if (a.type === 'event') return [["🙋 I'm interested", 'int:' + a.id], ['📍 Directions', 'dir:' + a.id]];
  if (EDU.includes(a.cat)) return [['🎟 Get offer code', 'cp:' + a.id], [a.cat === 'Schools' ? '📝 Enquire now' : '📅 Book free demo', 'demo:' + a.id], ['📍 Directions', 'dir:' + a.id]];
  return [['🎟 Get coupon', 'cp:' + a.id], ['📍 Directions', 'dir:' + a.id], ['📞 Call shop', 'call:' + a.id]];
}
async function showList(c, list, title, page = 0) {
  c.sess.data.list = { ids: list.map((a) => a.id), title, page };
  if (!list.length) return c.reply(`Nothing here within ${c.cust.radius_km} km right now. Try a bigger distance or another section.`, [['📏 Change distance', 'radius'], ['🏠 Menu', 'menu']]);
  const slice = list.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  if (page === 0) await c.say(`${title} – *${list.length}* within ${c.cust.radius_km} km`);
  for (const a of slice) {
    await db.q('update ads set views=views+1 where id=$1', [a.id]);
    await c.reply(cardText(a, a.dist), adButtons(a), imgOf(a));
  }
  const more = (page + 1) * PER_PAGE < list.length;
  const web = await webLink(c.from);
  return c.reply((more ? `Showing ${page * PER_PAGE + 1}–${page * PER_PAGE + slice.length} of ${list.length}` : 'That’s all for now 👆') + (web ? `\n🌐 All on one page: ${web}` : ''), more ? [['More ▶', 'more'], ['🏠 Menu', 'menu']] : [['🗂 Categories', 'cats'], ['🏠 Menu', 'menu']]);
}
async function moreList(c) {
  const L = c.sess.data.list; if (!L) return custMenu(c);
  const all = (await nearby(c.cust)).filter((a) => L.ids.includes(a.id)).sort((x, y) => L.ids.indexOf(x.id) - L.ids.indexOf(y.id));
  return showList(c, all, L.title, L.page + 1);
}

/* ================================================================ CUSTOMER */
// Personal website link: opens the offers page near this customer's saved location
async function webLink(phone, filter) {
  if (!cfg.PUBLIC_URL) return '';
  let row = await db.one('select web_token from customers where phone=$1', [phone]);
  let t = row && row.web_token;
  if (!t) { t = crypto.randomBytes(6).toString('base64url'); await db.q('update customers set web_token=$2 where phone=$1', [phone, t]); }
  return `${cfg.PUBLIC_URL}/u/${t}${filter ? '?f=' + encodeURIComponent(filter) : ''}`;
}
const WEB_ACTION = { offer: 'cp', coupon: 'cp', enquiry: 'enq', contact: 'enq', visit: 'visit', interested: 'int', demo: 'demo', admission: 'demo' };
// First thing a new person sees: see offers, advertise, or look at ads on the website
async function startMenu(c, forBiz) {
  const site = cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/offers` : '';
  const head = forBiz ? `👋 *Welcome to ${cfg.BRAND}!*\nShops, tutors, schools and property owners advertise here to reach people within *2–5 km*.` : `👋 *Welcome to ${cfg.BRAND}!*\nSales, discounts, offers, events, tuition & schools, and homes for rent or sale within *2–5 km* of you.`;
  return c.reply(`${head}${site ? `\n\n🌐 See all ads on the website:\n${site}` : ''}\n\nWhat would you like to do?`,
    forBiz ? [['🏪 Advertise with us', 'biz'], ['🔥 See offers near me', 'gonear'], ['🌐 See ads on website', 'web']] : [['🔥 See offers near me', 'gonear'], ['🏪 Advertise with us', 'biz'], ['🌐 See ads on website', 'web']]);
}
async function custWelcome(c) {
  if (!c.sess.data.started) return startMenu(c);
  return askStart(c);
}
async function askStart(c) {
  c.sess.data.started = true;
  await wa.askLocation(c.from, `👋 *Welcome to ${cfg.BRAND}!*\nSales, discounts, offers, events, tuition & schools, and homes for rent or sale within *2–5 km* of you – fresh every day.\n\nTap *Send location* below to begin 👇`);
  const ls = (await db.localities.active()).filter((l) => l.lat != null);
  const b = ls.slice(0, 8).map((l) => ['📍 ' + l.name, 'carea:' + l.id]);
  b.push(['🏪 Advertise with us', 'biz']);
  return c.reply(ls.length ? 'Or pick your area:' : 'Own a shop, school or property to advertise?', b);
}
async function custMenu(c) {
  c.sess.state = null;
  const cust = c.cust;
  if (cust.lat == null) return custWelcome(c);
  const all = await nearby(cust);
  const n = (f) => all.filter(f).length;
  const area = cust.locality_id ? (await db.localities.get(cust.locality_id) || {}).name : null;
  const web = await webLink(c.from);
  return c.reply(`*${cfg.BRAND}* · 📍 ${area || 'your location'} · ${cust.radius_km} km\n🔥 ${n((a) => a.type === 'deal' && !EDU.includes(a.cat))} offers · 🎓 ${n((a) => EDU.includes(a.cat))} education · 🎉 ${n((a) => a.type === 'event')} events · 🏠 ${n((a) => a.type === 'property')} homes${web ? `\n\n🌐 See all with photos on the web:\n${web}` : ''}\n\n_Tip: type what you need, e.g. "tuition" or "2 bhk rent"._`, [
    ["🔥 Today's offers", 'offers'], ['🗂 Categories', 'cats'], ['🎓 Tuition, coaching & schools', 'edu'], ['🎉 Local events', 'events'], ['🏠 Rent & property', 'props'],
    ['🎟 My coupons', 'mine'], [cust.subscribed ? '🔕 Stop daily offers' : '🔔 Daily 9 AM offers', 'alerts'], ['⚙️ Settings', 'settings'], ['🏪 Advertise with us', 'biz']]);
}
async function getCoupon(adId, phone) {
  const ex = await db.one('select * from coupons where ad_id=$1 and phone=$2', [adId, phone]);
  if (ex) return { code: ex.code, isNew: false };
  for (let i = 0; i < 20; i++) {
    const code = 'ED' + crypto.randomInt(1000, 100000);
    try { await db.q('insert into coupons(code,ad_id,phone) values($1,$2,$3)', [code, adId, phone]); await db.q('update ads set leads=leads+1 where id=$1', [adId]); return { code, isNew: true }; }
    catch (_) { /* duplicate, retry */ }
  }
  throw new Error('coupon');
}
async function addLead(a, c, kind, note) {
  await db.q('insert into leads(ad_id,phone,kind,note) values($1,$2,$3,$4)', [a.id, c.from, kind, note || null]);
  await db.q('update ads set leads=leads+1 where id=$1', [a.id]);
  const who = `${c.name || 'Customer'} · +${c.from}`;
  const label = { enquiry: '📞 New enquiry', demo: a.cat === 'Schools' ? '📝 New admission enquiry' : '📅 New demo class request', visit: '📅 Site visit request', interest: '🙋 New interested person' }[kind];
  await notify(a.adv_phone, `${label} for “${a.title}”${note ? `\nWhen: *${note}*` : ''}\n👤 ${who}\nCall or WhatsApp them now.`, [['📊 My ads & leads', 'myads']]);
}

async function customer(c, v, btn) {
  const S = c.sess, low = v.trim().toLowerCase();
  let m;
  if (MENU_WORDS.includes(low)) return custMenu(c);
  if (low === 'stop' || low === 'unsubscribe') { await db.customers.set(c.from, { subscribed: false }); return c.reply('🔕 Daily offers stopped. Say *hi* anytime to see offers near you.'); }
  if (low === 'start alerts' || low === 'subscribe') v = 'alerts';
  if ((m = v.match(/^loc:(-?[\d.]+),(-?[\d.]+)/))) {
    const lat = +m[1], lng = +m[2], L = await nearestLocality(lat, lng);
    c.cust = await db.customers.set(c.from, { lat, lng, locality_id: L ? L.id : null });
    return c.reply(`✅ Location saved${L ? ` (near *${L.name}*)` : ''}.\nHow far should I look?`, [['2 km', 'rad:2'], ['3 km', 'rad:3'], ['5 km', 'rad:5']]);
  }
  if ((m = v.match(/^carea:(\d+)$/))) {
    const L = await db.localities.get(+m[1]); if (!L || L.lat == null) return custWelcome(c);
    c.cust = await db.customers.set(c.from, { lat: L.lat, lng: L.lng, locality_id: L.id });
    return c.reply(`✅ Area set: *${L.name}*. How far should I look?`, [['2 km', 'rad:2'], ['3 km', 'rad:3'], ['5 km', 'rad:5']]);
  }
  if ((m = v.trim().match(/^(offer|coupon|enquiry|contact|visit|interested|demo|admission)\s*#\s*(\d+)/i))) { v = `${WEB_ACTION[m[1].toLowerCase()]}:${m[2]}`; btn = true; }
  const isAdAction = /^(cp|dir|call|demo|enq|int|visit):\d+$/.test(v) || /^vt:/.test(v);
  if (v === 'gonear') return askStart(c);
  if (v === 'web') {
    const link = c.cust.lat != null ? await webLink(c.from) : `${cfg.PUBLIC_URL}/offers`;
    return c.reply(`🌐 *See ads on the website*\nOffers, classes, events and homes with photos. Tap to open:\n${link}`, [['🔥 See offers near me', c.cust.lat != null ? 'menu' : 'gonear'], ['🏪 Advertise with us', 'biz']]);
  }
  if (c.cust.lat == null && !['biz'].includes(v) && !isAdAction) return custWelcome(c);
  if ((m = v.match(/^rad:(\d)$/))) { c.cust = await db.customers.set(c.from, { radius_km: Math.min(cfg.MAX_RADIUS_KM, +m[1]) }); return custMenu(c); }
  if (v === 'settings') return c.reply(`⚙️ *Settings*\nDistance: ${c.cust.radius_km} km · Language: ${i18n.LANGS[await langOf(c.from)]}`, [['📏 Change distance', 'radius'], ['📍 Change location', 'setloc'], ['🌐 Language', 'lang']]);
  if (v === 'radius') return c.reply('How far should I look?', [['2 km', 'rad:2'], ['3 km', 'rad:3'], ['5 km', 'rad:5']]);
  if (v === 'setloc') return wa.askLocation(c.from, 'Tap *Send location* to update where you are 👇');
  if (v === 'more') return moreList(c);
  if (v === 'offers') return showList(c, await nearby(c.cust, { type: 'deal', notEdu: true }), "🔥 Today's offers");
  if (v === 'events') return showList(c, await nearby(c.cust, { type: 'event' }), '🎉 Local events');
  if (v === 'cats') {
    const all = await nearby(c.cust, { type: 'deal' });
    return c.reply('Pick a category', CATS.map((k) => [`${EMO[k]} ${k} (${all.filter((a) => a.cat === k).length})`, 'cat:' + k]).concat([['🏠 Menu', 'menu']]));
  }
  if (v === 'edu') {
    const all = await nearby(c.cust, { type: 'deal' });
    return c.reply('🎓 *Education near you*', EDU.map((k) => [`${EMO[k]} ${k} (${all.filter((a) => a.cat === k).length})`, 'cat:' + k]));
  }
  if ((m = v.match(/^cat:(.+)$/)) && CATS.includes(m[1])) return showList(c, await nearby(c.cust, { type: 'deal', cat: m[1] }), `${EMO[m[1]]} ${m[1]}`);
  if (v === 'props') {
    const all = await nearby(c.cust, { type: 'property' });
    const web = await webLink(c.from, 'property');
    const cnt = (k) => all.filter((a) => a.sub === k).length;
    const rows = [...PROPS].sort((x, y) => (cnt(y) > 0) - (cnt(x) > 0)).map((k) => [`${SUBS[k]} (${cnt(k)})`, 'psub:' + k]);
    return c.reply(`🏠 *Rent & property* within ${c.cust.radius_km} km – ${all.length} listing${all.length === 1 ? '' : 's'}${web ? `\n🌐 With photos: ${web}` : ''}\n\n_Or type what you need, e.g. "2 bhk rent", "plot", "PG"._`, [[`🏠 All properties (${all.length})`, 'pall']].concat(rows));
  }
  if (v === 'pall') return showList(c, await nearby(c.cust, { type: 'property' }), '🏠 All properties');
  if ((m = v.match(/^psub:(.+)$/)) && SUBS[m[1]]) return showList(c, await nearby(c.cust, { type: 'property', sub: m[1] }), SUBS[m[1]]);
  if (v === 'mine') {
    const rows = await db.all(`select c.*, a.title, a.offer, v.name shop from coupons c join ads a on a.id=c.ad_id join advertisers v on v.id=a.adv_id where c.phone=$1 order by c.created_at desc limit 10`, [c.from]);
    if (!rows.length) return c.reply('No coupons yet. Open an offer and tap *Get coupon*.', [["🔥 Today's offers", 'offers'], ['🏠 Menu', 'menu']]);
    return c.reply('🎟 *My coupons*\n\n' + rows.map((r) => `*${r.code}* – ${r.shop}\n${r.offer} · ${r.redeemed_at ? '✅ Used' : '🟢 Active'}`).join('\n\n'), [['🏠 Menu', 'menu']]);
  }
  if (v === 'alerts') {
    if (c.cust.subscribed) { await db.customers.set(c.from, { subscribed: false }); return c.reply('🔕 Daily offers stopped. Say *hi* anytime.', [['🏠 Menu', 'menu']]); }
    await db.customers.set(c.from, { subscribed: true });
    return c.reply(`🔔 Done! Every morning at *${cfg.DIGEST_HOUR} AM* you'll get the best offers within ${c.cust.radius_km} km.\nReply *STOP* anytime to stop.`, [["🔥 Today's offers", 'offers'], ['🏠 Menu', 'menu']]);
  }
  // actions on an ad
  if ((m = v.match(/^(cp|dir|call|demo|enq|int|visit):(\d+)$/))) {
    const a = await db.ads.get(+m[2]);
    if (!a || a.status !== 'live') return c.reply('Sorry, this offer has ended.', [['🏠 Menu', 'menu']]);
    const d = c.cust.lat != null ? km(c.cust, a) : null;
    if (m[1] === 'cp' || m[1] === 'int') {
      const { code } = await getCoupon(a.id, c.from);
      if (m[1] === 'int') { await addLead(a, c, 'interest'); return c.reply(`🙌 You're on the list for *${a.title}*!\nYour pass: *${code}*\nShow it at the venue. We've shared your number with ${a.shop}.`, [['🎉 More events', 'events'], ['🏠 Menu', 'menu']]); }
      return c.reply(`🎟 *Your code: ${code}*\n\nShow this at *${a.shop}* to get:\n*${a.offer}*${a.valid_until ? `\n⏳ Valid till ${istDate(a.valid_until)}` : ''}`, [['📍 Directions', 'dir:' + a.id], ["🔥 More offers", 'offers'], ['🏠 Menu', 'menu']]);
    }
    if (m[1] === 'dir') {
      await wa.sendLocation(c.from, a.lat, a.lng, a.shop, a.address || '');
      return c.reply(`📍 *${a.shop}*${d != null ? ` is ${fmtKm(d)} away (~${Math.max(3, Math.round(d * 4))} min by bike)` : ''}. Tap the pin above for directions.`, [['🏠 Menu', 'menu']]);
    }
    if (m[1] === 'call') return c.reply(`📞 *${a.shop}*: +${a.adv_phone}`, [['🏠 Menu', 'menu']]);
    if (m[1] === 'demo') { await addLead(a, c, 'demo'); return c.reply(`✅ Request sent to *${a.shop}*. We've shared your number, and they'll call you to fix a ${a.cat === 'Schools' ? 'campus visit' : 'demo class'}.`, [['🎓 More education', 'edu'], ['🏠 Menu', 'menu']]); }
    if (m[1] === 'enq') { await addLead(a, c, 'enquiry'); return c.reply(`📞 *${a.shop}*: +${a.adv_phone}\nWe've also sent them your enquiry, so expect a call.`, [['📅 Book a visit', 'visit:' + a.id], ['🏠 Rent & property', 'props']]); }
    if (m[1] === 'visit') return c.reply('When would you like to visit?', [['Today evening', `vt:${a.id}:te`], ['Tomorrow morning', `vt:${a.id}:tm`], ['This Sunday', `vt:${a.id}:su`]]);
  }
  if ((m = v.match(/^vt:(\d+):(te|tm|su)$/))) {
    const a = await db.ads.get(+m[1]); if (!a) return custMenu(c);
    const when = { te: 'today evening', tm: 'tomorrow morning', su: 'this Sunday' }[m[2]];
    await addLead(a, c, 'visit', when);
    return c.reply(`📅 Visit request sent for *${when}*. ${a.shop} will contact you to confirm.`, [['🏠 Rent & property', 'props'], ['🏠 Menu', 'menu']]);
  }
  // free-text search
  if (!btn && low.length >= 3) {
    const words = low.replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
    const list = await nearby(c.cust, { q: words });
    if (list.length) return showList(c, list, `🔎 Results for “${v.trim().slice(0, 30)}”`);
    return c.reply(`No ads match “${v.trim().slice(0, 30)}” within ${c.cust.radius_km} km. Try the menu 👇`, [['🗂 Categories', 'cats'], ['📏 Change distance', 'radius'], ['🏠 Menu', 'menu']]);
  }
  return custMenu(c);
}

/* ============================================================== ADVERTISER */
async function planMenu(c, intro) {
  const P = await db.plans(), adv = c.adv;
  const lines = [intro || '💳 *EDeal plans*'];
  if (!adv || !adv.trial_used) lines.push(`🎁 *Free trial* – 1 ad for ${P.trial.days} days, 2 km (no payment)`);
  lines.push(`⚡ *1 Day – ${rs(P.day.price)}*: 1 ad for a day, 2 km`, `📅 *7 Days – ${rs(P.week.price)}*: 1 ad for a week, 2 km`,
    `⭐ *Monthly – ${rs(P.month.price)}*: unlimited ads & events, 2 km`, `👑 *Premium – ${rs(P.premium.price)}/month*: unlimited ads, *5 km*, ⭐ on top + in the 9 AM message`);
  const b = [];
  if (!adv || !adv.trial_used) b.push([`🎁 ${P.trial.days}-day free trial`, 'plan:trial']);
  b.push([`⚡ 1 Day – ${rs(P.day.price)}`, 'plan:day'], [`📅 7 Days – ${rs(P.week.price)}`, 'plan:week'], [`⭐ Monthly – ${rs(P.month.price)}`, 'plan:month'], [`👑 Premium – ${rs(P.premium.price)}`, 'plan:premium']);
  if (adv) b.push(['🏪 Business menu', 'menu']);
  return c.reply(lines.join('\n'), b);
}
async function advMenu(c) {
  c.sess.state = null; c.sess.data.d = null;
  const a = c.adv, P = await db.plans(), L = a.locality_id ? await db.localities.get(a.locality_id) : null;
  const plan = planActive(a) ? `${P[a.plan].name} · valid till ${istDate(a.plan_until)}` : '⚠️ No active plan';
  const post = a.cat === 'Property' ? [['🏠 Post a property', 'post:property'], ['➕ Post an offer', 'post:deal'], ['🎉 Post an event', 'post:event']] : [['➕ Post an offer', 'post:deal'], ['🎉 Post an event', 'post:event'], ['🏠 Post a property', 'post:property']];
  return c.reply(`🏪 *${a.name}*${L ? ' · 📍 ' + L.name : ''}\n🏷 ${a.cat === 'Property' ? 'Property owner / broker' : a.cat}\nPlan: ${plan}`, post.concat([['📊 My ads & leads', 'myads'], ['✅ Redeem a coupon', 'redeem'], ['💳 Plans & renew', 'plans'], [`🏷 Category: ${a.cat}`, 'acat'], ['📍 Update location', 'aloc'], ['🌐 Language', 'lang'], ['🛍 Browse offers', '#customer']]));
}
async function activatePlan(adv, planKey, payment) {
  const P = await db.plans(), p = P[planKey];
  const base = adv.plan === planKey && planActive(adv) ? new Date(adv.plan_until) : new Date();
  const until = new Date(base.getTime() + p.days * 864e5);
  const patch = { plan: planKey, plan_until: until, active: true };
  if (planKey === 'trial') patch.trial_used = true;
  adv = await db.advertisers.set(adv.id, patch);
  if (payment) {
    const locId = payment.locality_id || adv.locality_id || null;
    payment = await db.one(`update payments set status='paid', paid_at=coalesce(paid_at,now()), locality_id=$2 where id=$1 returning *`, [payment.id, locId]);
    // Commission on money received: locality admin 40%, taluk supervisor 10% (see network.js)
    const earned = await network.record({ paymentId: payment.id, source: 'plan', areaId: locId, amount: Number(payment.amount), paidAt: payment.paid_at });
    for (const e of earned) await notify(e.phone, `💰 You earned *${rs(e.amount)}* (${e.pct}%) — ${adv.name} paid ${rs(payment.amount)} for ${p.name}.\nIt's added to your next payout.`, [['💰 My earnings', 'aearn']]);
    await notify(adv.phone, `✅ Payment of ${rs(payment.amount)} received. *${p.name}* plan is active till *${istDate(until)}*.`, [['➕ Post an ad', adv.cat === 'Property' ? 'post:property' : 'post:deal'], ['🏪 Business menu', 'menu']]);
    const L = adv.locality_id ? await db.localities.get(adv.locality_id) : null;
    const msg = `💰 ${rs(payment.amount)} received from *${adv.name}* (${p.name})${L ? ' · ' + L.name : ''}.`;
    await notifyAdmins(msg);
    if (L && L.admin_phone && !cfg.ADMINS.includes(L.admin_phone)) await notify(L.admin_phone, msg);
  }
  return adv;
}
// The question for the field the advertiser is typing right now (asked again when they tap an old button or reply "ok")
function fieldPrompt(c) {
  const S = c.sess, d = S.data.d || {}, cat = d.cat || (c.adv && c.adv.cat);
  if (S.state === 'd_title') {
    if (d.type === 'property') return `✍️ Short title – size, type, landmark\n_e.g. "${PSAMPLE[d.sub] || '2 BHK near bus stand'}"_`;
    if (d.type === 'event') return '✍️ Event name? (e.g. "Free health camp")';
    return `✍️ Headline – what are you offering?\n_e.g. "${(SAMPLE[cat] || SAMPLE._)[0]}"_`;
  }
  if (S.state === 'd_offer') {
    if (d.type === 'property') return RENT[d.sub] ? '💰 Monthly rent? (e.g. "₹10,000/month")' : '💰 Asking price? (e.g. "₹55 lakh, negotiable")';
    if (d.type === 'event') return '📝 Event details – day, time, entry? (e.g. "Saturday 6–8 pm · free entry")';
    return `🏷 The offer – discount, price or freebie?\n_e.g. "${(SAMPLE[cat] || SAMPLE._)[1]}"_`;
  }
  if (S.state === 'd_details') return '📝 Details – size, floor, furnishing, parking, advance…';
  return '';
}
const NOT_ANSWER = /^(ok+|okay|k|kk|yes|yeah|no|hi|hello|hmm+|thanks?|thank you|done|sari|sure|fine|👍|🙏|\.+)$/i;
async function postLimit(adv) {
  const P = await db.plans();
  if (!planActive(adv)) return 'noplan';
  if (!P[adv.plan].oneAd) return null;
  const n = (await db.one(`select count(*)::int c from ads where adv_id=$1 and status in ('pending','live','paused') and created_at >= $2`, [adv.id, new Date(new Date(adv.plan_until).getTime() - P[adv.plan].days * 864e5)])).c;
  return n >= 1 ? 'limit' : null;
}
async function submitAd(c) {
  const d = c.sess.data.d, a = c.adv, P = await db.plans(), p = P[a.plan];
  const cat = d.type === 'event' ? 'Events' : d.type === 'property' ? 'Property' : d.cat || (CATS.includes(a.cat) ? a.cat : 'Grocery');
  const ad = await db.one(`insert into ads(adv_id,type,cat,sub,title,offer,details,media_id,valid_until,radius_km,featured,plan) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [a.id, d.type, cat, d.sub || null, d.title, d.offer, d.details || null, d.media || null, new Date(d.valid), d.radius || p.km, !!p.featured, a.plan]);
  c.sess.data.d = null; c.sess.state = null;
  const full = await db.ads.get(ad.id), L = a.locality_id ? await db.localities.get(a.locality_id) : null;
  for (const to of await approvers(a.locality_id)) {
    await notify(to, `🆕 *Ad waiting for approval*${L ? ' · ' + L.name : ''}\n\n${cardText(full)}\n\n📱 +${a.phone} · ${P[a.plan].name}`, [['✅ Approve', 'ap:' + ad.id], ['❌ Reject', 'rj:' + ad.id]], imgOf(full));
  }
  return c.reply(`📨 Submitted! ${L ? `The ${L.name} admin` : 'The admin'} reviews ads, usually within an hour. I'll message you as soon as it's live.`, [['🏪 Business menu', 'menu']]);
}
async function previewAd(c) {
  const d = c.sess.data.d, a = c.adv, P = await db.plans();
  const cat = d.type === 'event' ? 'Events' : d.type === 'property' ? 'Property' : d.cat || (CATS.includes(a.cat) ? a.cat : 'Grocery');
  const fake = { type: d.type, cat, sub: d.sub, title: d.title, offer: d.offer, details: d.details, shop: a.name, valid_until: d.valid, featured: !!P[a.plan].featured, media_id: d.media };
  c.sess.state = 'd_confirm';
  const b = [['🚀 Submit', 'dsubmit']];
  if (d.type === 'deal') b.push([`🏷 Change category (${cat})`, 'dcat']);
  b.push(['✏️ Start over', 'post:' + d.type], ['🏪 Business menu', 'menu']);
  return c.reply(`*Preview – how customers will see it:*\n\n${cardText(fake)}\n🏷 ${d.type === 'deal' ? cat : d.type === 'event' ? 'Event' : 'Property'} · 📏 within ${d.radius} km`, b, imgOf(fake));
}
async function askValidity(c) {
  const a = c.adv, P = await db.plans(), p = P[a.plan], left = (new Date(a.plan_until) - Date.now()) / 864e5;
  const opts = [['Today only', 'dval:0']];
  for (const n of [3, 7, 15, 30]) if (n <= p.days && n <= Math.ceil(left)) opts.push([`${n} days`, 'dval:' + n]);
  if (opts.length === 1) { c.sess.data.d.valid = endOfTodayIST().toISOString(); return askReach(c); }
  c.sess.state = 'd_valid';
  return c.reply('⏳ How long should it run?', opts.slice(0, 3).concat(opts.length > 3 ? [opts[opts.length - 1]] : []).slice(0, 4));
}
async function askReach(c) {
  const a = c.adv, P = await db.plans(), p = P[a.plan];
  if (p.km > 2) { c.sess.state = 'd_reach'; return c.reply('👑 Show it to people within…', [['2 km', 'drad:2'], ['3 km', 'drad:3'], ['5 km', 'drad:5']]); }
  c.sess.data.d.radius = 2;
  await c.say(`📏 Your ${p.name} plan shows ads within *2 km*. Premium reaches 5 km and puts you on top.`);
  return previewAd(c);
}

// Category for one offer: any category, the business's own one listed first
function askAdCat(c, text) {
  const own = CATS.includes(c.adv.cat) ? c.adv.cat : null, cur = c.sess.data.d.cat || own;
  const order = own ? [own, ...CATS.filter((k) => k !== own)] : CATS;
  c.sess.state = 'd_cat';
  return c.reply(`🏷 ${text}\nYou can post in any category.`, order.map((k) => [`${EMO[k]} ${k}${k === cur ? ' ✓' : ''}`, 'dcat:' + k]));
}
async function advertiser(c, v, btn) {
  const S = c.sess, low = v.trim().toLowerCase();
  let m;
  // ---- registration (before an advertiser record exists)
  if (!c.adv) {
    if (v === 'biz' || MENU_WORDS.includes(low) || !S.state) {
      S.state = 'r_name'; S.data.reg = {};
      return c.reply(`🏪 *${cfg.BRAND} for Business*\nShow your sales, offers, classes, admissions, events or property to people within *2–5 km* – on WhatsApp, every day.\nStart with a *15-day free trial*.\n\nWhat is your shop / business name?`, [['❌ Cancel', '#customer']]);
    }
    if (S.state === 'r_name' && !btn) {
      S.data.reg = { name: v.trim().slice(0, 60) }; S.state = 'r_cat';
      return c.reply(`*${S.data.reg.name}* – what do you want to advertise?`, [['🛍 Shop / service', 'rkind:shop'], ['🎓 Tuition / school', 'rkind:edu'], ['🏠 Property', 'rcat:Property']]);
    }
    if ((m = v.match(/^rkind:(shop|edu)$/)) && S.state === 'r_cat') {
      const list = m[1] === 'edu' ? EDU : CATS.filter((k) => !EDU.includes(k));
      return c.reply(m[1] === 'edu' ? '🎓 Which one fits you best?' : '🛍 Pick your category (you can post offers in any category later):', list.map((k) => [`${EMO[k]} ${k}`, 'rcat:' + k]).concat([['⬅ Back', 'rback']]));
    }
    if (v === 'rback' && S.state === 'r_cat') return c.reply(`*${S.data.reg.name}* – what do you want to advertise?`, [['🛍 Shop / service', 'rkind:shop'], ['🎓 Tuition / school', 'rkind:edu'], ['🏠 Property', 'rcat:Property']]);
    if ((m = v.match(/^rcat:(.+)$/)) && S.state === 'r_cat' && (CATS.includes(m[1]) || m[1] === 'Property')) {
      S.data.reg.cat = m[1]; S.state = 'r_loc';
      return wa.askLocation(c.from, m[1] === 'Property' ? `📍 Share the location of the property (or your office) so nearby people find it.\nTap *Send location* – you can send your current location or move the pin.` : `📍 Now share the location of *${S.data.reg.name}* so nearby customers find you.\nTap *Send location* – you can send your current location or move the pin.`);
    }
    if ((m = v.match(/^loc:(-?[\d.]+),(-?[\d.]+)\|?(.*)$/)) && S.state === 'r_loc') {
      // An advertiser who came through a zone admin's referral link belongs to that admin's locality
      const lat = +m[1], lng = +m[2], L = (await network.referralArea(c.from)) || (await nearestLocality(lat, lng));
      c.adv = await db.one('insert into advertisers(phone,name,cat,lat,lng,address,locality_id) values($1,$2,$3,$4,$5,$6,$7) on conflict(phone) do update set name=$2 returning *',
        [c.from, S.data.reg.name, S.data.reg.cat, lat, lng, (m[3] || '').slice(0, 200) || null, L ? L.id : null]);
      S.state = null; S.data.reg = null; S.data.as = 'business';
      const msg = `🏪 New advertiser: *${c.adv.name}* (${c.adv.cat}) · +${c.from}${L ? ' · ' + L.name : ' · no locality nearby'}`;
      await notifyAdmins(msg);
      if (L && L.admin_phone && !cfg.ADMINS.includes(L.admin_phone)) await notify(L.admin_phone, msg);
      return planMenu(c, `✅ *${c.adv.name}* registered${L ? ` in *${L.name}*` : ''}.\n\nPick a plan to start:`);
    }
    if (S.state === 'r_loc') return wa.askLocation(c.from, 'Please tap *Send location* to share your shop location 👇');
    if (S.state === 'r_cat') return c.reply('Please tap one of the options above 👆');
    S.state = null; return advertiser(c, 'biz', true);
  }

  const a = c.adv;
  if (MENU_WORDS.includes(low) || v === 'biz') return advMenu(c);
  if (v === 'plans') return planMenu(c);
  if ((m = v.match(/^plan:(trial|day|week|month|premium)$/))) {
    const P = await db.plans(), p = P[m[1]];
    if (m[1] === 'trial') {
      if (a.trial_used) return planMenu(c, 'You have already used your free trial. Pick a plan:');
      c.adv = await activatePlan(a, 'trial');
      await c.say(`🎁 Free trial started! Post *1 ad* free till *${istDate(c.adv.plan_until)}*.\nI'll remind you 2 days before it ends so you can continue from ${rs(P.day.price)}.`);
      return advMenu(c);
    }
    const pm = await pay.create(a, p);
    const b = pay.upiEnabled() ? [["✅ I've paid (UPI)", 'paid:' + pm.id], ['🏪 Business menu', 'menu']] : [['🏪 Business menu', 'menu']];
    return c.reply(`💳 *${p.name} plan*\n${pay.text(pm)}`, b);
  }
  if ((m = v.match(/^paid:(\d+)$/))) {
    const pm = await db.one('select * from payments where id=$1 and adv_id=$2', [+m[1], a.id]);
    if (!pm || pm.status === 'paid') return advMenu(c);
    S.state = 'p_utr'; S.data.pid = pm.id;
    return c.reply(`Send the *UPI reference number* (12 digits, shown in your UPI app after paying ${rs(pm.amount)}), or send a *screenshot* of the payment.`, [['❌ Cancel', 'menu']]);
  }
  if (S.state === 'p_utr' && (!btn || v.startsWith('img:'))) {
    const pm = await db.one('select * from payments where id=$1', [S.data.pid]); S.state = null;
    if (!pm) return advMenu(c);
    const isImg = v.startsWith('img:'), media = isImg ? await saveMedia(v.slice(4)) : null;
    await db.q(`update payments set status='claimed', method='upi', utr=$2 where id=$1`, [pm.id, isImg ? 'screenshot' : v.trim().slice(0, 40)]);
    const P = await db.plans();
    const msg = `💳 *Payment to confirm* – ${rs(pm.amount)} (${P[pm.plan].name})\nFrom: *${a.name}* · +${a.phone}\nRef: ${pay.ref(pm)} · UPI ref: ${isImg ? 'screenshot below' : v.trim()}\n\nCheck your UPI app, then confirm:`;
    const img = media && cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/m/${media}.jpg` : null;
    for (const to of cfg.ADMINS) await notify(to, msg, [[`✅ Confirm ${rs(pm.amount)}`, 'pc:' + pm.id], ['❌ Not received', 'pr:' + pm.id]], img);
    return c.reply('🙏 Thanks! The admin will confirm your payment shortly and your plan will start right away.', [['🏪 Business menu', 'menu']]);
  }
  // ---- change business category
  if (v === 'acat') {
    return c.reply(`🏷 Your category now: *${a.cat === 'Property' ? 'Property owner / broker' : a.cat}*\nPick a new one:`, CATS.map((k) => [`${EMO[k]} ${k}${k === a.cat ? ' ✓' : ''}`, 'acat:' + k]).concat([[`🏠 Property owner / broker${a.cat === 'Property' ? ' ✓' : ''}`, 'acat:Property']]));
  }
  if ((m = v.match(/^acat:(.+)$/)) && (CATS.includes(m[1]) || m[1] === 'Property')) {
    const old = a.cat, nw = m[1];
    if (old === nw) return advMenu(c);
    c.adv = await db.advertisers.set(a.id, { cat: nw });
    const n = nw === 'Property' ? 0 : (await db.one(`select count(*)::int n from ads where adv_id=$1 and type='deal' and status in ('live','pending','paused') and cat=$2`, [a.id, old])).n;
    if (n) { S.data.oldcat = old; return c.reply(`✅ Category changed to *${nw}*.\nYou have ${n} running offer${n > 1 ? 's' : ''} under ${old}. Move ${n > 1 ? 'them' : 'it'} to ${nw} too?`, [['✅ Yes, move them', 'acatmv'], ['No, keep as is', 'menu']]); }
    await c.say(`✅ Category changed to *${nw === 'Property' ? 'Property owner / broker' : nw}*.${nw === 'Property' ? '\nYou can now post houses for rent and flats / houses for sale.' : ''}`);
    return advMenu(c);
  }
  if (v === 'acatmv' && S.data.oldcat) {
    const r2 = await db.q(`update ads set cat=$3 where adv_id=$1 and type='deal' and status in ('live','pending','paused') and cat=$2`, [a.id, S.data.oldcat, a.cat]);
    S.data.oldcat = null; await c.say(`✅ ${r2.rowCount} offer${r2.rowCount === 1 ? '' : 's'} moved to *${a.cat}*.`); return advMenu(c);
  }
  // ---- choose a different category for just this ad (from the preview)
  if (v === 'dcat' && S.data.d && S.data.d.type === 'deal') return askAdCat(c, 'Category for this ad (your business category stays the same):');
  if ((m = v.match(/^dcat:(.+)$/)) && S.data.d && S.data.d.type === 'deal' && CATS.includes(m[1])) {
    const d = S.data.d; d.cat = m[1];
    if (d.valid) return previewAd(c);
    S.state = 'd_title';
    return c.reply(`${EMO[d.cat]} *${d.cat}* offer.\n✍️ Headline – what are you offering?\n_e.g. "${(SAMPLE[d.cat] || SAMPLE._)[0]}"_`);
  }
  if (S.state === 'd_cat' && !btn) return c.reply('Please pick a category from the list 👆');
  if (v === 'aloc') { S.state = 'a_loc'; return wa.askLocation(c.from, 'Tap *Send location* to update your shop location 👇'); }
  if ((m = v.match(/^loc:(-?[\d.]+),(-?[\d.]+)\|?(.*)$/)) && S.state === 'a_loc') {
    const L = (await network.referralArea(c.from)) || (await nearestLocality(+m[1], +m[2]));
    c.adv = await db.advertisers.set(a.id, { lat: +m[1], lng: +m[2], address: (m[3] || '').slice(0, 200) || a.address, locality_id: L ? L.id : a.locality_id });
    S.state = null; await c.say('✅ Location updated.'); return advMenu(c);
  }
  // ---- post an ad
  if ((m = v.match(/^post:(deal|event|property)$/))) {
    const lim = await postLimit(a);
    if (lim === 'noplan') return planMenu(c, '⚠️ You need an active plan to post. Pick one:');
    if (lim === 'limit') { const P = await db.plans(); return c.reply(`Your *${P[a.plan].name}* plan covers 1 ad. Upgrade to post more:`, [[`⭐ Monthly – ${rs(P.month.price)}`, 'plan:month'], [`👑 Premium – ${rs(P.premium.price)}`, 'plan:premium'], ['🏪 Business menu', 'menu']]); }
    S.data.d = { type: m[1] };
    if (m[1] === 'property') { S.state = 'd_sub'; return c.reply('🏠 What are you listing?', PROPS.map((k) => [SUBS[k], 'dsub:' + k])); }
    if (m[1] === 'deal') return askAdCat(c, 'Which category is this offer for?');
    S.state = 'd_title';
    return c.reply('✍️ Event name? (e.g. "Free health camp")');
  }
  if ((m = v.match(/^dsub:(.+)$/)) && S.data.d && PROPS.includes(m[1])) {
    S.data.d.sub = m[1]; S.state = 'd_title';
    return c.reply(`${SUBS[m[1]]}\n✍️ Short title – size, type, landmark\n_e.g. "${PSAMPLE[m[1]] || '2 BHK near bus stand'}"_`);
  }
  if (['d_title', 'd_offer', 'd_details'].includes(S.state) && !btn && S.data.d && (NOT_ANSWER.test(v.trim()) || v.trim().length < 3)) {
    return c.reply(`🙂 I need the actual text for your ad here.\n\n${fieldPrompt(c)}`, [['❌ Cancel', 'menu']]);
  }
  if (S.state === 'd_title' && !btn && S.data.d) {
    const d = S.data.d; d.title = v.trim().slice(0, 80); S.state = 'd_offer';
    if (d.type === 'property') return c.reply(RENT[d.sub] ? '💰 Monthly rent? (e.g. "₹10,000/month")' : '💰 Asking price? (e.g. "₹55 lakh, negotiable")');
    if (d.type === 'event') return c.reply('📝 Event details – day, time, entry? (e.g. "Saturday 6–8 pm · free entry")');
    return c.reply(`🏷 The offer – discount, price or freebie?\n_e.g. "${(SAMPLE[d.cat || a.cat] || SAMPLE._)[1]}"_`);
  }
  if (S.state === 'd_offer' && !btn && S.data.d) {
    const d = S.data.d; d.offer = v.trim().slice(0, 120);
    if (d.type === 'property') { S.state = 'd_details'; return c.reply('📝 Details – size, floor, furnishing, parking, advance…'); }
    S.state = 'd_photo'; return c.reply('📷 Send a *photo or poster* of the offer now, or tap Skip.', [['Skip photo', 'dskip']]);
  }
  if (S.state === 'd_details' && !btn && S.data.d) { S.data.d.details = v.trim().slice(0, 300); S.state = 'd_photo'; return c.reply('📷 Send *photos* of the property (one is enough), or tap Skip.', [['Skip photo', 'dskip']]); }
  if (S.state === 'd_photo' && S.data.d && (v === 'dskip' || v.startsWith('img:'))) {
    if (v.startsWith('img:')) { const id = await saveMedia(v.slice(4)); if (id) S.data.d.media = id; }
    return askValidity(c);
  }
  if (S.state === 'd_photo' && !btn) return c.reply('Please send a photo, or tap Skip.', [['Skip photo', 'dskip']]);
  if ((m = v.match(/^dval:(\d+)$/)) && S.data.d) {
    const n = +m[1], cap = new Date(a.plan_until);
    let until = n === 0 ? endOfTodayIST() : addDays(n);
    if (until > cap) until = cap;
    S.data.d.valid = until.toISOString();
    return askReach(c);
  }
  if ((m = v.match(/^drad:(2|3|5)$/)) && S.data.d) { S.data.d.radius = +m[1]; return previewAd(c); }
  if (v === 'dsubmit' && S.data.d && S.data.d.valid) return submitAd(c);
  // ---- my ads
  if (v === 'myads') {
    const list = await db.ads.byAdv(a.id);
    if (!list.length) return c.reply("You haven't posted anything yet.", [['➕ Post an ad', a.cat === 'Property' ? 'post:property' : 'post:deal'], ['🏪 Business menu', 'menu']]);
    const st = { live: '🟢 Live', pending: '🕒 Pending', rejected: '❌ Rejected', paused: '⏸ Paused', expired: '⌛ Ended' };
    const top = list.slice(0, 8);
    return c.reply('📊 *Your ads*\n\n' + top.map((x) => `*${x.title}* · ${st[x.status] || x.status}\n👁 ${x.views} views · 🙋 ${x.leads} leads${x.type === 'deal' ? ` · ✅ ${x.redeemed} redeemed` : ''}${x.reject_reason ? `\nReason: ${x.reject_reason}` : ''}`).join('\n\n'),
      top.map((x) => [`${emojiOf(x)} ${x.title}`, 'ad:' + x.id]).concat([['🏪 Business menu', 'menu']]));
  }
  if ((m = v.match(/^(ad|adp|adr|add|adl):(\d+)$/))) {
    const x = await db.one('select * from ads where id=$1 and adv_id=$2', [+m[2], a.id]);
    if (!x) return advMenu(c);
    if (m[1] === 'adp' && x.status === 'live') { await db.ads.set(x.id, { status: 'paused' }); await c.say('⏸ Paused. Customers won’t see it until you resume.'); }
    if (m[1] === 'adr' && x.status === 'paused') { await db.ads.set(x.id, { status: 'live' }); await c.say('▶ Live again.'); }
    if (m[1] === 'add') { await db.ads.set(x.id, { status: 'expired' }); await c.say('🗑 Removed.'); return advMenu(c); }
    if (m[1] === 'adl') {
      const ls = await db.all('select * from leads where ad_id=$1 order by id desc limit 15', [x.id]);
      const cps = await db.all('select * from coupons where ad_id=$1 order by created_at desc limit 15', [x.id]);
      const L = ls.map((l) => `• +${l.phone} – ${l.kind}${l.note ? ' (' + l.note + ')' : ''}`).concat(cps.map((k) => `• +${k.phone} – code ${k.code}${k.redeemed_at ? ' ✅' : ''}`));
      return c.reply(`🙋 *Leads for “${x.title}”*\n\n${L.join('\n') || 'No leads yet.'}`, [['📊 My ads & leads', 'myads'], ['🏪 Business menu', 'menu']]);
    }
    const y = await db.one('select * from ads where id=$1', [x.id]);
    const b = [];
    if (y.status === 'live') b.push(['⏸ Pause', 'adp:' + y.id]);
    if (y.status === 'paused') b.push(['▶ Resume', 'adr:' + y.id]);
    b.push(['🙋 Leads', 'adl:' + y.id]);
    if (!['expired', 'rejected'].includes(y.status)) b.push(['🗑 Remove', 'add:' + y.id]);
    b.push(['📊 My ads & leads', 'myads']);
    return c.reply(`${emojiOf(y)} *${y.title}*\n${y.offer}\nStatus: ${y.status}\n👁 ${y.views} views · 🙋 ${y.leads} leads${y.valid_until ? `\n⏳ Till ${istDate(y.valid_until)}` : ''}`, b);
  }
  // ---- redeem coupon
  if (v === 'redeem') { S.state = 'redeem'; return c.reply('🔢 Type the customer’s code (e.g. ED12345)', [['🏪 Business menu', 'menu']]); }
  if ((S.state === 'redeem' && !btn) || (m = low.match(/^(?:redeem\s+)?(ed\d{4,6})$/))) {
    S.state = null;
    const code = (low.match(/ed\d{4,6}/) || [''])[0].toUpperCase();
    const k = code ? await db.one('select c.*, a.adv_id, a.offer, a.title from coupons c join ads a on a.id=c.ad_id where c.code=$1', [code]) : null;
    if (!k) return c.reply(`❌ *${code || v.trim()}* is not a valid ${cfg.BRAND} code.`, [['🔁 Try again', 'redeem'], ['🏪 Business menu', 'menu']]);
    if (k.adv_id !== a.id) return c.reply('⚠️ This code is for another business.', [['🏪 Business menu', 'menu']]);
    if (k.redeemed_at) return c.reply(`⚠️ ${code} was already used on ${istDate(k.redeemed_at)}.`, [['🏪 Business menu', 'menu']]);
    await db.q('update coupons set redeemed_at=now() where code=$1', [code]);
    await db.q('update ads set redeemed=redeemed+1 where id=$1', [k.ad_id]);
    await notify(k.phone, `✅ Code *${code}* used at *${a.name}*. Enjoy! 🙏`);
    return c.reply(`✅ *Valid!* Give the customer:\n*${k.offer}*`, [['✅ Redeem another', 'redeem'], ['🏪 Business menu', 'menu']]);
  }
  if (S.state === 'd_title' || S.state === 'd_offer' || S.state === 'd_details') return c.reply(`That button is from an earlier message. We're in the middle of a new ad – please *type* this:\n\n${fieldPrompt(c)}`, [['❌ Cancel', 'menu']]);
  return advMenu(c);
}

/* =================================================================== ADMIN */
async function scopeLocs(c) { return c.isMain ? db.localities.all() : c.myLocs; }
const adInScope = (c, adLoc) => c.isMain || c.locIds.includes(adLoc);
async function monthRevenue(locIds) {
  return db.all(`select locality_id, coalesce(sum(amount),0) s, count(*)::int n from payments where status='paid'
    and paid_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' ${locIds ? 'and locality_id = any($1)' : ''} group by locality_id`, locIds ? [locIds] : []);
}
async function adminMenu(c) {
  c.sess.state = null;
  const locs = await scopeLocs(c), ids = locs.map((l) => l.id);
  const pend = (await db.ads.pending()).filter((a) => adInScope(c, a.locality_id));
  const claims = c.isMain ? (await db.one(`select count(*)::int n from payments where status='claimed'`)).n : 0;
  const live = await db.all(`select v.locality_id, count(*)::int n from ads a join advertisers v on v.id=a.adv_id where a.status='live' group by v.locality_id`);
  const liveOf = (id) => (live.find((x) => x.locality_id === id) || { n: 0 }).n;
  const lines = locs.map((l) => `📍 ${l.name}${c.isMain ? ` (${l.admin_phone ? '+' + l.admin_phone : 'you'})` : ''} – ${liveOf(l.id)} live · ${pend.filter((a) => a.locality_id === l.id).length} pending`);
  if (c.isMain) { const noLoc = pend.filter((a) => !a.locality_id).length; if (noLoc) lines.push(`📍 No locality – ${noLoc} pending`); }
  const b = [[`🕒 Pending ads (${pend.length})`, 'apend']];
  if (c.isMain) b.push([`💳 Payments to confirm (${claims})`, 'apays'], ['📍 Localities & admins', 'alocs'], ['➕ Add locality', 'aadd'], ['🏷 Categories', 'acats']);
  b.push(['📈 Revenue this month', 'arev']);
  if (!c.isMain) b.push(['💰 My earnings', 'aearn']);
  if (c.isMain) b.push(['📢 Send daily offers now', 'adigest']);
  b.push(['🌐 Web admin panel', 'aweb'], ['🛍 Browse as customer', '#customer']);
  if (c.adv) b.push(['🏪 My business', '#business']);
  const sup = c.isMain ? [] : await network.supervisorOf(c.from);
  return c.reply(`${c.isMain ? '👑 *EDeal main admin*' : sup.length ? '👥 *EDeal supervisor*' : '🗺 *EDeal zone admin*'}\n${lines.join('\n') || 'No localities yet – add one.'}`, b);
}
async function welcomeAreaAdmin(l) {
  l = await network.ensureRef(l.id);
  await notify(l.admin_phone, `🗺 You are now the *zone admin* for *${l.name}* on ${cfg.BRAND}.\n\nYou approve ads from businesses in your zone, bring in new advertisers, and earn *${network.ADMIN_PCT}%* of every plan payment they make, paid out every month.\n\n🔗 Your referral link (put it on your posters):\n${network.refLink(l, 'business')}\nWeb panel: ${cfg.PUBLIC_URL || cfg.WEBSITE}/panel\n\nType *menu* to start.`, [['💰 My earnings', 'aearn'], ['Menu', 'menu']]);
}
// "My earnings" for zone admins and supervisors
async function earningsText(c) {
  const x = await network.summary(c.from), sup = await network.supervisorOf(c.from);
  const own = c.myLocs.filter((l) => l.admin_phone === c.from), links = [];
  for (let l of own) { l = await network.ensureRef(l.id); links.push(`📍 ${l.name}: ${network.refLink(l, 'business')}`); }
  let teamTxt = '';
  if (sup.length) {
    const t = await network.team(c.from);
    teamTxt = `\n\n👥 *Your team* (${sup.map((t2) => t2.name).join(', ')})\n` + (t.map((l) => `• ${l.name}: ${l.admin_phone ? '+' + l.admin_phone : 'no admin'} · ${rs(l.earned)}`).join('\n') || 'No localities yet.');
  }
  return `💰 *My earnings*\nThis month: *${rs(x.month)}*\nWaiting for payout: *${rs(x.due)}*\nPaid out so far: ${rs(x.paid)}\n\nYou earn ${own.length ? `${network.ADMIN_PCT}% as zone admin` : ''}${own.length && sup.length ? ' and ' : ''}${sup.length ? `${network.SUP_PCT}% as supervisor` : ''} on plan payments that have come in.${links.length ? `\n\n🔗 *Referral link*\n${links.join('\n')}` : ''}${teamTxt}`;
}
async function approveAd(id, byPhone) {
  const a = await db.ads.get(id);
  if (!a || a.status !== 'pending') return null;
  await db.ads.set(id, { status: 'live', approved_at: new Date() });
  await notify(a.adv_phone, `🎉 Your ad “*${a.title}*” is now *LIVE* for people within ${a.radius_km} km.${cfg.PUBLIC_URL ? `\n\n🔗 Share it on your WhatsApp status and groups to get more customers:\n${cfg.PUBLIC_URL}/ad/${a.id}` : ''}`, [['📊 My ads & leads', 'myads'], ['🏪 Business menu', 'menu']]);
  return a;
}
const REASONS = { unclear: 'Offer is not clear', cat: 'Wrong category', content: 'Content not allowed', photo: 'Photo problem', other: 'Please contact the admin' };
async function rejectAd(id, reason) {
  const a = await db.ads.get(id);
  if (!a || a.status !== 'pending') return null;
  await db.ads.set(id, { status: 'rejected', reject_reason: reason });
  await notify(a.adv_phone, `❌ Your ad “*${a.title}*” wasn't approved.\nReason: *${reason}*\nPlease edit and post again – your plan is still active.`, [['➕ Post again', 'post:' + a.type], ['🏪 Business menu', 'menu']]);
  return a;
}
// Refund: the payment is marked refunded and the commission on it is taken back
async function refundPayment(id) {
  const p = await db.one(`update payments set status='refunded' where id=$1 and status='paid' returning *`, [id]);
  if (!p) return null;
  await network.reverse(p.id, 'plan');
  return p;
}
async function confirmPayment(id) {
  const pm = await db.one('select * from payments where id=$1', [id]);
  if (!pm || pm.status === 'paid') return null;
  const adv = await db.advertisers.get(pm.adv_id);
  await activatePlan(adv, pm.plan, pm);
  return pm;
}

async function addCategory(c) {
  const nc = c.sess.data.nc; c.sess.state = null; c.sess.data.nc = null;
  const sort = ((await db.one('select max(sort) m from categories where kind=$1', [nc.kind])).m || (nc.kind === 'property' ? 190 : 0)) + 10;
  await db.q('insert into categories(name,emoji,edu,kind,rent,sort) values($1,$2,$3,$4,$5,$6)', [nc.name, nc.emoji, nc.kind === 'edu', nc.kind, !!nc.rent, sort]);
  await loadCats();
  const where = { shop: 'customers find it in 🗂 Categories and businesses can post offers in it', edu: 'it shows under 🎓 Tuition, coaching & schools', property: 'it shows under 🏠 Rent & property, and owners can list in it' }[nc.kind];
  return c.reply(`✅ *${nc.emoji} ${nc.name}* added – ${where}. It's on the website too.`, [['🏷 Categories', 'acats'], ['Menu', 'menu']]);
}
// Rename a category everywhere it is used (offers use ads.cat, property listings use ads.sub)
async function renameCategory(r, name) {
  await db.q('update categories set name=$2 where id=$1', [r.id, name]);
  if ((r.kind || 'shop') === 'property') await db.q(`update ads set sub=$2 where type='property' and sub=$1`, [r.name, name]);
  else { await db.q(`update ads set cat=$2 where cat=$1`, [r.name, name]); await db.q('update advertisers set cat=$2 where cat=$1', [r.name, name]); }
  await loadCats();
}
async function admin(c, v, btn) {
  const S = c.sess, low = v.trim().toLowerCase();
  let m;
  if (MENU_WORDS.includes(low)) return adminMenu(c);
  if (v === 'apend') {
    const pend = (await db.ads.pending()).filter((a) => adInScope(c, a.locality_id));
    if (!pend.length) return c.reply('Nothing pending 🎉', [['Menu', 'menu']]);
    for (const a of pend.slice(0, 8)) await c.reply(`${cardText(a)}\n\n📱 +${a.adv_phone}`, [['✅ Approve', 'ap:' + a.id], ['❌ Reject', 'rj:' + a.id]], imgOf(a));
    return pend.length > 8 ? c.say(`…and ${pend.length - 8} more. Approve these first, or use the web panel.`) : null;
  }
  if ((m = v.match(/^(ap|rj):(\d+)$/))) {
    const a = await db.ads.get(+m[2]);
    if (!a || !adInScope(c, a.locality_id)) return c.reply('Ad not found in your area.', [['Menu', 'menu']]);
    if (a.status !== 'pending') return c.reply(`Already handled (${a.status}).`, [['🕒 Pending ads', 'apend'], ['Menu', 'menu']]);
    if (m[1] === 'ap') { await approveAd(a.id, c.from); return c.reply(`✅ Approved – “${a.title}” is live.`, [['🕒 Pending ads', 'apend'], ['Menu', 'menu']]); }
    return c.reply(`Why reject “${a.title}”?`, Object.entries(REASONS).map(([k, t]) => [t, `rr:${a.id}:${k}`]));
  }
  if ((m = v.match(/^rr:(\d+):(\w+)$/))) {
    const a = await db.ads.get(+m[1]);
    if (!a || !adInScope(c, a.locality_id)) return adminMenu(c);
    await rejectAd(a.id, REASONS[m[2]] || REASONS.other);
    return c.reply('❌ Rejected – the advertiser has been told why.', [['🕒 Pending ads', 'apend'], ['Menu', 'menu']]);
  }
  if (c.isMain && v === 'apays') {
    const ps = await db.all(`select p.*, v.name, v.phone from payments p join advertisers v on v.id=p.adv_id where p.status='claimed' order by p.id`);
    if (!ps.length) return c.reply('No payments waiting for confirmation.', [['Menu', 'menu']]);
    const P = await db.plans();
    for (const p of ps.slice(0, 8)) await c.reply(`💳 ${rs(p.amount)} – *${p.name}* (+${p.phone})\n${P[p.plan].name} · ${pay.ref(p)} · UPI ref: ${p.utr}`, [[`✅ Confirm ${rs(p.amount)}`, 'pc:' + p.id], ['❌ Not received', 'pr:' + p.id]]);
    return null;
  }
  if (c.isMain && (m = v.match(/^(pc|pr):(\d+)$/))) {
    const pm = await db.one('select * from payments where id=$1', [+m[2]]);
    if (!pm || pm.status === 'paid' || pm.status === 'rejected') return c.reply('Already handled.', [['Menu', 'menu']]);
    if (m[1] === 'pc') { await confirmPayment(pm.id); return c.reply(`✅ Confirmed ${rs(pm.amount)}. Plan activated and the advertiser was told.`, [['💳 Payments', 'apays'], ['Menu', 'menu']]); }
    await db.q(`update payments set status='rejected' where id=$1`, [pm.id]);
    const adv = await db.advertisers.get(pm.adv_id);
    await notify(adv.phone, `⚠️ We couldn't find your payment of ${rs(pm.amount)} (${pay.ref(pm)}). Please check your UPI app and try again, or reply here with the correct reference number.`, [['💳 Plans & renew', 'plans']]);
    return c.reply('Marked as not received. The advertiser was asked to check.', [['Menu', 'menu']]);
  }
  // ---- localities (main admin)
  if (c.isMain && v === 'alocs') {
    const ls = await db.localities.all();
    if (!ls.length) return c.reply('No localities yet.', [['➕ Add locality', 'aadd'], ['Menu', 'menu']]);
    const cnt = await db.all('select locality_id, count(*)::int n from advertisers group by locality_id');
    const nOf = (id) => (cnt.find((x) => x.locality_id === id) || { n: 0 }).n;
    return c.reply('📍 *Localities*\n\n' + ls.map((l) => `*${l.name}*${l.active ? '' : ' ⏸'}\n👤 ${l.admin_phone ? '+' + l.admin_phone + ` (${Math.round(l.share * 100)}%)` : 'You'} · 🏪 ${nOf(l.id)} advertisers`).join('\n\n') + '\n\n_One admin can run several localities._',
      ls.slice(0, 8).map((l) => ['✏️ ' + l.name, 'lo:' + l.id]).concat([['➕ Add locality', 'aadd'], ['Menu', 'menu']]));
  }
  if (c.isMain && (m = v.match(/^lo:(\d+)$/))) {
    const l = await db.localities.get(+m[1]); if (!l) return adminMenu(c);
    return c.reply(`📍 *${l.name}*\nAdmin: ${l.admin_phone ? '+' + l.admin_phone : 'You'}\nStatus: ${l.active ? 'Active' : 'Paused'}`, [['👤 Change admin', 'lch:' + l.id], [l.active ? '⏸ Pause' : '▶ Activate', 'lpa:' + l.id], ['📍 Localities', 'alocs']]);
  }
  if (c.isMain && (m = v.match(/^lpa:(\d+)$/))) { const l = await db.localities.get(+m[1]); await db.localities.set(l.id, { active: !l.active }); return admin(c, 'alocs', true); }
  if (c.isMain && (m = v.match(/^lch:(\d+)$/))) { S.state = 'l_chadmin'; S.data.lid = +m[1]; return c.reply('Send the new area admin’s WhatsApp number, or tap *I’ll run it*.', [["👤 I'll run it", 'lchme']]); }
  if (c.isMain && S.state === 'l_chadmin' && (v === 'lchme' || !btn)) {
    const n = v === 'lchme' ? null : v.replace(/\D/g, '');
    if (n !== null && n.length < 10) return c.reply('Please send a valid 10-digit number.');
    const l = await db.localities.set(S.data.lid, { admin_phone: n ? cfg.norm(n.slice(-10)) : null }); S.state = null;
    if (l.admin_phone) await welcomeAreaAdmin(l);
    return c.reply(`✅ ${l.name} is now run by ${l.admin_phone ? '+' + l.admin_phone : 'you'}.`, [['📍 Localities', 'alocs'], ['Menu', 'menu']]);
  }
  if (c.isMain && v === 'aadd') { S.state = 'l_name'; S.data.nl = {}; return c.reply('📍 Name of the new locality? (e.g. Nehru Nagar)'); }
  if (c.isMain && S.state === 'l_name' && !btn) {
    S.data.nl = { name: v.trim().slice(0, 50) }; S.state = 'l_who';
    const others = [...new Set((await db.localities.all()).map((l) => l.admin_phone).filter(Boolean))].slice(0, 6);
    return c.reply(`Who will run *${S.data.nl.name}*?\nPick an existing area admin, tap *I'll run it*, or type a new admin's WhatsApp number.`, [["👤 I'll run it", 'lw:me']].concat(others.map((p) => ['👥 +' + p, 'lw:' + p])));
  }
  if (c.isMain && S.state === 'l_who') {
    let who = null;
    if ((m = v.match(/^lw:(me|\d+)$/))) who = m[1] === 'me' ? null : m[1];
    else { const n = v.replace(/\D/g, ''); if (n.length < 10) return c.reply('Please send a valid 10-digit number, or tap a button.'); who = cfg.norm(n.slice(-10)); }
    S.data.nl.admin = who; S.state = 'l_loc';
    return wa.askLocation(c.from, `📍 Send the *centre* of ${S.data.nl.name}: tap *Send location* and move the pin to the middle of the area.`);
  }
  if (c.isMain && S.state === 'l_loc' && (m = v.match(/^loc:(-?[\d.]+),(-?[\d.]+)/))) {
    const nl = S.data.nl; S.state = null; S.data.nl = null;
    const l = await db.one('insert into localities(name,admin_phone,lat,lng) values($1,$2,$3,$4) returning *', [nl.name, nl.admin, +m[1], +m[2]]);
    if (l.admin_phone) await welcomeAreaAdmin(l);
    return c.reply(`✅ *${l.name}* added – run by ${l.admin_phone ? '+' + l.admin_phone : 'you'}.\nBusinesses nearby are matched to it automatically.`, [['📍 Localities', 'alocs'], ['Menu', 'menu']]);
  }
  if (c.isMain && S.state === 'l_loc') return wa.askLocation(c.from, 'Please tap *Send location* 👇');
  if (v === 'aearn') return c.reply(await earningsText(c), [['Menu', 'menu']]);
  if (v === 'arev') {
    const locs = await scopeLocs(c), rev = await monthRevenue(c.isMain ? null : c.locIds), mk = network.monthKey();
    const sh = await db.all(`select area_id, coalesce(sum(amount) filter (where role='admin'),0) adm, coalesce(sum(amount) filter (where role='supervisor'),0) sup from earnings where month=$1 and status<>'reversed' group by area_id`, [mk]);
    let total = 0, payable = 0;
    const rows = locs.map((l) => { const r = rev.find((x) => x.locality_id === l.id) || { s: 0, n: 0 }, e = sh.find((x) => x.area_id === l.id) || { adm: 0, sup: 0 }; total += r.s; payable += e.adm + e.sup; return `📍 ${l.name}: ${rs(r.s)} (${r.n} payments)${c.isMain && (e.adm || e.sup) ? ` · admin ${rs(e.adm)} · supervisor ${rs(e.sup)}` : ''}`; });
    if (c.isMain) { const nl = rev.find((x) => x.locality_id == null); if (nl) { total += nl.s; rows.push(`📍 No locality: ${rs(nl.s)}`); } }
    if (!c.isMain) return c.reply(`📈 *Revenue this month*\n\n${rows.join('\n') || 'No payments yet.'}\n\nTotal: *${rs(total)}*\n\n${await earningsText(c)}`, [['Menu', 'menu']]);
    return c.reply(`📈 *Revenue this month*\n\n${rows.join('\n') || 'No payments yet.'}\n\nTotal received: *${rs(total)}*\nAdmins & supervisors: *${rs(payable)}*\n👑 Your net: *${rs(total - payable)}*`, [['Menu', 'menu']]);
  }
  // ---- categories (main admin): three groups – Shops & services, Education (offers) and Property (rent / sale)
  if (c.isMain && v === 'acats') {
    const rows = await db.all(`select c.*, (select count(*)::int from ads a where a.status='live' and ((c.kind='property' and a.type='property' and a.sub=c.name) or (c.kind<>'property' and a.type='deal' and a.cat=c.name))) live from categories c order by sort, id`);
    const grp = (k) => rows.filter((r) => (r.kind || 'shop') === k).map((r) => `${r.emoji} ${r.name}${k === 'property' ? (r.rent ? ' · rent' : ' · sale') : ''}${r.active ? '' : ' · ⏸ hidden'} – ${r.live} live`).join('\n') || '—';
    return c.reply(`🏷 *Categories*\n\n🛍 *Shops & services* (offers)\n${grp('shop')}\n\n🎓 *Education* (offers + "Book free demo")\n${grp('edu')}\n\n🏠 *Property* (rent / sale listings)\n${grp('property')}`,
      [['➕ Add category', 'cadd']].concat(['shop', 'edu', 'property'].flatMap((k) => rows.filter((r) => (r.kind || 'shop') === k)).map((r) => [`✏️ ${r.name}`, 'ced:' + r.id])));
  }
  if (c.isMain && v === 'cadd') { S.state = 'c_name'; S.data.nc = {}; return c.reply('🏷 Name of the new category?\nExamples: *Medical*, *Hardware*, *Music classes*, *Commercial land for sale*', [['❌ Cancel', 'acats']]); }
  if (c.isMain && S.state === 'c_name' && !btn) {
    const name = v.trim().replace(/\s+/g, ' ').slice(0, 28);
    if (name.length < 2) return c.reply('Please send a name with at least 2 letters.');
    if (await db.one('select 1 from categories where lower(name)=lower($1)', [name]) || ['events', 'property'].includes(name.toLowerCase())) return c.reply(`*${name}* already exists. Send another name.`, [['❌ Cancel', 'acats']]);
    S.data.nc = { name }; S.state = 'c_emoji';
    return c.reply(`Send one emoji for *${name}* (e.g. 💊 🔧 🎸 🏭), or tap Skip.`, [['Skip', 'cemo:skip']]);
  }
  if (c.isMain && S.state === 'c_emoji' && (v === 'cemo:skip' || !btn)) {
    S.data.nc.emoji = v === 'cemo:skip' ? '🏷' : [...v.trim()].slice(0, 2).join('') || '🏷'; S.state = 'c_group';
    return c.reply(`Which group is *${S.data.nc.emoji} ${S.data.nc.name}*?\n🛍 *Shops & services* – offers with coupon codes\n🎓 *Education* – offers with "Book free demo"\n🏠 *Property* – listings with "Contact owner" and "Book a visit"`, [['🛍 Shops & services', 'cgrp:shop'], ['🎓 Education', 'cgrp:edu'], ['🏠 Property', 'cgrp:property']]);
  }
  if (c.isMain && S.state === 'c_group' && (m = v.match(/^cgrp:(shop|edu|property)$/))) {
    S.data.nc.kind = m[1];
    if (m[1] === 'property') { S.state = 'c_rent'; return c.reply(`Is *${S.data.nc.name}* for rent or for sale?\n(Rent asks owners for "monthly rent", sale asks for "price".)`, [['🔑 For rent', 'crnt:1'], ['🏷 For sale', 'crnt:0']]); }
    return addCategory(c);
  }
  if (c.isMain && S.state === 'c_rent' && (m = v.match(/^crnt:(0|1)$/))) { S.data.nc.rent = m[1] === '1'; return addCategory(c); }
  if (c.isMain && (m = v.match(/^ced:(\d+)$/))) {
    const r = await db.one('select * from categories where id=$1', [+m[1]]); if (!r) return admin(c, 'acats', true);
    const kind = r.kind || 'shop';
    const n = (await db.one(kind === 'property' ? `select count(*)::int n from ads where type='property' and sub=$1` : `select count(*)::int n from ads where type='deal' and cat=$1`, [r.name])).n;
    const b = [['✏️ Rename', 'cren:' + r.id], ['😀 Change emoji', 'cemj:' + r.id]];
    if (kind === 'property') b.push([r.rent ? '🏷 Make it "for sale"' : '🔑 Make it "for rent"', 'crs:' + r.id]);
    else b.push([kind === 'edu' ? '🛍 Move to Shops' : '🎓 Move to Education', 'cgsw:' + r.id]);
    b.push([r.active ? '⏸ Hide' : '▶ Show', 'chid:' + r.id], ['🏷 Categories', 'acats']);
    return c.reply(`${r.emoji} *${r.name}*\nGroup: ${{ shop: '🛍 Shops & services', edu: '🎓 Education', property: r.rent ? '🏠 Property · for rent' : '🏠 Property · for sale' }[kind]} · ${r.active ? 'Shown' : '⏸ Hidden'} · ${n} ads`, b);
  }
  if (c.isMain && (m = v.match(/^(cren|cemj):(\d+)$/))) { S.state = m[1] === 'cren' ? 'c_ren' : 'c_emj'; S.data.cid = +m[2]; return c.reply(m[1] === 'cren' ? 'Send the new name:' : 'Send the new emoji:', [['❌ Cancel', 'acats']]); }
  if (c.isMain && S.state === 'c_ren' && !btn) {
    const r = await db.one('select * from categories where id=$1', [S.data.cid]), name = v.trim().replace(/\s+/g, ' ').slice(0, 28); S.state = null;
    if (!r || name.length < 2) return admin(c, 'acats', true);
    if (await db.one('select 1 from categories where lower(name)=lower($1) and id<>$2', [name, r.id])) return c.reply(`*${name}* already exists.`, [['🏷 Categories', 'acats']]);
    await renameCategory(r, name);
    return c.reply(`✅ Renamed *${r.name}* → *${name}* (ads and businesses updated).`, [['🏷 Categories', 'acats']]);
  }
  if (c.isMain && S.state === 'c_emj' && !btn) { S.state = null; await db.q('update categories set emoji=$2 where id=$1', [S.data.cid, [...v.trim()].slice(0, 2).join('') || '🏷']); await loadCats(); return admin(c, 'ced:' + S.data.cid, true); }
  if (c.isMain && (m = v.match(/^(cgsw|chid|crs):(\d+)$/))) {
    const sql = { cgsw: `update categories set kind = case when kind='edu' then 'shop' else 'edu' end, edu = (kind<>'edu') where id=$1 and kind<>'property'`, chid: 'update categories set active=not active where id=$1', crs: `update categories set rent=not rent where id=$1 and kind='property'` }[m[1]];
    await db.q(sql, [+m[2]]); await loadCats(); return admin(c, 'ced:' + m[2], true);
  }
  if (c.isMain && v === 'adigest') { const n = await require('./jobs').runDigest(true); return c.reply(`📢 Daily offers sent to *${n}* subscribers.`, [['Menu', 'menu']]); }
  if (v === 'aweb') return c.reply(`🌐 Web admin panel: ${cfg.PUBLIC_URL || cfg.WEBSITE}/panel\nLog in with this WhatsApp number – you'll get a code here.`, [['Menu', 'menu']]);
  return adminMenu(c);
}

/* =================================================================== MEDIA */
async function saveMedia(waId) {
  try {
    const f = await wa.downloadMedia(waId);
    if (!f) return null;
    if (f.data.length > 5 * 1024 * 1024) return null;
    return (await db.one('insert into media(mime,data) values($1,$2) returning id', [f.mime, f.data])).id;
  } catch (e) { console.error('media', e.message); return null; }
}

/* ================================================================== ROUTER */
async function handle(from, name, v, btn) {
  if (cfg.IGNORE_PHONES.includes(from)) return;
  await ensureCats();
  const sess = await db.sessions.get(from);
  sess.data = sess.data || {};
  const isMain = cfg.ADMINS.includes(from);
  const myLocs = await db.localities.byAdmin(from);
  const isAdmin = isMain || myLocs.length > 0;
  const cust = await db.customers.touch(from, name);
  const c = {
    from, name, sess, isMain, isAdmin, myLocs, locIds: myLocs.map((l) => l.id), cust,
    adv: await db.advertisers.byPhone(from),
    reply: (t, b = [], img = null) => out(from, t, b, img),
    say: (t) => wa.sendText(from, t),
  };
  try {
    let m;
    // paging of long menus
    if ((m = v.match(/^pg:(\d+)$/))) {
      const row = await db.one('select * from menus where phone=$1', [from]);
      if (row) return await sendPage(from, row.text, row.items, +m[1]);
    }
    let low = v.trim().toLowerCase();
    // ---- language
    let m2;
    if ((m2 = v.match(/^lang:(en|ta|hi)$/))) {
      await setLang(from, m2[1]); await c.say('✅ Language set to English.');
      const pend = sess.data.pending; sess.data.pending = null; await db.sessions.save(from, sess); sess.noSave = true;
      return await handle(from, name, pend || 'menu', !!(pend && /^(loc|img):/.test(pend)));
    }
    const byWord = { tamil: 'ta', 'தமிழ்': 'ta', hindi: 'hi', 'हिंदी': 'hi', 'हिन्दी': 'hi', english: 'en' }[low];
    if (byWord) { await setLang(from, byWord); await c.say('✅ Language set to English.'); await db.sessions.save(from, sess); sess.noSave = true; return await handle(from, name, 'menu', false); }
    if (v === 'lang' || i18n.WORDS.lang.includes(low)) return await wa.send(from, i18n.PICKER, i18n.PICKER_BTNS);
    if (!cust.lang) {
      const guess = i18n.detect(v);
      if (guess) await setLang(from, guess);
      else if (isMain || myLocs.length || /^(offer|coupon|enquiry|contact|visit|interested|demo|admission)\s*#/i.test(v.trim())) await setLang(from, 'en');
      else { sess.data.pending = v; return await wa.send(from, i18n.PICKER, i18n.PICKER_BTNS); }
    }
    // Referral links open the bot with "business ref:CODE": remember which zone admin sent this person
    if (!btn) {
      const rf = await network.applyRef(from, v);
      if (rf) {
        if (rf.isNew && rf.area && rf.area.admin_phone && rf.area.admin_phone !== from) await notify(rf.area.admin_phone, `👋 New contact from your referral link (${rf.area.name}): ${name || 'someone'} +${from}`);
        v = rf.rest && !/^(hi|hello|hai|hey)$/i.test(rf.rest) ? rf.rest : 'menu'; low = v.trim().toLowerCase();
      }
    }
    if (i18n.WORDS.menu.includes(low)) { v = 'menu'; low = 'menu'; }
    if (i18n.WORDS.stop.includes(low)) { v = 'stop'; low = 'stop'; }
    // role switches
    if (['#customer', '#shop', '#browse'].includes(low)) { sess.data.as = 'customer'; sess.state = null; return await custMenu(c); }
    // Someone new who typed "business" (e.g. from the poster QR) first sees all three choices
    if (!btn && ['business', 'advertise'].includes(low) && !c.adv && !isAdmin && cust.lat == null && !sess.state && !sess.data.started) { sess.data.started = true; return await startMenu(c, true); }
    if (['#business', 'business', 'advertise', 'biz', '#biz'].includes(low)) { sess.data.as = 'business'; sess.state = c.adv ? null : sess.state; return await advertiser(c, 'biz', true); }
    if (low === '#admin' && isAdmin) { sess.data.as = null; return await adminMenu(c); }
    if (low === 'delete my data') {
      await db.q('delete from customers where phone=$1', [from]); await db.q('delete from coupons where phone=$1 and redeemed_at is null', [from]);
      return await c.say('🗑 Your customer data has been deleted. Businesses can contact info@vasulbook.com to close their account.');
    }
    if (/^(offer|coupon|enquiry|contact|visit|interested|demo|admission)\s*#\s*\d+/i.test(v.trim())) return await customer(c, v, false);
    let role = sess.data.as || (isAdmin ? 'admin' : c.adv ? 'business' : 'customer');
    if (role === 'admin' && !isAdmin) role = 'customer';
    // Buttons from alerts work in any view: admin actions (approve, payments, localities)…
    if (isAdmin && btn && /^(ap|rj|rr|pc|pr|lo|lch|lpa|lw|ced|cren|cemj|cgsw|chid|cgrp|cemo):|^(apend|apays|alocs|aadd|arev|aearn|adigest|aweb|acats|cadd)$/.test(v)) return await admin(c, v, btn);
    // …and an admin's own business buttons while in admin view
    if (role !== 'business' && c.adv && btn && /^(myads|plans|redeem|acat|acatmv|dcat|dskip|dsubmit|okVisit)$|^(post|paid|plan|ad|adp|adr|add|adl|acat|dcat|dsub|dval|drad):/.test(v)) { sess.data.as = 'business'; return await advertiser(c, v, btn); }
    if (role === 'business' || (role === 'customer' && v === 'biz')) { sess.data.as = 'business'; return await advertiser(c, v, btn); }
    if (role === 'admin') return await admin(c, v, btn);
    return await customer(c, v, btn);
  } finally {
    if (!sess.noSave) await db.sessions.save(from, sess);
  }
}

module.exports = { refundPayment, earningsText, renameCategory, PROPS, SUBEMO, RENT, loadCats, ensureCats, webLink, handle, notify, notifyAdmins, approveAd, rejectAd, confirmPayment, activatePlan, welcomeAreaAdmin, nearby, cardText, imgOf, rs, km, istDate, planActive, REASONS, CATS, EMO, EDU, SUBS };
