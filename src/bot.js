// Conversation logic for the three roles: Admin, Shop owner, Customer.
// Mirrors the approved prototype.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const wa = require('./wa');
const pay = require('./pay');
const invoice = require('./invoice');
const catalog = require('./catalog');
const i18n = require('./strings');
const network = require('./network');

/* -------------------------------------------------------------- language */
const langCache = new Map();
async function langOf(phone) {
  phone = cfg.norm(phone);
  if (langCache.has(phone)) return langCache.get(phone);
  const r = await db.one('select lang from cust_lang where phone=$1', [phone]);
  const l = r ? r.lang : null;
  if (l) langCache.set(phone, l);
  return l;
}
async function setLang(phone, l) {
  await db.q('insert into cust_lang(phone,lang) values($1,$2) on conflict(phone) do update set lang=$2, updated_at=now()', [phone, l]);
  langCache.set(phone, l);
}
wa.setLangResolver(langOf);

const rs = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const MONTH = () => new Date().toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
const MONTH_KEY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
// 'YYYY-MM' of last month (IST) and a month key as words, e.g. 'October 2026'
const PREV_MONTH_KEY = () => { const [y, mo] = MONTH_KEY().split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const MONTH_NAME = (mk) => new Date(mk + '-15T00:00:00Z').toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const MENU_WORDS = ['hi', 'hello', 'hey', 'menu', 'start', '0', 'hii', 'vanakkam', 'namaste'];
const CLOSED = ['Completed', 'Cancelled'];

/* ------------------------------------------------------------------ outbound */
const PER = 8;
async function sendPage(to, text, btns, p) {
  const slice = btns.slice(p * PER, p * PER + PER);
  if (p > 0) slice.push(['◀ Previous', 'pg:' + (p - 1)]);
  if ((p + 1) * PER < btns.length) slice.push(['More options ▶', 'pg:' + (p + 1)]);
  return wa.send(to, p === 0 ? text : `More options (page ${p + 1}) 👇`, slice);
}
async function out(to, text, btns = []) {
  if (btns.length > 10) {
    await db.q(`insert into menus(phone,text,items) values($1,$2,$3) on conflict(phone) do update set text=$2, items=$3`, [to, text, JSON.stringify(btns)]);
    return sendPage(to, text, btns, 0);
  }
  return wa.send(to, text, btns);
}
// Message to someone other than the sender (may be outside the 24h window).
async function notify(to, text, btns = []) {
  try { await out(to, text, btns); }
  catch (e) {
    console.error('notify failed', to, e.code, e.message);
    try { await wa.sendTemplate(to, text); } catch (e2) { console.error('template failed', to, e2.message); }
  }
}
const notifyAdmins = (text, btns) => Promise.all(cfg.ADMINS.map((a) => notify(a, text, btns)));
// The area admin of a shop's locality (if any)
async function areaAdminOf(s) { if (!s || !s.area_id) return null; const a = await db.areas.get(s.area_id); return a && a.admin_phone ? a.admin_phone : null; }
// Main admins + that shop's area admin
async function notifyShopAdmins(s, text, btns) {
  const to = new Set(cfg.ADMINS); const aa = await areaAdminOf(s); if (aa) to.add(aa);
  await Promise.all([...to].map((p) => notify(p, text, btns)));
}
// Deliveries: area admin handles them; main admins only if the area has no admin
async function notifyDelivery(s, text, btns) {
  const aa = await areaAdminOf(s);
  if (aa) return notify(aa, text, btns);
  return notifyAdmins(text, btns);
}
const km = (a, b) => {
  const R = 6371, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const fmtKm = (d) => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`);
// Shops this admin may manage (main admin: all; area admin: own areas)
async function scopedShops(c) { const all = await db.shops.all(); return c.isSuper ? all : all.filter((s) => c.areaIds.includes(s.area_id)); }
const inScope = (c, s) => !!s && (c.isSuper || c.areaIds.includes(s.area_id));

async function sendInvoice(to, o, s, btns = []) {
  if (cfg.PUBLIC_URL) {
    try { await wa.sendDoc(to, `${cfg.PUBLIC_URL}/inv/${o.token}.pdf`, `${o.inv}.pdf`, `Invoice ${o.inv} · ${s.name} · ${rs(o.total)}`); }
    catch (e) { console.error('doc failed', e.message); await out(to, invoice.text(o, s)); }
    if (btns.length) await out(to, 'Anything else?', btns);
  } else await out(to, invoice.text(o, s), btns);
}

/* ------------------------------------------------------------ order status */
async function setStatus(o, st) {
  const s = await db.shops.get(o.shop_id);
  const patch = { status: st };
  if (st === 'Accepted' && o.pay === 'UPI') patch.paid = true;
  if (st === 'Completed') patch.paid = true;
  o = await db.orders.set(o.id, patch);
  const ck = o.cust_phone, ok = s.owner_phone, n = o.id;
  if (st === 'Accepted') await notify(ck, `✅ *${s.name}* accepted your order #${n}. Packing it now.`);
  if (st === 'Ready') {
    if (o.mode === 'pickup') await notify(ck, `📦 Order #${n} is *ready for pickup* at ${s.name}, ${s.area}.\nShow order number #${n} at the counter.${o.paid ? '' : ' Pay ' + rs(o.total) + ' at the shop.'}`);
    else {
      await notify(ck, `📦 Order #${n} is packed. A delivery partner will pick it up shortly.`);
      await notifyDelivery(s, `📦 *Pickup ready* — order #${n}\nFrom: ${s.name}, ${s.area}\nTo: ${o.addr}\nCustomer: +${o.cust_phone}\nCollect: ${o.paid ? 'Prepaid' : rs(o.total) + ' cash'}`,
        [[`🛵 Dispatch #${n}`, 'disp:' + n], ['🛵 Delivery desk', 'deliv']]);
    }
  }
  if (st === 'Out for delivery') {
    await notify(ck, `🛵 Your order #${n} is *out for delivery*!${o.paid ? '' : ' Keep ' + rs(o.total) + ' cash ready.'}`);
    await notify(ok, `🛵 Rider picked up order #${n}.`);
  }
  if (st === 'Completed') {
    if (o.mode === 'delivery') await notify(ok, `✅ Order #${n} delivered to ${o.cust_name || 'customer'}.`);
    await notify(ck, `✅ Order #${n} completed. Thank you for shopping with *${s.name}*! 🙏`, [['🛒 Order again', 'shop:' + s.id], ['⭐ Rate 5 stars', 'rate'], ['📄 Invoice', 'inv:' + n]]);
  }
  if (st === 'Cancelled') {
    for (const l of o.lines) await db.q('update items set stock=stock+$2 where id=$1', [l.id, l.q]);
    await notify(ck, `❌ Sorry, *${s.name}* couldn't accept order #${n}.${o.pay === 'UPI' ? ' If you already paid by UPI, the shop will refund you.' : ''}`, [['🏠 Other shops', 'menu']]);
  }
  return o;
}

/* =================================================================== ADMIN */
const shopLine = (s, n) => `*${s.name}* (${s.code}) · ${s.area}\n   ${!s.paid ? '⏳ Setup fee pending' : s.active ? '🟢 Live' : '⏸ Paused'} · ${n} items · ${s.delivery ? '🛵 Delivery opted' : '🏃 Pickup only'}`;
const itemCount = async (sid) => (await db.one('select count(*)::int c from items where shop_id=$1', [sid])).c;

async function mkCode(name) {
  let c = name.toUpperCase().split(/\s+/).map((w) => w.replace(/[^A-Z]/g, '')[0] || '').join('');
  if (c.length < 3) c = (c + name.toUpperCase().replace(/[^A-Z]/g, '')).slice(0, 3);
  c = c.slice(0, 3) || 'SHP';
  let x = c, i = 2;
  while (await db.one('select 1 from shops where code=$1', [x])) x = c.slice(0, 2) + i++;
  return x;
}

async function ownerWelcome(s) {
  await notify(s.owner_phone, `👋 Welcome to *${cfg.BRAND}*, ${s.name}!\n\nYour shop was added by the admin. To go live:\n1️⃣ Pay the one-time setup fee of *${rs(cfg.SETUP_FEE)}*\n2️⃣ Add your items & prices here on WhatsApp\n3️⃣ Set your UPI ID: _upi yourname@okaxis_\n\nAfter that you pay only *${cfg.COMM * 100}% of your monthly sales*.`,
    [['💳 Pay setup fee', 'paysetup'], ['➕ Add items', 'additem'], ['Menu', 'menu']]);
}

// Commission for money that has come in: zone admin 40%, taluk supervisor 10% (see network.js)
async function earn(p, s) {
  await db.q('update payments set area_id=$2 where id=$1', [p.id, s.area_id || null]);
  const rows = await network.record({ paymentId: p.id, source: p.kind, areaId: s.area_id, amount: Number(p.amount), paidAt: p.paid_at });
  const what = p.kind === 'setup' ? 'setup fee' : `${p.month ? MONTH_NAME(p.month) + ' ' : ''}service fee`;
  for (const e of rows) await notify(e.phone, `💰 You earned *${rs(e.amount)}* (${e.pct}%) — ${s.name} paid the ${rs(p.amount)} ${what}.
It's added to your next payout.`, [['💰 My earnings', 'myearn']]);
  return rows;
}

// Setup fee received. p = the paid payment (from Razorpay, or confirmed by the main admin).
async function activate(s, p = null) {
  if (s.paid) return false;
  s = await db.shops.set(s.id, { paid: true, active: true, paid_at: new Date() });
  if (!p) p = await db.one(`insert into payments(kind,ref,amount,status,paid_at,area_id) values('setup',$1,$2,'paid',now(),$3) returning *`, [s.id, cfg.SETUP_FEE, s.area_id || null]);
  await db.q(`update payments set status='cancelled' where kind='setup' and ref=$1 and id<>$2 and status='created'`, [s.id, p.id]);
  await earn(p, s);
  const n = await itemCount(s.id);
  await notify(s.owner_phone, `🎉 Payment of ${rs(cfg.SETUP_FEE)} received.\n*${s.name} is now LIVE* — customers can order from you on WhatsApp.\n\nBilling: ${cfg.COMM * 100}% of monthly sales, sent at the start of every month.${n ? '' : '\n\n👉 Add your items to start getting orders.'}`,
    [['➕ Add items', 'additem'], ['Menu', 'menu']]);
  await notifyShopAdmins(s, `💰 Setup fee ${rs(cfg.SETUP_FEE)} received from *${s.name}*. Shop is now live.`, [['🏪 Manage shops', 'list']]);
  return true;
}

// Monthly 2% bill for a finished month (default: last month). A shop is billed once per month.
async function sendBills(mk = PREV_MONTH_KEY()) {
  const live = (await db.shops.all()).filter((s) => s.paid);
  let sent = 0;
  for (const s of live) {
    if (await db.one(`select 1 from payments where kind='bill' and ref=$1 and month=$2 and status not in ('cancelled','refunded')`, [s.id, mk])) continue;
    const ms = await db.shops.salesIn(s.id, mk), amt = Math.round(ms * cfg.COMM * 100) / 100;
    if (amt <= 0) continue;
    const p = await pay.createLink({ kind: 'bill', ref: s.id, month: mk, amount: amt, description: `${cfg.BRAND} ${MONTH_NAME(mk)} service fee – ${s.name}`, phone: s.owner_phone, name: s.name });
    await notify(s.owner_phone, `🧾 *${cfg.BRAND} — ${MONTH_NAME(mk)} bill*\nYour sales: ${rs(ms)}\nService fee (${cfg.COMM * 100}%): *${rs(amt)}*\n\n${pay.payText(p)}`);
    sent++;
  }
  return sent;
}
// Reminder for bills still unpaid
async function remindBills(mk = PREV_MONTH_KEY()) {
  const ps = await db.all(`select p.*, s.name, s.owner_phone from payments p join shops s on s.id=p.ref where p.kind='bill' and p.month=$1 and p.status='created'`, [mk]);
  for (const p of ps) await notify(p.owner_phone, `⏰ *Reminder:* your ${cfg.BRAND} ${MONTH_NAME(mk)} bill of *${rs(p.amount)}* is still unpaid.\n\n${pay.payText(p)}`);
  return ps.length;
}
// A bill payment came in (Razorpay, or confirmed by the main admin)
async function billPaid(p) {
  const s = await db.shops.get(p.ref);
  await earn(p, s);
  await notify(s.owner_phone, `✅ Payment of ${rs(p.amount)} received. Thank you!`);
  await notifyAdmins(`💰 ${s.name} paid the ${p.month ? MONTH_NAME(p.month) : ''} bill: ${rs(p.amount)}`);
}
// Main admin confirms a payment made outside Razorpay (direct UPI)
async function confirmPayment(id) {
  const p = await db.one(`update payments set status='paid', paid_at=now() where id=$1 and status='created' returning *`, [id]);
  if (!p) return null;
  const s = await db.shops.get(p.ref);
  if (p.kind === 'setup') { if (!(await activate(s, p))) await earn(p, s); } else await billPaid(p);
  return p;
}
// Refund: the payment is marked refunded and the commission on it is taken back
async function refundPayment(id) {
  const p = await db.one(`update payments set status='refunded' where id=$1 and status='paid' returning *`, [id]);
  if (!p) return null;
  await network.reverse(p.id, p.kind);
  return p;
}

async function adminMenu(c) {
  c.sess.state = null;
  const sup = c.isSuper ? [] : await network.supervisorOf(c.from);
  const title = c.isSuper ? `👑 *${cfg.BRAND} — Main admin*` : `🗺 *${cfg.BRAND} — ${sup.length ? 'Supervisor' : 'Zone admin'}*\n${c.myAreas.map((a) => a.name).join(', ') || sup.map((t) => t.name + ' taluk').join(', ')}`;
  const b = [['➕ Add new shop', 'add'], ['🏪 Manage shops', 'list'], ['📊 Sales & earnings', 'sales'], ['🛵 Delivery desk', 'deliv']];
  if (c.isSuper) b.push(['🗺 Areas & admins', 'areas']);
  else b.push(['💰 My earnings', 'myearn']);
  b.push(['🌐 Web admin panel', 'web']);
  return c.reply(`${title}\nWhat would you like to do?`, b);
}

// ---- areas (main admin only)
async function areaLine(a) {
  const n = (await db.one('select count(*)::int c from shops where area_id=$1', [a.id])).c;
  return `*${a.name}* ${a.active ? '' : '⏸'}\n   👤 Admin: ${a.admin_phone ? '+' + a.admin_phone : 'not set'} · ${n} shops · ${a.lat != null ? `📍 ${a.radius_km} km radius` : '📍 location not set'}`;
}
// This month's numbers for one zone. Commission comes from the earnings ledger (money received only).
async function areaMoney(a) {
  const shops = await db.all('select * from shops where area_id=$1', [a.id]);
  let sales = 0; for (const s of shops) sales += await db.shops.monthSales(s.id);
  const paid = shops.filter((s) => s.paid).length;
  const mk = network.monthKey();
  const got = await db.one(`select coalesce(sum(amount),0) s from payments where area_id=$1 and status='paid' and to_char(paid_at at time zone 'Asia/Kolkata','YYYY-MM')=$2`, [a.id, mk]);
  const e = await db.one(`select coalesce(sum(amount) filter (where role='admin'),0) adm, coalesce(sum(amount) filter (where role='supervisor'),0) sup from earnings where area_id=$1 and month=$2 and status<>'reversed'`, [a.id, mk]);
  return { shops: shops.length, paid, sales, received: got.s, admin: e.adm, supervisor: e.sup };
}
async function newAreaAdminWelcome(a) {
  a = await network.ensureRef(a.id);
  await notify(a.admin_phone, `🗺 You are now the *zone admin* for *${a.name}* on ${cfg.BRAND}.\n\nYou add and manage shops in your zone, handle home deliveries, and earn *${network.ADMIN_PCT}% of every payment* your shops make (setup fee and monthly fee), paid out every month.\n\n🔗 Your referral link (put it on your posters):\n${network.refLink(a)}\n\nType *menu* to start.`, [['💰 My earnings', 'myearn'], ['Menu', 'menu']]);
}
// "My earnings" for zone admins and supervisors
async function earningsText(c) {
  const x = await network.summary(c.from);
  const sup = await network.supervisorOf(c.from);
  const own = c.myAreas.filter((a) => a.admin_phone === c.from);
  const links = [];
  for (let a of own) { a = await network.ensureRef(a.id); links.push(`📍 ${a.name}: ${network.refLink(a)}`); }
  let teamTxt = '';
  if (sup.length) {
    const t = await network.team(c.from);
    teamTxt = `\n\n👥 *Your team* (${sup.map((x2) => x2.name).join(', ')})\n` + (t.map((a) => `• ${a.name}: ${a.admin_phone ? '+' + a.admin_phone : 'no admin'} · ${rs(a.earned)}`).join('\n') || 'No zones yet.');
  }
  return `💰 *My earnings*\nThis month: *${rs(x.month)}*\nWaiting for payout: *${rs(x.due)}*\nPaid out so far: ${rs(x.paid)}\n\nYou earn ${own.length ? `${network.ADMIN_PCT}% as zone admin` : ''}${own.length && sup.length ? ' and ' : ''}${sup.length ? `${network.SUP_PCT}% as supervisor` : ''} on payments that have come in.${links.length ? `\n\n🔗 *Referral link*\n${links.join('\n')}` : ''}${teamTxt}`;
}

async function areaStep(c) {
  const S = c.sess;
  const choices = c.isSuper ? await db.areas.active() : c.myAreas;
  if (choices.length > 1 || (c.isSuper && choices.length === 1)) {
    S.state = 'a_pick';
    return c.reply('Which area does this shop belong to?', choices.map((a) => ['🗺 ' + a.name, 'sa:' + a.id]).concat(c.isSuper ? [['No area', 'sa:0']] : []));
  }
  const ns = S.data.ns; S.state = null; delete S.data.ns;
  return createShop(c, ns, choices[0] ? choices[0].id : null);
}

async function createShop(c, ns, areaId) {
  // No zone picked: the zone whose admin referred this owner gets the shop
  if (!areaId) { const ra = await network.referralArea(ns.owner); if (ra) areaId = ra.id; }
  const a = areaId ? await db.areas.get(areaId) : null;
  const s = await db.one('insert into shops(code,name,owner_phone,area,delivery,area_id,type_id) values($1,$2,$3,$4,$5,$6,$7) returning *',
    [await mkCode(ns.name), ns.name, ns.owner, ns.area, ns.delivery, areaId || null, ns.type_id || null]);
  const st = s.type_id ? await catalog.type(s.type_id) : null;
  await c.reply(`✅ *${s.name}* added (code ${s.code})\n📍 ${s.area}${a ? ' · 🗺 ' + a.name : ''}${st ? ' · 🏷 ' + st.name : ''} · 📱 +${s.owner_phone}\n${s.delivery ? '🛵 Home delivery: ON' : '🏃 Pickup only'}\n\n📩 Welcome message + ${rs(cfg.SETUP_FEE)} setup-fee request sent to the owner. Ask the owner to share the shop's 📍 location from *Settings* so nearby customers can find it.\n_If the owner has never messaged this bot, ask them to send *hi* to this number once._`,
    [c.isSuper ? [`✅ Mark ${rs(cfg.SETUP_FEE)} received`, 'paid:' + s.id] : ['📩 Send payment link', 'plink:' + s.id], ['🏪 Manage shops', 'list'], ['Menu', 'menu']]);
  if (c.isSuper && a && a.admin_phone && a.admin_phone !== c.from) await notify(a.admin_phone, `🏪 New shop added in *${a.name}*: ${s.name} (+${s.owner_phone}).`);
  else if (!c.isSuper) await notifyAdmins(`🏪 Area admin +${c.from} added *${s.name}* in ${a ? a.name : s.area}.`);
  return ownerWelcome(s);
}

async function admin(c, v, btn) {
  const S = c.sess, low = v.trim().toLowerCase();
  let m;
  if (MENU_WORDS.includes(low)) return adminMenu(c);
  // --- add shop flow
  if (!btn && S.state === 'a_name') { S.data.ns = { name: v.trim() }; S.state = 'a_owner'; return c.reply(`Shop: *${S.data.ns.name}*\nSend the owner's WhatsApp number.`); }
  if (!btn && S.state === 'a_owner') {
    const n = v.replace(/\D/g, '');
    if (n.length < 10) return c.reply('Please send a valid 10-digit mobile number.');
    S.data.ns.owner = cfg.norm(n.slice(-10)); S.state = 'a_area';
    return c.reply('Street / locality name of the shop? (shown to customers)');
  }
  if (!btn && S.state === 'a_area') { S.data.ns.area = v.trim(); S.state = 'a_del'; return c.reply('Will this shop offer *home delivery* (by the area delivery team)?', [['🛵 Yes, opt in', 'del:y'], ['🏃 No, pickup only', 'del:n']]); }
  if ((m = v.match(/^del:(y|n)$/)) && S.state === 'a_del' && S.data.ns) {
    S.data.ns.delivery = m[1] === 'y';
    const ts = await catalog.types();
    if (ts.length) { S.state = 'a_type'; return c.reply('What type of shop is it?', ts.map((t) => ['🏷 ' + t.name, 'stype:' + t.id]).concat([['Other / not listed', 'stype:0']])); }
    return areaStep(c);
  }
  if ((m = v.match(/^stype:(\d+)$/)) && S.state === 'a_type' && S.data.ns) { S.data.ns.type_id = +m[1] || null; return areaStep(c); }
  if ((m = v.match(/^sa:(\d+)$/)) && S.state === 'a_pick' && S.data.ns) {
    const id = +m[1];
    if (id && !c.isSuper && !c.areaIds.includes(id)) return c.reply('Not your area.');
    const ns = S.data.ns; S.state = null; delete S.data.ns;
    return createShop(c, ns, id || null);
  }
  if (v === 'add') { S.state = 'a_name'; return c.reply('➕ *New shop*\nSend the shop name.'); }
  if (v === 'myearn') return c.reply(await earningsText(c), [['Menu', 'menu']]);
  if (v === 'web') return c.reply(cfg.PUBLIC_URL ? `🌐 Web admin panel:\n${cfg.PUBLIC_URL}/panel\nLog in with your WhatsApp number — the code comes here.` : 'Set PUBLIC_URL to enable the web dashboard.', [['Menu', 'menu']]);

  // --- areas (main admin)
  if (c.isSuper) {
    if (v === 'areas') {
      const as = await db.areas.all();
      const lines = []; for (const a of as) lines.push(await areaLine(a));
      return c.reply(`🗺 *Zones & admins*\nOn money received: zone admin ${network.ADMIN_PCT}% · taluk supervisor ${network.SUP_PCT}% · you the rest.\nSet each zone's taluk and supervisors on the web panel → Network.\n\n${lines.join('\n\n') || 'No areas yet.'}`,
        [['➕ Add area', 'ar_add']].concat(as.map((a) => ['⚙️ ' + a.name, 'ar:' + a.id]), [['Menu', 'menu']]));
    }
    if (v === 'ar_add') { S.state = 'ar_name'; S.data.na = {}; return c.reply('🗺 *New area*\nSend the area / locality name (e.g. Anna Nagar).'); }
    if (!btn && S.state === 'ar_name') { S.data.na = { name: v.trim() }; S.state = 'ar_admin'; return c.reply(`Area: *${S.data.na.name}*\nSend the area admin's WhatsApp number (or *skip* to manage it yourself).`); }
    if (!btn && S.state === 'ar_admin') {
      if (low !== 'skip') { const n = v.replace(/\D/g, ''); if (n.length < 10) return c.reply('Send a valid 10-digit number, or *skip*.'); S.data.na.admin = cfg.norm(n.slice(-10)); }
      S.state = 'ar_loc';
      return c.reply('📍 Share the *centre location* of this area: tap 📎 → *Location* → send a location at the centre of the area.\nOr type *skip* (customers can still pick the area from a list).');
    }
    if (S.state === 'ar_loc' && (c.loc || low === 'skip')) {
      if (c.loc) { S.data.na.lat = c.loc.lat; S.data.na.lng = c.loc.lng; }
      S.state = 'ar_rad';
      return c.reply('How far should customers be able to order from (radius)?', [['2 km', 'rad:2'], ['3 km', 'rad:3'], ['5 km', 'rad:5']]);
    }
    if ((m = v.match(/^rad:(\d+)$/)) && S.state === 'ar_rad' && S.data.na) {
      const na = S.data.na; S.state = null; delete S.data.na;
      const a = await db.one('insert into areas(name,admin_phone,lat,lng,radius_km) values($1,$2,$3,$4,$5) returning *', [na.name, na.admin || null, na.lat ?? null, na.lng ?? null, +m[1]]);
      if (a.admin_phone) await newAreaAdminWelcome(a);
      return c.reply(`✅ Area *${a.name}* created.\n${a.admin_phone ? `👤 Area admin +${a.admin_phone} has been notified.` : '👤 No area admin — you manage it.'}\n📍 ${a.lat != null ? a.radius_km + ' km radius' : 'No centre location'}`, [['🗺 Areas & admins', 'areas'], ['Menu', 'menu']]);
    }
    if ((m = v.match(/^ar:(\d+)$/))) {
      const a = await db.areas.get(+m[1]); if (!a) return c.reply('Area not found.');
      const x = await areaMoney(a);
      const ar = await network.ensureRef(a.id);
      return c.reply(`${await areaLine(a)}\n\n💰 *${MONTH()}*\nShop sales: ${rs(x.sales)}\nPayments received: *${rs(x.received)}*\n  → Zone admin ${network.ADMIN_PCT}%: ${rs(x.admin)}\n  → Supervisor ${network.SUP_PCT}%: ${rs(x.supervisor)}\n  → You: *${rs(x.received - x.admin - x.supervisor)}*\n\n🔗 Referral link: ${network.refLink(ar)}`,
        [['👤 Change area admin', 'ar_chg:' + a.id], [a.active ? '⏸ Pause area' : '▶️ Resume area', 'ar_tog:' + a.id], ['📍 Set centre location', 'ar_loc:' + a.id], ['🗺 All areas', 'areas'], ['Menu', 'menu']]);
    }
    if ((m = v.match(/^ar_chg:(\d+)$/))) { S.state = 'ar_chg'; S.data.aid = +m[1]; return c.reply('Send the new area admin\'s WhatsApp number (or *none* to remove).'); }
    if (!btn && S.state === 'ar_chg') {
      let ph = null;
      if (low !== 'none') { const n = v.replace(/\D/g, ''); if (n.length < 10) return c.reply('Send a valid 10-digit number, or *none*.'); ph = cfg.norm(n.slice(-10)); }
      const a = await db.areas.set(S.data.aid, { admin_phone: ph }); S.state = null; delete S.data.aid;
      if (ph) await newAreaAdminWelcome(a);
      return c.reply(`✅ ${a.name}: area admin ${ph ? 'set to +' + ph : 'removed'}.`, [['⚙️ ' + a.name, 'ar:' + a.id], ['Menu', 'menu']]);
    }
    if ((m = v.match(/^ar_tog:(\d+)$/))) { let a = await db.areas.get(+m[1]); a = await db.areas.set(a.id, { active: !a.active }); return c.reply(`${a.name} is now ${a.active ? '🟢 active' : '⏸ paused (hidden from customers)'}.`, [['🗺 All areas', 'areas']]); }
    if ((m = v.match(/^ar_loc:(\d+)$/))) { S.state = 'ar_setloc'; S.data.aid = +m[1]; return c.reply('📍 Send the centre location: tap 📎 → *Location*.'); }
    if (S.state === 'ar_setloc' && c.loc) { const a = await db.areas.set(S.data.aid, { lat: c.loc.lat, lng: c.loc.lng }); S.state = null; delete S.data.aid; return c.reply(`✅ Centre location saved for ${a.name}.`, [['⚙️ ' + a.name, 'ar:' + a.id]]); }
  }

  // --- shops (scoped)
  if (v === 'list') {
    const shops = await scopedShops(c);
    if (!shops.length) return c.reply('No shops yet.', [['➕ Add new shop', 'add']]);
    const lines = [];
    for (const [i, s] of shops.entries()) lines.push(`${i + 1}. ` + shopLine(s, await itemCount(s.id)));
    return c.reply('🏪 *Shops*\n\n' + lines.join('\n\n'), shops.map((s) => ['⚙️ ' + s.name, 'shop:' + s.id]).concat([['Menu', 'menu']]));
  }
  if ((m = v.match(/^(shop|paid|tog|dtog|plink):(\d+)$/))) {
    let s = await db.shops.get(+m[2]);
    if (!inScope(c, s)) return c.reply('Shop not found in your area.', [['Menu', 'menu']]);
    if (m[1] === 'shop') {
      const b = [];
      if (!s.paid) b.push(c.isSuper ? [`✅ Mark ${rs(cfg.SETUP_FEE)} received`, 'paid:' + s.id] : ['📩 Send payment link', 'plink:' + s.id]);
      else b.push([s.active ? '⏸ Pause shop' : '▶️ Resume shop', 'tog:' + s.id]);
      b.push([s.delivery ? '🛵 Turn delivery OFF' : '🛵 Turn delivery ON', 'dtog:' + s.id], ['🏪 All shops', 'list'], ['Menu', 'menu']);
      const ms = await db.shops.monthSales(s.id);
      const a = s.area_id ? await db.areas.get(s.area_id) : null;
      return c.reply(shopLine(s, await itemCount(s.id)) + `\n\n🗺 Area: ${a ? a.name : '—'}\n📍 Location: ${s.lat != null ? 'set' : 'not set'}\n📱 Owner: +${s.owner_phone}\n💳 UPI: ${s.upi || 'not set'}\n💰 ${MONTH()} sales: ${rs(ms)}\n🧾 ${cfg.COMM * 100}% fee: ${rs(ms * cfg.COMM)}\n🛵 Delivery charge: ${rs(s.del_fee)} · Min order ${rs(s.min_order)}`, b);
    }
    if (m[1] === 'paid') {
      // Cash or direct UPI: only the main admin may confirm. Zone admins send the payment link instead.
      if (!c.isSuper) return c.reply(`Setup fees are paid only by link or to the company UPI, not in cash. Tap *Send payment link* and the owner pays ${rs(cfg.SETUP_FEE)} directly.`, [['📩 Send payment link', 'plink:' + s.id], ['Menu', 'menu']]);
      if (!(await activate(s))) return c.reply('✅ Setup fee was already received.', [['Menu', 'menu']]); return;
    }
    if (m[1] === 'plink') {
      if (s.paid) return c.reply('✅ Setup fee was already received.', [['Menu', 'menu']]);
      const p = await pay.createLink({ kind: 'setup', ref: s.id, amount: cfg.SETUP_FEE, description: `${cfg.BRAND} setup fee – ${s.name}`, phone: s.owner_phone, name: s.name });
      await notify(s.owner_phone, `*Setup fee: ${rs(cfg.SETUP_FEE)}* (one-time)\n\n${pay.payText(p)}\n\nYour shop goes live as soon as payment is confirmed.`);
      return c.reply(`📩 Payment link sent to ${s.name} (+${s.owner_phone}). The shop goes live by itself once they pay.`, [['⚙️ ' + s.name, 'shop:' + s.id], ['Menu', 'menu']]);
    }
    if (m[1] === 'tog') {
      s = await db.shops.set(s.id, { active: !s.active });
      await notify(s.owner_phone, s.active ? `▶️ Your shop is live again on ${cfg.BRAND}.` : '⏸ Your shop has been paused by the admin. Contact admin to resume.');
      return c.reply(`${s.name} is now ${s.active ? '🟢 live' : '⏸ paused'}.`, [['🏪 Manage shops', 'list']]);
    }
    s = await db.shops.set(s.id, { delivery: !s.delivery });
    await notify(s.owner_phone, `🛵 Home delivery is now *${s.delivery ? 'ON' : 'OFF'}* for your shop.`);
    return c.reply(`🛵 Delivery for ${s.name}: *${s.delivery ? 'ON' : 'OFF'}*`, [['⚙️ ' + s.name, 'shop:' + s.id], ['Menu', 'menu']]);
  }
  if (v === 'sales') {
    const shops = await scopedShops(c);
    let gmv = 0; const lines = [];
    for (const s of shops) { const ms = await db.shops.monthSales(s.id); gmv += ms; lines.push(`*${s.name}*\n   Sales ${rs(ms)} → ${cfg.COMM * 100}% = ${rs(ms * cfg.COMM)} · Setup ${s.paid ? '✅' : '⏳'}`); }
    const del = (await db.one(`select coalesce(sum(o.del_fee),0) s from orders o join shops s on s.id=o.shop_id where o.status='Completed' and o.mode='delivery' and ($1::int[] is null or s.area_id = any($1))
      and o.created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`, [c.isSuper ? null : c.areaIds])).s;
    let split = '';
    const areaList = c.isSuper ? await db.areas.all() : c.myAreas;
    let received = 0, payable = 0;
    for (const a of areaList) { const x = await areaMoney(a); if (!x.shops) continue; received += x.received; payable += x.admin + x.supervisor; split += `\n🗺 ${a.name}: received ${rs(x.received)} · admin ${rs(x.admin)} · supervisor ${rs(x.supervisor)}`; }
    const comm = gmv * cfg.COMM, setup = shops.filter((s) => s.paid).length * cfg.SETUP_FEE;
    const got = c.isSuper ? (await db.one(`select coalesce(sum(amount),0) s from payments where status='paid' and to_char(paid_at at time zone 'Asia/Kolkata','YYYY-MM')=$1`, [network.monthKey()])).s : received;
    if (c.isSuper) {
      return c.reply(`📊 *${MONTH()} summary — all areas*\n\n${lines.join('\n') || 'No shops yet.'}\n\nTotal shop sales: ${rs(gmv)}\n💰 ${cfg.COMM * 100}% commission: ${rs(comm)}\n💳 Setup fees (all time): ${rs(setup)}\n🛵 Delivery charges: ${rs(del)}\n\n💳 Payments received this month: *${rs(got)}*${split ? `\n\n*Zone shares (money received)*${split}\nPayable to admins & supervisors: *${rs(payable)}*` : ''}\n\n👑 *Your net this month: ${rs(got - payable)}*`,
        [['📩 Send last month\'s bills', 'bills'], ['🗺 Areas & admins', 'areas'], ['Menu', 'menu']]);
    }
    return c.reply(`📊 *${MONTH()} — ${c.myAreas.map((a) => a.name).join(', ')}*\n\n${lines.join('\n') || 'No shops yet.'}\n\nShop sales: ${rs(gmv)}\n🛵 Delivery charges: ${rs(del)}\n\n${await earningsText(c)}`, [['Menu', 'menu']]);
  }
  if (v === 'bills' && c.isSuper) {
    const sent = await sendBills();
    return c.reply(`📩 ${MONTH_NAME(PREV_MONTH_KEY())} bills sent to ${sent} shop(s) on WhatsApp.`, [['Menu', 'menu']]);
  }
  if (v === 'deliv') {
    const ds = (await db.orders.activeDeliveries()).filter((o) => c.isSuper || c.areaIds.includes(o.area_id));
    if (!ds.length) return c.reply('🛵 No active delivery orders right now.', [['Menu', 'menu']]);
    const b = [];
    for (const o of ds) { if (o.status === 'Ready') b.push([`🛵 Dispatch #${o.id}`, 'disp:' + o.id]); if (o.status === 'Out for delivery') b.push([`✅ Delivered #${o.id}`, 'dlv:' + o.id]); }
    b.push(['Menu', 'menu']);
    return c.reply('🛵 *Delivery desk*\n\n' + ds.map((o) => `#${o.id} · ${o.shop_name} (${o.shop_area}) → ${o.addr}\n   📱 +${o.cust_phone} · ${rs(o.total)} ${o.paid ? '(prepaid)' : '(collect cash)'} · *${o.status}*`).join('\n\n'), b);
  }
  if ((m = v.match(/^disp:(\d+)$/))) {
    const o = await db.orders.get(+m[1]); if (!o || !inScope(c, await db.shops.get(o.shop_id))) return c.reply('Order not found.');
    if (o.status !== 'Ready') return c.reply(`Order #${o.id} is ${o.status}.`, [['🛵 Delivery desk', 'deliv']]);
    await setStatus(o, 'Out for delivery');
    return c.reply(`🛵 Rider dispatched for #${o.id}.`, [[`✅ Delivered #${o.id}`, 'dlv:' + o.id], ['🛵 Delivery desk', 'deliv']]);
  }
  if ((m = v.match(/^dlv:(\d+)$/))) {
    const o = await db.orders.get(+m[1]); if (!o || !inScope(c, await db.shops.get(o.shop_id))) return c.reply('Order not found.');
    if (o.status !== 'Out for delivery') return c.reply(`Order #${o.id} is ${o.status}.`, [['🛵 Delivery desk', 'deliv']]);
    await setStatus(o, 'Completed');
    return c.reply(`✅ #${o.id} delivered.${o.del_fee ? ' Delivery charge ' + rs(o.del_fee) + ' earned.' : ''}`, [['🛵 Delivery desk', 'deliv'], ['Menu', 'menu']]);
  }
  return c.reply("Sorry, I didn't get that. Type *menu* to see options.\n_Tip: send *#customer* to test the bot as a customer, *#admin* to come back._", [['Menu', 'menu']]);
}

/* ============================================================ SHOP OWNER */
async function ownerMenu(c, s) {
  c.sess.state = null;
  const b = [['➕ Add items', 'additem'], ['📦 Stock & prices', 'stock'], ['🧾 Orders', 'orders'], ['💰 Sales & invoices', 'sales'], ['⚙️ Settings', 'settings']];
  if (!s.paid) b.unshift(['💳 Pay setup fee', 'paysetup']);
  if (c.ownShops.length > 1) b.push(['🔁 Switch shop', 'switch']);
  b.push(['🌐 Language', 'lang']);
  return c.reply(`🏪 *${s.name}* — shop panel\n${!s.paid ? '⏳ Not live yet — setup fee pending' : s.active ? '🟢 Live for customers' : '⏸ Paused by admin'}\n\nQuick commands:\n_Name | Category | Price | Stock_ → add item\n_price Sugar 1kg 50_ → change price\n_stock Sugar 1kg 40_ → set stock`, b);
}

async function addItems(c, s, v) {
  const rows = catalog.parseLines(v);
  const r = await catalog.importItems(s, rows);
  const items = await db.items.byShop(s.id), by = new Map(items.map((i) => [i.name, i]));
  const ok = r.added.map((n) => `➕ ${n} — ${rs(by.get(n).price)} · ${by.get(n).stock} in stock`).concat(r.updated.map((n) => `✏️ ${n} — ${rs(by.get(n).price)} · ${by.get(n).stock} in stock (updated)`));
  c.sess.state = null;
  return c.reply((ok.length ? `✅ *${ok.length} item(s) saved*\n` + ok.join('\n') : '') +
    (r.errors.length ? `\n\n⚠️ Not saved:\n${r.errors.join('\n')}\nFormat: _Name | Category | Price | Stock_${r.allowed.length ? `\n\n*Categories for your shop:*\n${r.allowed.join(', ')}` : ''}` : ''),
    [['➕ Add more', 'additem'], ['📦 Stock & prices', 'stock'], ['Menu', 'menu']]);
}

async function stockMsg(c, s, onlyLow) {
  let its = await db.items.byShop(s.id);
  if (onlyLow) its = its.filter((i) => i.stock < 5);
  if (!its.length) return c.reply(onlyLow ? '✅ No low-stock items.' : 'No items yet. Tap *Add items* to build your catalogue.', [['➕ Add items', 'additem'], ['Menu', 'menu']]);
  const cats = [...new Set(its.map((i) => i.cat))];
  return c.reply((onlyLow ? '⚠️ *Low stock*\n\n' : '📦 *Stock & prices*\n\n') + cats.map((ct) => `*${ct}*\n` + its.filter((i) => i.cat === ct).map((i) => `• ${i.name} — ${rs(i.price)} · ${i.stock === 0 ? '❌ out of stock' : i.stock < 5 ? '⚠️ ' + i.stock + ' left' : i.stock + ' in stock'}`).join('\n')).join('\n\n') +
    '\n\nUpdate: _price Sugar 1kg 50_ · _stock Sugar 1kg 40_ · _remove Sugar 1kg_', [['⚠️ Low stock', 'low'], ['➕ Add items', 'additem'], ['Menu', 'menu']]);
}

async function ordersMsg(c, s) {
  const os = await db.orders.openByShop(s.id);
  if (!os.length) return c.reply('🧾 No open orders right now.', [['💰 Sales & invoices', 'sales'], ['Menu', 'menu']]);
  const b = [];
  for (const o of os) {
    if (o.status === 'New') b.push([`✅ Accept #${o.id}`, 'acc:' + o.id], [`❌ Reject #${o.id}`, 'rej:' + o.id]);
    if (o.status === 'Accepted') b.push([`📦 Mark ready #${o.id}`, 'rdy:' + o.id]);
    if (o.status === 'Ready' && o.mode === 'pickup') b.push([`🤝 Picked up #${o.id}`, 'done:' + o.id]);
  }
  b.push(['Menu', 'menu']);
  return c.reply('🧾 *Open orders*\n\n' + os.map((o) => `#${o.id} · ${o.cust_name || ''} +${o.cust_phone} · ${rs(o.total)}\n   ${o.mode === 'delivery' ? '🛵 Delivery' : '🏃 Pickup'} · ${o.pay === 'UPI' ? (o.paid ? 'Paid UPI' : 'UPI – verify') : 'Cash'} · *${o.status}*${o.status === 'Ready' && o.mode === 'delivery' ? ' (waiting for rider)' : ''}\n   ` + o.lines.map((l) => `${l.q}×${l.name}`).join(', ')).join('\n\n'), b);
}

async function ownerOrder(c, s, act, n) {
  const o = await db.orders.get(n);
  if (!o || o.shop_id !== s.id) return c.reply('Order not found.');
  const need = { acc: 'New', rej: 'New', rdy: 'Accepted', done: 'Ready' }[act];
  if (o.status !== need || (act === 'done' && o.mode !== 'pickup')) return c.reply(`Order #${n} is *${o.status}*.`, [['🧾 Orders', 'orders']]);
  const to = { acc: 'Accepted', rej: 'Cancelled', rdy: 'Ready', done: 'Completed' }[act];
  await setStatus(o, to);
  const nxt = to === 'Accepted' ? [[`📦 Mark ready #${n}`, 'rdy:' + n]] : to === 'Ready' && o.mode === 'pickup' ? [[`🤝 Picked up #${n}`, 'done:' + n]] : [];
  return c.reply(`Order #${n} → *${to}*.${to === 'Ready' && o.mode === 'delivery' ? ` ${cfg.BRAND} rider has been notified.` : ''} Customer updated on WhatsApp.`, nxt.concat([['🧾 Orders', 'orders'], ['Menu', 'menu']]));
}

async function owner(c, v, btn) {
  const S = c.sess, low = v.trim().toLowerCase();
  let s = c.ownShops.find((x) => x.id === S.data.shopId) || c.ownShops[0];
  S.data.shopId = s.id;
  let m;
  if (MENU_WORDS.includes(low)) return ownerMenu(c, s);
  if (v === 'switch') return c.reply('Which shop?', c.ownShops.map((x) => ['🏪 ' + x.name, 'use:' + x.id]));
  if ((m = v.match(/^use:(\d+)$/))) { const x = c.ownShops.find((y) => y.id === +m[1]); if (x) { S.data.shopId = x.id; return ownerMenu(c, x); } }
  if (v === 'paysetup') {
    if (s.paid) return c.reply('✅ Setup fee already received. Your shop is live.', [['Menu', 'menu']]);
    const p = await pay.createLink({ kind: 'setup', ref: s.id, amount: cfg.SETUP_FEE, description: `${cfg.BRAND} setup fee – ${s.name}`, phone: s.owner_phone, name: s.name });
    return c.reply(`*Setup fee: ${rs(cfg.SETUP_FEE)}* (one-time)\n\n${pay.payText(p)}\n\nYour shop goes live as soon as payment is confirmed.`, [['Menu', 'menu']]);
  }
  if (v === 'additem') {
    S.state = 'additem';
    const cats = (await catalog.categories(s.type_id)).map((x) => x.name);
    return c.reply(`➕ Send items in this format — one per line, or separate with *;*\n\n_Name | Category | Price | Stock_\n\nExample:\nToor Dal 1kg | ${cats[2] || 'Pulses'} | 165 | 30; Sugar 1kg | ${cats[5] || 'Essentials'} | 48 | 50${cats.length ? `\n\n*Categories for your shop:*\n${cats.join(', ')}` : ''}${cfg.PUBLIC_URL ? `\n\n📊 Many items? Ask your admin to upload your Excel sheet.` : ''}`);
  }
  if (!btn && v.includes('|')) return addItems(c, s, v);
  if (!btn && (m = v.match(/^\s*price\s+(.+?)\s+(\d+(?:\.\d+)?)\s*$/i))) {
    const i = await db.items.find(s.id, m[1]); if (!i) return c.reply(`Item "${m[1]}" not found.`, [['📦 Stock & prices', 'stock']]);
    await db.q('update items set price=$2 where id=$1', [i.id, +m[2]]);
    return c.reply(`✅ *${i.name}* price ${rs(i.price)} → *${rs(+m[2])}*`, [['📦 Stock & prices', 'stock'], ['Menu', 'menu']]);
  }
  if (!btn && (m = v.match(/^\s*stock\s+(.+?)\s+(\d+)\s*$/i))) {
    const i = await db.items.find(s.id, m[1]); if (!i) return c.reply(`Item "${m[1]}" not found.`, [['📦 Stock & prices', 'stock']]);
    await db.q('update items set stock=$2 where id=$1', [i.id, +m[2]]);
    return c.reply(`✅ *${i.name}* stock set to *${+m[2]}*`, [['📦 Stock & prices', 'stock'], ['Menu', 'menu']]);
  }
  if (!btn && (m = v.match(/^\s*(?:remove|delete)\s+(.+?)\s*$/i))) {
    const i = await db.items.find(s.id, m[1]); if (!i) return c.reply(`Item "${m[1]}" not found.`, [['📦 Stock & prices', 'stock']]);
    await db.q('delete from items where id=$1', [i.id]);
    return c.reply(`🗑 *${i.name}* removed.`, [['📦 Stock & prices', 'stock'], ['Menu', 'menu']]);
  }
  if (!btn && (m = v.match(/^\s*delfee\s+(\d+)\s*$/i))) { await db.shops.set(s.id, { del_fee: +m[1] }); return c.reply(`✅ Delivery charge set to ${rs(+m[1])}`, [['⚙️ Settings', 'settings'], ['Menu', 'menu']]); }
  if (!btn && (m = v.match(/^\s*minorder\s+(\d+)\s*$/i))) { await db.shops.set(s.id, { min_order: +m[1] }); return c.reply(`✅ Minimum order for delivery set to ${rs(+m[1])}`, [['⚙️ Settings', 'settings'], ['Menu', 'menu']]); }
  if (!btn && (m = v.match(/^\s*upi\s+([\w.\-]+@[\w.\-]+)\s*$/i))) { await db.shops.set(s.id, { upi: m[1] }); return c.reply(`✅ UPI ID saved: *${m[1]}*\nCustomers choosing "Pay now (UPI)" will pay to this ID.`, [['⚙️ Settings', 'settings'], ['Menu', 'menu']]); }
  if (v === 'setloc') { S.state = 'shoploc'; return c.reply('📍 Stand at your shop and send its location: tap 📎 → *Location* → *Send your current location*.\nNearby customers will then see your shop.'); }
  if (c.loc) {
    const patch = { lat: c.loc.lat, lng: c.loc.lng };
    // A shop without a zone joins the nearest active zone that covers it
    if (!s.area_id) {
      let best = null, bd = Infinity;
      for (const a of await db.areas.active()) if (a.lat != null) { const d = km(c.loc, a); if (d <= Number(a.radius_km) && d < bd) { bd = d; best = a; } }
      if (best) { patch.area_id = best.id; if (best.admin_phone) await notify(best.admin_phone, `📍 *${s.name}* set its location and joined your zone *${best.name}*.`); }
    }
    await db.shops.set(s.id, patch); S.state = null;
    return c.reply(`✅ Shop location saved. Customers within the area radius will now see *${s.name}* when they share their location.`, [['⚙️ Settings', 'settings'], ['Menu', 'menu']]);
  }
  if (v === 'stock') return stockMsg(c, s, false);
  if (v === 'low') return stockMsg(c, s, true);
  if (v === 'orders') return ordersMsg(c, s);
  if ((m = v.match(/^(acc|rej|rdy|done):(\d+)$/))) return ownerOrder(c, s, m[1], +m[2]);
  if (v === 'sales') {
    const t = await db.shops.todaySales(s.id), ms = await db.shops.monthSales(s.id), rec = await db.orders.recentByShop(s.id);
    return c.reply(`💰 *${s.name} — sales*\n\nToday: ${t.n} orders · ${rs(t.s)}\n${MONTH()} total: *${rs(ms)}*\n${cfg.BRAND} fee (${cfg.COMM * 100}%): ${rs(ms * cfg.COMM)}\n\n${rec.length ? 'Recent invoices 👇' : 'No invoices yet.'}`,
      rec.map((o) => ['📄 ' + o.inv, 'inv:' + o.id]).concat([['Menu', 'menu']]));
  }
  if ((m = v.match(/^inv:(\d+)$/))) { const o = await db.orders.get(+m[1]); if (o && o.shop_id === s.id) return sendInvoice(c.from, o, s); return c.reply('Invoice not found.'); }
  if (v === 'settings') return c.reply(`⚙️ *Settings*\n\n🛵 Home delivery by ${cfg.BRAND}: *${s.delivery ? 'ON' : 'OFF'}*\nDelivery charge: ${rs(s.del_fee)}\nMin order for delivery: ${rs(s.min_order)}\n💳 UPI ID: ${s.upi || 'not set'}\n📍 Shop location: ${s.lat != null ? 'set ✅' : 'not set — customers nearby can\'t find you'}\n\nChange: _delfee 30_ · _minorder 200_ · _upi name@okaxis_`,
    [[s.delivery ? '🛵 Delivery OFF' : '🛵 Opt in delivery', 'dtog'], ['📍 Set shop location', 'setloc'], ['Menu', 'menu']]);
  if (v === 'dtog') {
    s = await db.shops.set(s.id, { delivery: !s.delivery });
    await notifyShopAdmins(s, `🛵 *${s.name}* turned home delivery *${s.delivery ? 'ON' : 'OFF'}*.`);
    return c.reply(`🛵 Home delivery by ${cfg.BRAND} is now *${s.delivery ? 'ON' : 'OFF'}*.`, [['⚙️ Settings', 'settings'], ['Menu', 'menu']]);
  }
  return c.reply("Sorry, I didn't get that. Type *menu* for options.\n_Tip: send *#customer* to shop as a customer, *#shop* to come back._", [['Menu', 'menu']]);
}

/* ============================================================== CUSTOMER */
// Shops near a point: shop location if set, else its area's centre; within the area radius (default radius if no area)
async function nearbyShops(loc) {
  const live = await db.shops.live();
  const areas = Object.fromEntries((await db.areas.all()).map((a) => [a.id, a]));
  const out = [];
  for (const s of live) {
    const a = s.area_id ? areas[s.area_id] : null;
    if (a && !a.active) continue;
    const p = s.lat != null ? { lat: s.lat, lng: s.lng } : a && a.lat != null ? { lat: a.lat, lng: a.lng } : null;
    if (!p) continue;
    const d = km(loc, p), r = a ? Number(a.radius_km) : cfg.DEFAULT_RADIUS_KM;
    if (d <= r) out.push({ s, d });
  }
  return out.sort((x, y) => x.d - y.d);
}
const shopBtn = (s, d) => [`🏪 ${s.name}${d != null ? ' · ' + fmtKm(d) : ' · ' + s.area}${s.delivery ? ' · 🛵' : ''}`, 'shop:' + s.id];
async function showNearby(c, typeId) {
  let near = await nearbyShops(c.sess.data.loc);
  const tids = [...new Set(near.map(({ s }) => s.type_id || 0))];
  if (typeId == null && near.length > 3 && tids.length > 1) {
    const ts = Object.fromEntries((await catalog.types(true)).map((t) => [t.id, t.name]));
    return c.reply(`📍 *${near.length} shops near you*\nWhat are you shopping for?${await webLine(c.from)}`,
      tids.map((t) => [`🏷 ${ts[t] || 'Other shops'} (${near.filter(({ s }) => (s.type_id || 0) === t).length})`, 'ty:' + t]).concat([['🏪 All shops', 'ty:all'], ['📍 Change location', 'newloc']]));
  }
  if (typeId != null && typeId !== 'all') near = near.filter(({ s }) => (s.type_id || 0) === typeId);
  if (!near.length) return c.reply('😔 No shops deliver to your location yet.\nYou can pick an area instead, or share a different location.', [['🗺 Choose area', 'areas_c'], ['📦 My orders', 'my']]);
  return c.reply(`📍 *Shops near you* (${near.length})\nTap a shop to start ordering:${await webLine(c.from)}`, near.map(({ s, d }) => shopBtn(s, d)).concat([['📍 Change location', 'newloc'], ['📦 My orders', 'my']]));
}
async function custWelcome(c) {
  c.sess.state = null; c.sess.data.cart = {}; delete c.sess.data.shop;
  const live = await db.shops.live();
  if (!live.length) return c.reply(`🙏 Welcome to *${cfg.BRAND}*!\nNo shops are live yet. Please check back soon.`);
  const areas = await db.areas.active();
  if (!areas.length) {
    return c.reply(`🙏 Welcome to *${cfg.BRAND}*!\nOrder from shops near you on WhatsApp — pickup or home delivery.\n\nChoose a shop:${await webLine(c.from)}`,
      live.map((s) => shopBtn(s)).concat([['📦 My orders', 'my'], ['🌐 Language', 'lang']]));
  }
  if (c.sess.data.loc) {
    const near = await nearbyShops(c.sess.data.loc);
    if (near.length) return c.reply(`🙏 Welcome back to *${cfg.BRAND}*!\n📍 Shops near you:${await webLine(c.from)}`, near.map(({ s, d }) => shopBtn(s, d)).concat([['📍 Change location', 'newloc'], ['📦 My orders', 'my'], ['🌐 Language', 'lang']]));
  }
  return c.reply(`🙏 Welcome to *${cfg.BRAND}*!\nOrder from shops near you on WhatsApp — pickup or home delivery.\n\n📍 *Share your location* to see nearby shops:\ntap 📎 → *Location* → *Send your current location*.`,
    [['🗺 Choose area instead', 'areas_c'], ['📦 My orders', 'my'], ['🌐 Language', 'lang']]);
}
const cartCount = (c) => Object.values(c.sess.data.cart || {}).reduce((a, q) => a + q, 0);
async function cartLines(c) {
  const out = [];
  for (const [id, q] of Object.entries(c.sess.data.cart || {})) { const i = await db.items.get(+id); if (i) out.push({ i, q }); }
  return out;
}
const cartTotal = (lines) => lines.reduce((a, { i, q }) => a + q * i.price, 0);
const itemList = (its) => its.map((i) => `• ${i.name} — *${rs(i.price)}*${i.stock === 0 ? ' ❌ out of stock' : i.stock < 5 ? ' (only ' + i.stock + ' left)' : ''}`).join('\n');
const itemBtns = (its) => its.filter((i) => i.stock > 0).map((i) => [`➕ ${i.name} ${rs(i.price)}`, 'add:' + i.id]);

async function showCats(c, s) {
  const its = await db.items.byShop(s.id);
  const cats = await catalog.sortCats(s, [...new Set(its.map((i) => i.cat))]);
  if (!cats.length) return c.reply(`*${s.name}* hasn't added items yet.`, [['🏠 Other shops', 'menu']]);
  return c.reply(`🏪 *${s.name}* · ${s.area}\n${s.delivery ? `🛵 Home delivery ${rs(s.del_fee)}${s.min_order ? ` (min ${rs(s.min_order)})` : ''} · 🏃 Pickup` : '🏃 Store pickup only'}\n\nTap a category or *type an item name* to search.${await webLine(c.from, s.id)}`,
    cats.map((ct) => [`${ct} (${its.filter((i) => i.cat === ct).length})`, 'cat:' + ct]).concat([[`🛒 Cart (${cartCount(c)})`, 'cart']]));
}
async function showCart(c, s) {
  const lines = await cartLines(c);
  if (!lines.length) return c.reply('🛒 Your cart is empty.', [['⬅ Categories', 'cats']]);
  return c.reply(`🛒 *Cart — ${s.name}*\n\n` + lines.map(({ i, q }) => `${q} × ${i.name} = ${rs(q * i.price)}`).join('\n') + `\n\nSubtotal: *${rs(cartTotal(lines))}*`,
    [['✅ Checkout', 'checkout']].concat(lines.slice(0, 6).map(({ i }) => ['➖ Remove 1 ' + i.name, 'rm:' + i.id]), [['➕ Add more', 'cats'], ['🗑 Clear cart', 'clear']]));
}
async function askPay(c, s) {
  const D = c.sess.data, sub = cartTotal(await cartLines(c)), del = D.mode === 'delivery' ? s.del_fee : 0;
  const b = [];
  if (s.upi) b.push(['💳 Pay now (UPI)', 'pay:UPI']);
  b.push([D.mode === 'delivery' ? '💵 Cash on delivery' : '💵 Pay at shop', 'pay:Cash']);
  return c.reply(`🧾 *Order summary*\nItems: ${rs(sub)}${del ? `\nDelivery: ${rs(del)}` : ''}\n*Total: ${rs(sub + del)}*\n${D.mode === 'delivery' ? '🛵 Deliver to: ' + D.addr : '🏃 Pickup at ' + s.name + ', ' + s.area}\n\nHow would you like to pay?`, b);
}
// Creates the order and reduces stock in one transaction. Used by WhatsApp and the website.
// Returns { o, lines } or { err } (err is a message for the customer).
async function createOrder({ s, phone, name, cart, mode, addr, payMode }) {
  const client = await db.pool.connect();
  let o; const lines = [];
  try {
    await client.query('begin');
    for (const [id, q] of Object.entries(cart || {})) {
      if (!(q > 0)) continue;
      const i = (await client.query('select * from items where id=$1 and shop_id=$2 for update', [+id, s.id])).rows[0];
      if (!i) continue;
      if (i.stock < q) { await client.query('rollback'); return { err: `Sorry, *${i.name}* now has only ${i.stock} left. Please update your cart.` }; }
      await client.query('update items set stock=stock-$2 where id=$1', [i.id, q]);
      lines.push({ id: i.id, name: i.name, price: i.price, q, left: i.stock - q });
    }
    if (!lines.length) { await client.query('rollback'); return { err: 'Your cart is empty.' }; }
    const sub = lines.reduce((a, l) => a + l.q * l.price, 0), del = mode === 'delivery' ? s.del_fee : 0;
    const seq = (await client.query('update shops set inv_seq=inv_seq+1 where id=$1 returning inv_seq', [s.id])).rows[0].inv_seq;
    o = (await client.query(`insert into orders(shop_id,cust_phone,cust_name,lines,subtotal,del_fee,total,mode,addr,pay,inv,token)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [s.id, phone, name, JSON.stringify(lines.map(({ left, ...l }) => l)), sub, del, sub + del, mode, mode === 'delivery' ? addr : '', payMode,
      `INV-${s.code}-${String(seq).padStart(4, '0')}`, crypto.randomBytes(12).toString('hex')])).rows[0];
    await client.query('commit');
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  return { o, lines };
}
async function placeOrder(c, s, payMode) {
  const D = c.sess.data;
  const r = await createOrder({ s, phone: c.from, name: c.name, cart: D.cart, mode: D.mode, addr: D.addr, payMode });
  if (r.err) return c.reply(r.err, r.err.includes('empty') ? [['⬅ Categories', 'cats']] : [['🛒 Cart', 'cart']]);
  D.cart = {}; c.sess.state = null;
  return orderPlaced(r.o, s, r.lines, payMode, (t, b) => c.reply(t, b));
}
// Messages after an order: customer confirmation + invoice, shop owner, low stock, delivery desk
async function orderPlaced(o, s, lines, payMode, toCust) {
  toCust = toCust || ((t, b) => notify(o.cust_phone, t, b));
  const n = o.id;
  await toCust(`🎉 *Order #${n} placed* with ${s.name}!${payMode === 'UPI' ? `\n\n💳 Please pay *${rs(o.total)}* to UPI ID:\n*${s.upi}*\n(write "Order ${n}" in the note). The shop confirms once they see it.` : ''}\nYou'll get updates right here.`);
  try { await sendInvoice(o.cust_phone, o, s, [['📦 My orders', 'my'], ['🏠 Shops', 'menu']]); } catch (e) { console.error('invoice send', e.message); }
  await notify(s.owner_phone, `🔔 *New order #${n}*\n${o.cust_name || ''} · +${o.cust_phone}\n\n` + lines.map((l) => `${l.q} × ${l.name} = ${rs(l.q * l.price)}`).join('\n') +
    `\n\nTotal: *${rs(o.total)}* · ${payMode === 'UPI' ? 'UPI to you – check your UPI app before accepting' : 'Cash'}\n${o.mode === 'delivery' ? `🛵 Home delivery (${cfg.BRAND} rider)\n📍 ${o.addr}` : '🏃 Customer will pick up'}`,
  [[`✅ Accept #${n}`, 'acc:' + n], [`❌ Reject #${n}`, 'rej:' + n]]);
  const low = lines.filter((l) => l.left < 5);
  if (low.length) await notify(s.owner_phone, '⚠️ *Low stock alert*\n' + low.map((l) => `• ${l.name}: ${l.left} left`).join('\n') + '\nReply _stock Item qty_ to update.');
  if (o.mode === 'delivery') await notifyDelivery(s, `🛵 *New delivery order #${n}*\n${s.name} → ${o.addr}\n${rs(o.total)} ${payMode === 'UPI' ? '(UPI)' : '(collect cash)'} · waiting for shop to pack.`, [['🛵 Delivery desk', 'deliv']]);
  return o;
}

// Personal website link for a customer (opens shops near their saved location, or one shop)
async function webLink(phone, shopId) {
  if (!cfg.PUBLIC_URL) return '';
  let row = await db.one('select token from cust_links where phone=$1', [phone]);
  if (!row) row = await db.one(`insert into cust_links(phone,token) values($1,$2) on conflict(phone) do update set updated_at=now() returning token`, [phone, crypto.randomBytes(6).toString('base64url')]);
  return `${cfg.PUBLIC_URL}/u/${row.token}${shopId ? '?shop=' + shopId : ''}`;
}
const webLine = async (phone, shopId) => { const l = await webLink(phone, shopId); return l ? `\n\n🌐 Shop on the website (photos, full list, easy cart):\n${l}` : ''; };

async function customer(c, v, btn) {
  const S = c.sess, D = S.data;
  D.cart = D.cart || {};
  let low = v.trim().toLowerCase(), m;
  if (MENU_WORDS.includes(low) || low === 'shops') return custWelcome(c);
  if ((m = low.match(/^order\s+(w[a-z0-9]{5,8})\b/))) {
    const w = await db.one('select * from web_orders where code=$1', [m[1].toUpperCase()]);
    if (!w) return c.reply('That website order code has expired. Please open the shop link again.', [['🏠 Shops', 'menu']]);
    const s = await db.shops.get(w.shop_id);
    if (!s || !s.active || !s.paid) return c.reply('Sorry, this shop is not taking orders right now.', [['🏠 Shops', 'menu']]);
    const r = await createOrder({ s, phone: c.from, name: c.name, cart: w.cart, mode: w.mode, addr: w.addr, payMode: w.pay });
    if (r.err) return c.reply(r.err + `\nOpen the shop again: ${cfg.PUBLIC_URL}/s/${s.id}`);
    await db.q('delete from web_orders where code=$1', [w.code]);
    return orderPlaced(r.o, s, r.lines, w.pay, (t, b) => c.reply(t, b));
  }
  if (!btn) { if (low === 'cart') v = 'cart'; if (low === 'checkout') v = 'checkout'; if (low === 'orders' || low === 'my orders') v = 'my'; }
  if (S.state === 'addr' && (c.loc || !btn)) {
    if (c.loc) D.addr = `${c.loc.label ? c.loc.label + ' · ' : ''}📍 https://maps.google.com/?q=${c.loc.lat},${c.loc.lng}`;
    else { if (v.trim().length < 8) return c.reply('Please send the full address (house no, street, landmark).'); D.addr = v.trim(); }
    S.state = null; return askPay(c, await db.shops.get(D.shop));
  }
  if (c.loc) {
    D.loc = { lat: c.loc.lat, lng: c.loc.lng }; D.cart = {}; delete D.shop;
    await webLink(c.from); await db.q('update cust_links set lat=$2, lng=$3, updated_at=now() where phone=$1', [c.from, c.loc.lat, c.loc.lng]);
    return showNearby(c);
  }
  if ((m = v.match(/^ty:(\d+|all)$/)) && D.loc) return showNearby(c, m[1] === 'all' ? 'all' : +m[1]);
  if (v === 'newloc') return c.reply('📍 Send your location: tap 📎 → *Location* → *Send your current location*.', [['🗺 Choose area instead', 'areas_c']]);
  if (v === 'areas_c') {
    const as = await db.areas.active();
    if (!as.length) return custWelcome(c);
    return c.reply('🗺 Choose your area:', as.map((a) => ['🗺 ' + a.name, 'ac:' + a.id]));
  }
  if ((m = v.match(/^ac:(\d+)$/))) {
    const a = await db.areas.get(+m[1]);
    const shops = (await db.shops.live()).filter((s) => s.area_id === +m[1]);
    if (!a || !shops.length) return c.reply('No shops live in this area yet.', [['🗺 Other areas', 'areas_c']]);
    return c.reply(`🗺 *${a.name}* — choose a shop:`, shops.map((s) => shopBtn(s)).concat([['🗺 Other areas', 'areas_c']]));
  }
  if (v === 'rate') return c.reply('⭐ Thanks for rating! See you again.', [['🏠 Shops', 'menu']]);
  if (v === 'my') {
    const os = await db.orders.byCustomer(c.from);
    if (!os.length) return c.reply('📦 No orders yet.', [['🏠 Shops', 'menu']]);
    const names = {}; for (const o of os) names[o.shop_id] = names[o.shop_id] || (await db.shops.get(o.shop_id)).name;
    return c.reply('📦 *My orders*\n\n' + os.map((o) => `#${o.id} · ${names[o.shop_id]} · ${rs(o.total)}\n   *${o.status}*`).join('\n\n'), os.slice(0, 3).map((o) => [`📄 Invoice #${o.id}`, 'inv:' + o.id]).concat([['🏠 Shops', 'menu']]));
  }
  if ((m = v.match(/^inv:(\d+)$/))) { const o = await db.orders.get(+m[1]); if (o && o.cust_phone === c.from) return sendInvoice(c.from, o, await db.shops.get(o.shop_id)); return c.reply('Invoice not found.'); }
  if ((m = v.match(/^shop:(\d+)$/))) {
    const s = await db.shops.get(+m[1]);
    if (!s || !s.active || !s.paid) return c.reply('Sorry, this shop is not taking orders right now.', [['🏠 Shops', 'menu']]);
    if (D.shop !== s.id) D.cart = {};
    D.shop = s.id; S.state = null; return showCats(c, s);
  }
  const s = D.shop && (await db.shops.get(D.shop));
  if (!s) return custWelcome(c);
  if (v === 'cats') return showCats(c, s);
  if ((m = v.match(/^cat:(.+)$/))) {
    const its = (await db.items.byShop(s.id)).filter((i) => i.cat === m[1]);
    return c.reply(`*${m[1]}*\n${itemList(its)}\n\nTap to add to cart 👇`, itemBtns(its).concat([[`🛒 Cart (${cartCount(c)})`, 'cart'], ['⬅ Categories', 'cats']]));
  }
  if ((m = v.match(/^add:(\d+)$/))) {
    const i = await db.items.get(+m[1]);
    if (!i || i.shop_id !== s.id) return c.reply('Item not found.', [['⬅ Categories', 'cats']]);
    const q = D.cart[i.id] || 0;
    if (q + 1 > i.stock) return c.reply(`Sorry, only ${i.stock} available.`, [['🛒 Cart', 'cart'], ['⬅ Categories', 'cats']]);
    D.cart[i.id] = q + 1;
    return c.reply(`✅ Added *${i.name}* (qty ${q + 1})\n🛒 ${cartCount(c)} items · ${rs(cartTotal(await cartLines(c)))}`, [['➕ One more', 'add:' + i.id], ['🛒 View cart', 'cart'], ['✅ Checkout', 'checkout'], ['⬅ Categories', 'cats']]);
  }
  if ((m = v.match(/^rm:(\d+)$/))) { const id = m[1]; if (D.cart[id] > 1) D.cart[id]--; else delete D.cart[id]; return showCart(c, s); }
  if (v === 'cart') return showCart(c, s);
  if (v === 'clear') { D.cart = {}; return c.reply('🗑 Cart cleared.', [['⬅ Categories', 'cats']]); }
  if (v === 'checkout') {
    const lines = await cartLines(c);
    if (!lines.length) return c.reply('🛒 Your cart is empty.', [['⬅ Categories', 'cats']]);
    const sub = cartTotal(lines);
    const b = [['🏃 Pickup at shop', 'mode:pickup']];
    if (s.delivery) b.push([`🛵 Delivery +${rs(s.del_fee)}`, 'mode:delivery']);
    return c.reply(`Cart total: *${rs(sub)}*\nHow do you want to get your order?` + (s.delivery && s.min_order > sub ? `\n_Home delivery needs min ${rs(s.min_order)}_` : ''), b.concat([['🛒 Edit cart', 'cart']]));
  }
  if ((m = v.match(/^mode:(pickup|delivery)$/))) {
    D.mode = m[1];
    if (m[1] === 'delivery') {
      if (!s.delivery) return c.reply('This shop offers pickup only.', [['🏃 Pickup at shop', 'mode:pickup']]);
      const sub = cartTotal(await cartLines(c));
      if (sub < s.min_order) return c.reply(`Add ${rs(s.min_order - sub)} more for home delivery (min ${rs(s.min_order)}).`, [['➕ Add more', 'cats'], ['🏃 Pickup instead', 'mode:pickup']]);
      S.state = 'addr';
      return c.reply('📍 Send your delivery address\n(house no, street, landmark) — or share your 📎 Location.');
    }
    return askPay(c, s);
  }
  if ((m = v.match(/^pay:(UPI|Cash)$/))) {
    if (m[1] === 'UPI' && !s.upi) return askPay(c, s);
    if (!D.mode) return c.reply('Please choose pickup or delivery first.', [['✅ Checkout', 'checkout']]);
    return placeOrder(c, s, m[1]);
  }
  if (!btn) {
    const its = (await db.items.byShop(s.id)).filter((i) => i.name.toLowerCase().includes(low) || i.cat.toLowerCase().includes(low));
    if (!its.length) return c.reply(`No items match "${v.trim()}" at ${s.name}. Try another word or tap a category.`, [['⬅ Categories', 'cats']]);
    return c.reply(`🔍 Results for "${v.trim()}"\n${itemList(its)}`, itemBtns(its).concat([[`🛒 Cart (${cartCount(c)})`, 'cart']]));
  }
  return custWelcome(c);
}

/* ================================================================ router */
// from: phone (91XXXXXXXXXX), name: WhatsApp profile name, v: text or button id, btn: true if a button/list tap
async function handle(from, name, v, btn) {
  from = cfg.norm(from);
  const sess = await db.sessions.get(from);
  sess.data = sess.data || {};
  const c = { from, name, sess, reply: (t, b) => out(from, t, b || []) };
  try {
    if (btn && /^pg:\d+$/.test(v)) {
      const mrow = await db.one('select * from menus where phone=$1', [from]);
      if (mrow) return await sendPage(from, mrow.text, mrow.items, +v.slice(3));
    }
    // ---- language
    const lw = String(v).trim().toLowerCase();
    let ln = btn && /^lang:(en|ta|hi)$/.test(v) ? v.slice(5) : null;
    if (!btn && !ln) ln = { english: 'en', tamil: 'ta', 'தமிழ்': 'ta', hindi: 'hi', 'हिंदी': 'hi', 'हिन्दी': 'hi' }[lw] || null;
    if (ln) {
      await setLang(from, ln);
      await out(from, '✅ Language set to English.');
      const p = sess.data.pending; delete sess.data.pending;
      await db.sessions.save(from, sess); sess.noSave = true;
      return await handle(from, name, p ? p.v : 'menu', p ? p.btn : false);
    }
    if (v === 'lang' || (!btn && i18n.WORDS.lang.includes(lw))) return await out(from, i18n.PICKER, i18n.PICKER_BTNS);
    if (!(await langOf(from))) {
      const wo = lw.match(/^order\s+(w[a-z0-9]{5,8})\b/);
      const fromWeb = wo && (await db.one('select lang from web_orders where code=$1', [wo[1].toUpperCase()]));
      const guess = i18n.detect(v) || (fromWeb && fromWeb.lang) || (cfg.ADMINS.includes(from) || (await db.areas.byAdmin(from)).length || wo ? 'en' : null);
      if (guess) await setLang(from, guess);
      else { sess.data.pending = { v, btn }; return await out(from, i18n.PICKER, i18n.PICKER_BTNS); }
    }
    // Referral links open the bot with "Hi ref:CODE": remember which zone admin sent this person
    if (!btn) {
      const rf = await network.applyRef(from, v);
      if (rf) {
        if (rf.isNew && rf.area && rf.area.admin_phone && rf.area.admin_phone !== from) await notify(rf.area.admin_phone, `👋 New contact from your referral link (${rf.area.name}): ${name || 'someone'} +${from}`);
        v = rf.rest && !/^(hi|hello|hai|hey)$/i.test(rf.rest) ? rf.rest : 'menu';
      }
    }
    if (!btn && i18n.WORDS.menu.includes(lw)) v = 'menu';
    if (!btn && i18n.WORDS.stop.includes(lw)) v = 'menu';
    const lm = String(v).match(/^loc:(-?[\d.]+),(-?[\d.]+)\|?(.*)$/s);
    if (lm) { c.loc = { lat: +lm[1], lng: +lm[2], label: lm[3] || '' }; v = 'loc'; }
    c.isSuper = cfg.ADMINS.includes(from);
    c.myAreas = await db.areas.byAdmin(from);
    c.areaIds = c.myAreas.map((a) => a.id);
    const isAdmin = c.isSuper || c.myAreas.length > 0;
    c.ownShops = await db.shops.byOwner(from);
    const low = String(v).trim().toLowerCase();
    console.log('IN', from, isAdmin ? '(admin)' : c.ownShops.length ? '(owner)' : '(customer)', JSON.stringify(String(v).slice(0, 60)));
    if (low === '#whoami' || low === '#id') {
      return await out(from, `🔎 Your WhatsApp number as the bot sees it: *+${from}*\nRole: *${c.isSuper ? 'Main admin' : isAdmin ? 'Area admin (' + c.myAreas.map((a) => a.name).join(', ') + ')' : c.ownShops.length ? 'Shop owner' : 'Customer'}*\nMain admin numbers: ${cfg.ADMINS.map((a) => '+' + a).join(', ') || 'none'}`);
    }
    if (low === '#customer') { sess.data.mode = 'customer'; return await custWelcome(c); }
    if (low === '#admin' || low === '#shop') delete sess.data.mode;
    let role = sess.data.mode === 'customer' ? 'customer' : isAdmin ? 'admin' : c.ownShops.length ? 'owner' : 'customer';
    if (/^order\s+w[a-z0-9]{5,8}\b/.test(low)) role = 'customer';
    if (low === '#shop' && c.ownShops.length) role = 'owner';
    if (role === 'admin' && low === '#shop' && !c.ownShops.length) return await adminMenu(c);
    if (sess.data.role !== role) { sess.state = null; sess.data.role = role; }
    const fn = { admin, owner, customer }[role];
    const vv = low.startsWith('#') ? 'menu' : v;
    await fn(c, vv, btn);
  } catch (e) {
    console.error('handle error', e);
    await out(from, '⚠️ Something went wrong. Please type *menu* and try again.').catch(() => {});
  } finally {
    if (!sess.noSave) await db.sessions.save(from, sess);
  }
}

module.exports = { earn, billPaid, confirmPayment, refundPayment, remindBills, earningsText, PREV_MONTH_KEY, MONTH_NAME, langOf, setLang, createOrder, orderPlaced, webLink, nearbyShops, handle, activate, notify, notifyAdmins, notifyShopAdmins, rs, setStatus, ownerWelcome, mkCode, newAreaAdminWelcome, sendBills, areaMoney, out };
