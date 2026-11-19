// Web admin panel: /panel. Main admins and area admins log in with a one-time
// code sent by the bot on WhatsApp. Area admins only see their own areas.
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const bot = require('./bot');
const catalog = require('./catalog');
const pay = require('./pay');
const network = require('./network');
const ExcelJS = require('exceljs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const r = express.Router();
r.use(express.urlencoded({ extended: false }));

const rs = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('emart:' + cfg.ADMIN_KEY + ':' + cfg.WA_TOKEN).digest('hex');
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
const MONTH = () => new Date().toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });

// ---------- auth
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
async function who(phone) {
  const isSuper = cfg.ADMINS.includes(phone);
  const myAreas = await db.areas.byAdmin(phone);
  const sups = isSuper ? [] : await network.supervisorOf(phone);
  if (!isSuper && !myAreas.length && !sups.length) return null;
  return { phone, isSuper, myAreas, areaIds: myAreas.map((a) => a.id), sups, role: isSuper ? 'Main admin' : sups.length ? 'Supervisor' : 'Zone admin' };
}
async function auth(req, res, next) {
  if (req.query.key && req.query.key === cfg.ADMIN_KEY && cfg.ADMINS[0]) {
    req.u = await who(cfg.ADMINS[0]);
    return next();
  }
  const c = readCookie(req, 'em_s');
  if (c) {
    const [phone, exp, sig] = c.split('.');
    if (sig === sign(phone + '.' + exp) && Number(exp) > Date.now()) {
      req.u = await who(phone);
      if (req.u) return next();
    }
  }
  return res.redirect('/panel/login');
}
const superOnly = (req, res, next) => (req.u.isSuper ? next() : res.status(403).send(page(req, 'Not allowed', '<p>Only the main admin can open this page.</p>')));
const inScope = (u, s) => !!s && (u.isSuper || u.areaIds.includes(s.area_id));
const back = (res, url, msg) => res.redirect(url + (url.includes('?') ? '&' : '?') + 'm=' + encodeURIComponent(msg));

// ---------- layout
const CSS = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f1f5f2;color:#14231a}
header{background:#166534;color:#fff;padding:12px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header b{font-size:18px}header nav{display:flex;gap:4px;flex-wrap:wrap}header a{color:#dcfce7;text-decoration:none;padding:6px 10px;border-radius:8px}
header a.on,header a:hover{background:rgba(255,255,255,.15);color:#fff}header .me{margin-left:auto;font-size:13px;opacity:.9}
main{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:20px;margin:6px 0 14px}h2{font-size:16px;margin:22px 0 10px;color:#3b4a3f}
.card{background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.kp{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}.k{background:#fff;border-radius:12px;padding:12px 14px}
.k small{color:#5b6b60;font-size:12px}.k b{display:block;font-size:21px;margin-top:3px}
.tw{overflow-x:auto;background:#fff;border-radius:12px}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid #eef2ef;vertical-align:middle}th{background:#f7faf8;color:#4b5b50;font-weight:600;white-space:nowrap}
.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}.g{background:#dcfce7;color:#166534}.y{background:#fef3c7;color:#854d0e}.r{background:#fee2e2;color:#991b1b}.b{background:#dbeafe;color:#1e40af}
form.in{display:inline}label{display:block;font-size:13px;color:#3b4a3f;margin:8px 0 4px}
input,select,textarea{font:inherit;padding:8px 10px;border:1px solid #cbd5cf;border-radius:8px;width:100%;background:#fff}textarea{min-height:110px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
button,.btn{font:inherit;font-size:14px;padding:8px 14px;border-radius:8px;border:1px solid #166534;background:#166534;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost,.btn.ghost{background:#fff;color:#166534}button.warn{background:#fff;color:#b91c1c;border-color:#b91c1c}button.sm{padding:5px 10px;font-size:13px}
.msg{background:#dcfce7;border:1px solid #86efac;padding:10px 14px;border-radius:10px;margin-bottom:12px}.muted{color:#5b6b60;font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}a{color:#166534}
.login{max-width:380px;margin:60px auto}`;
function page(req, title, body, tab) {
  const u = req.u;
  const nav = u ? [['', 'Dashboard'], ...(u.isSuper ? [['/network', 'Network'], ['/areas', 'Zones']] : [['/earnings', 'Earnings']]), ['/shops', 'Shops'], ...(u.isSuper ? [['/catalog', 'Shop types']] : []), ['/orders', 'Orders'], ...(u.isSuper ? [['/bills', 'Bills']] : [])]
    .map(([p, n]) => `<a href="/panel${p}" class="${tab === n ? 'on' : ''}">${n}</a>`).join('') : '';
  const msg = req.query && req.query.m ? `<div class="msg">${esc(req.query.m)}</div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} – ${esc(cfg.BRAND)} admin</title><style>${CSS}</style></head><body>
<header><b>${esc(cfg.BRAND)} admin</b><nav>${nav}</nav>${u ? `<span class="me">${u.isSuper ? 'Main admin' : esc(u.role) + ' · ' + esc(u.myAreas.map((a) => a.name).join(', ') || u.sups.map((t) => t.name).join(', '))} · +${u.phone} · <a href="/panel/logout" style="color:#fff">Log out</a></span>` : ''}</header>
<main>${msg}${body}</main></body></html>`;
}
const STAT = { New: 'y', Accepted: 'b', Ready: 'b', 'Out for delivery': 'b', Completed: 'g', Cancelled: 'r' };

// ---------- login with WhatsApp code
r.get('/login', (req, res) => res.send(page(req, 'Log in', `<div class="login card"><h1>Admin log in</h1>
<form method="post" action="/panel/keylogin"><label>Admin key</label><input name="key" type="password" autocomplete="current-password" required autofocus>
<p></p><button>Log in</button></form>
<hr style="border:0;border-top:1px solid #e2e8e4;margin:20px 0">
<form method="post" action="/panel/login"><label>Or log in with your WhatsApp number</label><input name="phone" inputmode="tel" placeholder="9003264537" required>
<p class="muted">A 6-digit code is sent by ${esc(cfg.BRAND)} on WhatsApp. Area admins use this.</p><button class="ghost">Send code</button></form></div>`)));
const keyTries = new Map();
r.post('/keylogin', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const t = keyTries.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 15 * 60e3) { t.n = 0; t.at = Date.now(); }
  const bad = () => res.status(401).send(page(req, 'Log in', `<div class="login card"><h1>Wrong admin key</h1><p>Check the key and try again.</p><a class="btn" href="/panel/login">Back</a></div>`));
  if (t.n >= 10) return bad();
  const k = String(req.body.key || '');
  const ok = k.length && cfg.ADMIN_KEY && k.length === cfg.ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(cfg.ADMIN_KEY));
  if (!ok || !cfg.ADMINS[0]) { t.n++; keyTries.set(ip, t); return bad(); }
  keyTries.delete(ip);
  const phone = cfg.ADMINS[0], exp = String(Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `em_s=${encodeURIComponent(phone + '.' + exp + '.' + sign(phone + '.' + exp))}; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`);
  res.redirect('/panel');
});
r.post('/login', async (req, res) => {
  const phone = cfg.norm(req.body.phone);
  const u = phone.length >= 12 ? await who(phone) : null;
  const done = () => res.send(page(req, 'Enter code', `<div class="login card"><h1>Enter the code</h1><p class="muted">If +${esc(phone)} is an admin number, a code was sent on WhatsApp. It's valid for 10 minutes.</p>
<form method="post" action="/panel/verify"><input type="hidden" name="phone" value="${esc(phone)}"><label>6-digit code</label><input name="code" inputmode="numeric" maxlength="6" required autofocus><p></p><button>Log in</button></form>
<p class="muted">No message? Send <b>hi</b> to ${esc(cfg.BRAND)} on WhatsApp first, then <a href="/panel/login">try again</a>.</p></div>`));
  if (!u) return done();
  const recent = await db.one(`select 1 from otps where phone=$1 and created_at > now() - interval '45 seconds'`, [phone]);
  if (!recent) {
    const code = String(crypto.randomInt(100000, 1000000));
    await db.q(`insert into otps(phone,code_hash,expires_at) values($1,$2,now()+interval '10 minutes') on conflict(phone) do update set code_hash=$2, expires_at=now()+interval '10 minutes', tries=0, created_at=now()`, [phone, sign(phone + ':' + code)]);
    await bot.notify(phone, `🔐 Your ${cfg.BRAND} admin login code is *${code}*.\nIt expires in 10 minutes. Don't share it with anyone.`);
  }
  done();
});
r.post('/verify', async (req, res) => {
  const phone = cfg.norm(req.body.phone), code = String(req.body.code || '').trim();
  const row = await db.one('select * from otps where phone=$1 and expires_at > now()', [phone]);
  const fail = () => res.send(page(req, 'Log in', `<div class="login card"><h1>Code not accepted</h1><p>The code is wrong or expired.</p><a class="btn" href="/panel/login">Try again</a></div>`));
  if (!row || row.tries >= 5) return fail();
  if (row.code_hash !== sign(phone + ':' + code)) { await db.q('update otps set tries=tries+1 where phone=$1', [phone]); return fail(); }
  await db.q('delete from otps where phone=$1', [phone]);
  const exp = String(Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `em_s=${encodeURIComponent(phone + '.' + exp + '.' + sign(phone + '.' + exp))}; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`);
  res.redirect('/panel');
});
r.get('/logout', (req, res) => { res.setHeader('Set-Cookie', 'em_s=; Path=/panel; Max-Age=0'); res.redirect('/panel/login'); });

r.use(auth);
r.use(network.auditMiddleware);

// ---------- helpers
async function typeOptions(selected) {
  return `<option value="">Other / not listed</option>` + (await catalog.types(true)).filter((t) => t.active || t.id === selected).map((t) => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
}
async function shopsFor(u) { const all = await db.shops.all(); return u.isSuper ? all : all.filter((s) => u.areaIds.includes(s.area_id)); }
async function areasFor(u) { return u.isSuper ? db.areas.all() : u.myAreas; }
const parseLoc = (t) => { const m = String(t || '').match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/); return m ? { lat: +m[1], lng: +m[2] } : null; };

// ---------- referral link + team (zone admins and supervisors)
async function myNetwork(u) {
  let h = '';
  const own = u.myAreas.filter((a) => a.admin_phone === u.phone);
  for (let a of own) {
    a = await network.ensureRef(a.id); const link = network.refLink(a);
    h += `<div class="card row" style="align-items:flex-start"><img src="${esc(network.qrUrl(link))}" width="140" height="140" alt="QR code"><div style="flex:1;min-width:220px"><b>Your referral link · ${esc(a.name)}</b><p class="muted">Print this QR on your posters. Shops and customers who open it are linked to you.</p><input readonly value="${esc(link)}" onclick="this.select()"><p class="muted">Code: <b>${esc(a.ref_code)}</b> · ${esc(a.level || 'Bronze')} admin · <a href="/poster/${esc(a.ref_code)}.pdf" target="_blank">Poster (PDF)</a> · <a href="/qr/${esc(a.ref_code)}.png" target="_blank">QR image</a></p></div></div>`;
  }
  if (u.sups.length) {
    const t = await network.team(u.phone);
    h += `<h2>Your team · ${esc(u.sups.map((x) => x.name + ' taluk').join(', '))}</h2><div class="tw"><table><tr><th>Zone</th><th>Taluk</th><th>Admin</th><th>Admin earned (${MONTH()})</th></tr>${t.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.taluk)}</td><td>${a.admin_phone ? '+' + a.admin_phone : '<span class="tag y">No admin</span>'}</td><td>${rs(a.earned)}</td></tr>`).join('') || '<tr><td colspan="4">No zones in your taluks yet.</td></tr>'}</table></div>`;
  }
  return h;
}

// ---------- dashboard
r.get('/', async (req, res) => {
  const u = req.u, shops = await shopsFor(u);
  let gmv = 0; for (const s of shops) { s.ms = await db.shops.monthSales(s.id); gmv += s.ms; }
  const ids = shops.map((s) => s.id);
  const open = ids.length ? (await db.one(`select count(*)::int n from orders where shop_id = any($1) and status not in ('Completed','Cancelled')`, [ids])).n : 0;
  const today = ids.length ? await db.one(`select count(*)::int n, coalesce(sum(subtotal),0) s from orders where shop_id = any($1) and status<>'Cancelled' and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`, [ids]) : { n: 0, s: 0 };
  const setup = shops.filter((s) => s.paid).length * cfg.SETUP_FEE, comm = gmv * cfg.COMM;
  const got = (await db.one(`select coalesce(sum(amount),0) s from payments where status='paid' and to_char(paid_at at time zone 'Asia/Kolkata','YYYY-MM')=$1`, [network.monthKey()])).s;
  const net = await network.companyMonth(), dueAll = (await network.payouts()).reduce((t, p) => t + Number(p.due), 0);
  const me = u.isSuper ? null : await network.summary(u.phone);
  const k = (t, v) => `<div class="k"><small>${t}</small><b>${v}</b></div>`;
  const kp = u.isSuper
    ? k('Live shops', `${shops.filter((s) => s.paid && s.active).length} / ${shops.length}`) + k(`${MONTH()} shop sales`, rs(gmv)) + k(`${cfg.COMM * 100}% commission (on sales)`, rs(comm)) + k(`Money received in ${MONTH()}`, rs(got)) + k(`Admins & supervisors (${MONTH()})`, rs(net.admins + net.sups)) + k('Your net this month', rs(got - net.admins - net.sups)) + k('Payouts waiting', rs(dueAll)) + k('Setup fees (all time)', rs(setup)) + k('Today', `${today.n} orders · ${rs(today.s)}`) + k('Open orders', open)
    : k('Live shops', `${shops.filter((s) => s.paid && s.active).length} / ${shops.length}`) + k(`${MONTH()} shop sales`, rs(gmv)) + k(`You earned in ${MONTH()}`, rs(me.month)) + k('Waiting for payout', rs(me.due)) + k('Paid out so far', rs(me.paid)) + k('Today', `${today.n} orders · ${rs(today.s)}`) + k('Open orders', open);
  const rows = shops.sort((a, b) => b.ms - a.ms).slice(0, 10).map((s) => `<tr><td><a href="/panel/shops/${s.id}">${esc(s.name)}</a></td><td>${esc(s.area)}</td><td>${!s.paid ? '<span class="tag y">Fee pending</span>' : s.active ? '<span class="tag g">Live</span>' : '<span class="tag r">Paused</span>'}</td><td>${rs(s.ms)}</td></tr>`).join('');
  res.send(page(req, 'Dashboard', `<h1>Dashboard — ${MONTH()}</h1><div class="kp">${kp}</div>
<div class="row" style="margin-bottom:14px"><a class="btn" href="/panel/shops#new">+ Add shop</a>${u.isSuper ? '<a class="btn ghost" href="/panel/areas#new">+ Add area</a>' : ''}<a class="btn ghost" href="/panel/orders?status=open">Open orders (${open})</a></div>
${u.isSuper ? '' : await myNetwork(u)}<h2>Top shops this month</h2><div class="tw"><table><tr><th>Shop</th><th>Locality</th><th>Status</th><th>Month sales</th></tr>${rows || '<tr><td colspan="4">No shops yet.</td></tr>'}</table></div>`, 'Dashboard'));
});

// ---------- zones (main admin)
async function talukOptions(sel) {
  return '<option value="">No taluk yet</option>' + (await network.taluks.all()).map((t) => `<option value="${t.id}"${t.id === sel ? ' selected' : ''}>${esc(t.district)} · ${esc(t.name)}</option>`).join('');
}
r.get('/areas', superOnly, async (req, res) => {
  const areas = await db.areas.all(), tk = Object.fromEntries((await network.taluks.all()).map((t) => [t.id, t])); let rows = '';
  for (let a of areas) {
    a = await network.ensureRef(a.id);
    const x = await bot.areaMoney(a), t = tk[a.taluk_id];
    rows += `<tr><td><b>${esc(a.name)}</b><br><span class="muted">Code ${esc(a.ref_code)}</span></td><td>${t ? `${esc(t.name)}<br><span class="muted">${esc(t.district)}</span>` : '<span class="tag y">No taluk</span>'}</td><td>${a.admin_phone ? '+' + a.admin_phone : '—'}</td><td>${a.lat != null ? `${a.radius_km} km` : '<span class="tag y">no location</span>'}</td><td>${x.shops}${a.admin_phone && a.admin_since ? `<br><span class="muted">${a.level || 'Bronze'} · day ${Math.floor((Date.now() - new Date(a.admin_since)) / 864e5)}${a.review_note ? ' · ' + esc(a.review_note) : ''}</span>` : ''}</td><td>${rs(x.received)}</td><td>${rs(x.admin)}</td><td>${a.active ? '<span class="tag g">Active</span>' : '<span class="tag r">Paused</span>'}</td>
<td><details><summary>Edit</summary><form method="post" action="/panel/areas/${a.id}"><div class="grid"><div><label>Name</label><input name="name" value="${esc(a.name)}"></div><div><label>Zone admin WhatsApp (blank = none)</label><input name="admin" value="${a.admin_phone ? esc(a.admin_phone.slice(2)) : ''}"></div>
<div><label>Taluk</label><select name="taluk_id">${await talukOptions(a.taluk_id)}</select></div>
<div><label>Centre (Google Maps link or lat,lng)</label><input name="loc" value="${a.lat != null ? a.lat + ',' + a.lng : ''}"></div><div><label>Radius (km)</label><input name="radius" type="number" step="0.5" min="0.5" max="5" value="${a.radius_km}"></div>
<div><label>Status</label><select name="active"><option value="1"${a.active ? ' selected' : ''}>Active</option><option value="0"${a.active ? '' : ' selected'}>Paused</option></select></div></div><p></p><button class="sm">Save</button></form></details></td></tr>`;
  }
  res.send(page(req, 'Zones', `<h1>Zones & zone admins</h1><p class="muted">On money received: zone admin ${network.ADMIN_PCT}% · taluk supervisor ${network.SUP_PCT}% · company the rest. Add taluks and supervisors on the <a href="/panel/network">Network</a> page.</p>
<div class="tw"><table><tr><th>Zone</th><th>Taluk</th><th>Zone admin</th><th>Radius</th><th>Shops</th><th>Received (${MONTH()})</th><th>Admin share</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="9">No zones yet.</td></tr>'}</table></div>
<h2 id="new">Add zone</h2><div class="card"><form method="post" action="/panel/areas"><div class="grid"><div><label>Zone name</label><input name="name" required placeholder="KK Nagar"></div><div><label>Zone admin WhatsApp (optional)</label><input name="admin" placeholder="9xxxxxxxxx"></div>
<div><label>Taluk</label><select name="taluk_id">${await talukOptions(null)}</select></div>
<div><label>Centre (Google Maps link or lat,lng)</label><input name="loc" placeholder="13.0400, 80.2000"></div><div><label>Radius (km)</label><input name="radius" type="number" step="0.5" min="0.5" max="5" value="3"></div></div>
<p class="muted">Tip: in Google Maps, long-press the centre of the zone and copy the coordinates shown at the top.</p><button>Create zone</button></form></div>`, 'Zones'));
});
const talukOf = (v) => (Number(v) > 0 ? Number(v) : null);
r.post('/areas', superOnly, async (req, res) => {
  const b = req.body, loc = parseLoc(b.loc), admin = b.admin && b.admin.replace(/\D/g, '').length >= 10 ? cfg.norm(b.admin) : null;
  if (!String(b.name || '').trim()) return back(res, '/panel/areas', 'Zone name is required.');
  let a = await db.one('insert into areas(name,admin_phone,lat,lng,radius_km,taluk_id) values($1,$2,$3,$4,$5,$6) returning *', [b.name.trim(), admin, loc ? loc.lat : null, loc ? loc.lng : null, Math.min(5, Number(b.radius) || cfg.DEFAULT_RADIUS_KM), talukOf(b.taluk_id)]);
  a = await network.ensureRef(a.id);
  if (a.admin_phone) await bot.newAreaAdminWelcome(a);
  back(res, '/panel/areas', `Zone ${a.name} created.${a.admin_phone ? ' Zone admin notified on WhatsApp.' : ''}`);
});
r.post('/areas/:id', superOnly, async (req, res) => {
  const a0 = await db.areas.get(+req.params.id); if (!a0) return back(res, '/panel/areas', 'Zone not found.');
  const b = req.body, loc = parseLoc(b.loc), admin = b.admin && b.admin.replace(/\D/g, '').length >= 10 ? cfg.norm(b.admin) : null;
  const a = await db.areas.set(a0.id, { name: (b.name || a0.name).trim(), admin_phone: admin, lat: loc ? loc.lat : a0.lat, lng: loc ? loc.lng : a0.lng, radius_km: Math.min(5, Number(b.radius) || a0.radius_km),
    taluk_id: talukOf(b.taluk_id), active: b.active === '1' });
  if (a.admin_phone && a.admin_phone !== a0.admin_phone) await bot.newAreaAdminWelcome(a);
  back(res, '/panel/areas', `${a.name} saved.`);
});

// ---------- network: districts, taluks, supervisors, payouts (main admin)
r.get('/network', superOnly, async (req, res) => {
  const ds = await network.districtStats(), tks = await network.taluks.all(), pays = await network.payoutRows();
  const apps = await db.all(`select a.*, t.name taluk from applications a left join taluks t on t.id=a.taluk_id where a.status in ('pending','waitlist','approved') order by a.id`);
  const sentToday = await network.sentToday(), msgs = await network.msgStats();
  const appOpts = {}; for (const a of apps) appOpts[a.id] = await talukOptions(a.taluk_id);
  const zonesBy = Object.fromEntries((await db.all('select taluk_id, count(*)::int n, count(admin_phone)::int a from areas where taluk_id is not null group by taluk_id')).map((x) => [x.taluk_id, x]));
  const tot = ds.reduce((t, d) => ({ p: t.p + d.taluks_planned, t: t.t + d.taluks, s: t.s + d.sups, z: t.z + d.zones, a: t.a + d.admins }), { p: 0, t: 0, s: 0, z: 0, a: 0 });
  const dOpts = ds.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  res.send(page(req, 'Network', `<h1>Network — Tamil Nadu</h1>
<div class="kp"><div class="k"><small>Taluks set up</small><b>${tot.t} / ${tot.p}</b></div><div class="k"><small>Supervisors</small><b>${tot.s}</b></div><div class="k"><small>Zones</small><b>${tot.z}</b></div><div class="k"><small>Zone admins</small><b>${tot.a}</b></div><div class="k"><small>Payouts waiting</small><b>${rs(pays.reduce((t, p) => t + Number(p.net), 0))}</b></div><div class="k"><small>WhatsApp chats we started today</small><b>${sentToday} / ${network.DAILY_LIMIT}</b></div></div>
<h2 id="apps">Admin applications</h2><div class="tw"><table><tr><th>#</th><th>Name</th><th>Place</th><th>Taluk</th><th>Status</th><th></th></tr>${apps.map((a) => `<tr><td>${a.id}</td><td><b>${esc(a.name)}</b><br><span class="muted">+${a.phone}</span></td><td>${esc(a.place)}<br><a href="https://maps.google.com/?q=${a.lat},${a.lng}" target="_blank">map</a></td><td>${a.taluk ? esc(a.taluk) : '<span class="tag y">not matched</span>'}</td><td><span class="tag ${a.status === 'approved' ? 'b' : 'y'}">${a.status === 'approved' ? 'waiting for "I agree"' : a.status}</span></td>
<td>${a.status === 'approved' ? '' : `<form class="row" method="post" action="/panel/applications/${a.id}"><select name="taluk_id" style="width:170px">${appOpts[a.id]}</select><button class="sm" name="do" value="approve">Approve</button><button class="sm warn" name="do" value="reject">Reject</button></form>`}</td></tr>`).join('') || '<tr><td colspan="6">No applications. People apply by sending <b>ADMIN</b> to the bot.</td></tr>'}</table></div>
<h2>Payouts waiting</h2><p><a class="btn ghost" href="/panel/network/payouts.csv">Download payout list (CSV)</a></p><div class="tw"><table><tr><th>Name</th><th>UPI ID</th><th>Role</th><th>Commission</th><th>TDS ${network.TDS_PCT}%</th><th>Pay</th><th></th></tr>${pays.map((p) => `<tr><td>${esc(p.payee ? p.payee.name : '')}<br><span class="muted">+${p.phone}</span></td><td>${p.payee && p.payee.upi ? esc(p.payee.upi) : '<span class="tag y">no UPI</span>'}</td><td>${esc(p.roles)}</td><td>${rs(p.due)}</td><td>${rs(p.tds)}</td><td><b>${rs(p.net)}</b></td><td><form class="row" method="post" action="/panel/network/payout" onsubmit="return confirm('Mark ${rs(p.net)} as paid to +${p.phone}?')"><input type="hidden" name="phone" value="${p.phone}"><input name="ref" placeholder="UPI ref (optional)" style="width:170px"><button class="sm">Mark paid</button></form></td></tr>`).join('') || '<tr><td colspan="7">Nothing due.</td></tr>'}</table></div>
<p class="muted">Pay each person the <b>Pay</b> amount by UPI, then mark it paid. TDS (${network.TDS_PCT}%, Section 194H) starts once a person's commission in the financial year passes ₹${network.TDS_LIMIT.toLocaleString('en-IN')} — deposit it and file the TDS return with your CA. Commission is added only when a shop's payment has actually come in; refunds take it back.</p>
<h2>WhatsApp messages we started (${MONTH()})</h2><div class="tw"><table><tr><th>Zone</th><th>Alerts (utility)</th></tr>${msgs.map((x) => `<tr><td>${esc(x.name || 'All / not by zone')}</td><td>${x.utility || 0}</td></tr>`).join('') || '<tr><td colspan="2">None yet.</td></tr>'}</table></div>
<p class="muted">Meta allows about ${network.DAILY_LIMIT} new chats a day for your number now (set WA_DAILY_LIMIT when Meta raises it). <a href="/panel/audit">Change log →</a></p>
<h2 id="taluks">Taluks & supervisors</h2><div class="tw"><table><tr><th>District</th><th>Taluk</th><th>Supervisor</th><th>Zones</th><th>Zone admins</th><th></th></tr>${tks.map((t) => `<tr><td>${esc(t.district)}</td><td><b>${esc(t.name)}</b></td><td>${t.supervisor_phone ? '+' + t.supervisor_phone : '<span class="tag y">None</span>'}</td><td>${(zonesBy[t.id] || {}).n || 0}</td><td>${(zonesBy[t.id] || {}).a || 0} / 10</td>
<td><form class="row" method="post" action="/panel/network/taluks/${t.id}"><input name="sup" placeholder="Supervisor WhatsApp" value="${t.supervisor_phone ? esc(t.supervisor_phone.slice(2)) : ''}" style="width:170px"><button class="sm ghost">Save</button></form></td></tr>`).join('') || '<tr><td colspan="6">No taluks yet. Add your first one below.</td></tr>'}</table></div>
<div class="card"><form method="post" action="/panel/network/taluks"><div class="grid"><div><label>District</label><select name="district_id" required>${dOpts}</select></div><div><label>Taluk name</label><input name="name" required placeholder="Ambattur"></div><div><label>Supervisor WhatsApp (optional)</label><input name="sup" placeholder="9xxxxxxxxx"></div></div><p></p><button>Add taluk</button></form></div>
<h2>Districts</h2><div class="tw"><table><tr><th>District</th><th>Taluks set up</th><th>Supervisors</th><th>Zones</th><th>Zone admins (target)</th><th>Received via admins (${MONTH()})</th></tr>${ds.map((d) => `<tr><td>${esc(d.name)}</td><td>${d.taluks} / ${d.taluks_planned}</td><td>${d.sups}</td><td>${d.zones}</td><td>${d.admins} / ${d.taluks_planned * 10}</td><td>${rs(d.revenue)}</td></tr>`).join('')}</table></div>`, 'Network'));
});
const phoneOrNull = (v) => (v && String(v).replace(/\D/g, '').length >= 10 ? cfg.norm(String(v).replace(/\D/g, '').slice(-10)) : null);
async function supWelcome(t) {
  if (!t.supervisor_phone) return;
  const tt = await network.taluks.get(t.id);
  await bot.notify(t.supervisor_phone, `👥 You are now the *supervisor* for *${tt.name} taluk* (${tt.district}) on ${cfg.BRAND}.\n\nYou help the zone admins in your taluk and earn *${network.SUP_PCT}%* of every payment from their zones.\nWeb panel: ${cfg.PUBLIC_URL}/panel\n\nType *menu* to start.`, [['💰 My earnings', 'myearn'], ['Menu', 'menu']]);
}
r.post('/network/taluks', superOnly, async (req, res) => {
  const name = String(req.body.name || '').trim(); if (!name) return back(res, '/panel/network#taluks', 'Taluk name is required.');
  const t = await network.taluks.add(+req.body.district_id, name, phoneOrNull(req.body.sup));
  await supWelcome(t);
  back(res, '/panel/network#taluks', `Taluk ${t.name} saved.${t.supervisor_phone ? ' Supervisor notified on WhatsApp.' : ''}`);
});
r.post('/network/taluks/:id', superOnly, async (req, res) => {
  const t0 = await network.taluks.get(+req.params.id); if (!t0) return back(res, '/panel/network#taluks', 'Taluk not found.');
  const t = await network.taluks.setSupervisor(t0.id, phoneOrNull(req.body.sup));
  if (t.supervisor_phone && t.supervisor_phone !== t0.supervisor_phone) await supWelcome(t);
  back(res, '/panel/network#taluks', `${t0.name}: supervisor ${t.supervisor_phone ? 'set to +' + t.supervisor_phone : 'removed'}.`);
});
r.post('/network/payout', superOnly, async (req, res) => {
  const phone = cfg.norm(req.body.phone), ref = String(req.body.ref || '').slice(0, 60), x = await network.markPaid(phone, ref);
  if (x.n) await bot.notify(phone, `✅ ${cfg.BRAND} payout sent\nCommission: ${rs(x.due)}${x.tds ? `\nTDS (${network.TDS_PCT}%): −${rs(x.tds)}` : ''}\n*Paid to you: ${rs(x.net)}*${ref ? '\nRef: ' + ref : ''}\nThank you!`, [['💰 My earnings', 'myearn']]);
  back(res, '/panel/network', x.n ? `Marked ${rs(x.net)} paid to +${phone}${x.tds ? ` (TDS ${rs(x.tds)})` : ''}.` : 'Nothing was due.');
});
r.get('/network/payouts.csv', superOnly, async (req, res) => {
  res.type('text/csv').set('Content-Disposition', `attachment; filename="payouts-${network.monthKey()}.csv"`).send(await network.payoutCsv());
});
r.post('/applications/:id', superOnly, async (req, res) => {
  const ok = req.body.do === 'approve', id = +req.params.id;
  if (Number(req.body.taluk_id) > 0) await db.q('update applications set taluk_id=$2 where id=$1', [id, +req.body.taluk_id]);
  const a = await network.decide(id, ok, req.u.phone);
  if (!a) return back(res, '/panel/network#apps', 'Already handled.');
  if (ok) await bot.notify(a.phone, network.agreementText(), [['✅ I agree', 'rcagree']]);
  else await bot.notify(a.phone, `Thank you for applying to ${cfg.BRAND}. We can't take your application right now. We'll message you if a place opens in your area.`);
  back(res, '/panel/network#apps', ok ? `Approved ${a.name}. The zone opens when they tap "I agree" on WhatsApp.` : `Rejected ${a.name}.`);
});
r.get('/audit', superOnly, async (req, res) => {
  const rows = await network.auditRows(300);
  res.send(page(req, 'Change log', `<h1>Change log</h1><div class="tw"><table><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr>${rows.map((x) => `<tr><td>${new Date(x.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' })}</td><td>${x.phone ? '+' + x.phone : '—'}</td><td>${esc(x.action)}</td><td class="muted" style="max-width:520px;word-break:break-all">${esc(x.detail)}</td></tr>`).join('') || '<tr><td colspan="4">Nothing yet.</td></tr>'}</table></div>`, 'Network'));
});

// ---------- payout details (UPI + PAN) for zone admins and supervisors
async function payeeForm(u) {
  const p = (await db.one('select * from payees where phone=$1', [u.phone])) || {};
  const pv = await network.payoutPreview(u.phone);
  return `<div class="card"><b>Payout details</b>${pv.tds ? `<p class="muted">Next payout: ${rs(pv.due)} − TDS ${rs(pv.tds)} = <b>${rs(pv.net)}</b></p>` : ''}<form method="post" action="/panel/earnings/payee"><div class="grid"><div><label>Name (as on PAN)</label><input name="name" value="${esc(p.name || '')}" required></div><div><label>UPI ID for payouts</label><input name="upi" value="${esc(p.upi || '')}" placeholder="name@okaxis" required></div><div><label>PAN</label><input name="pan" value="${esc(p.pan || '')}" placeholder="ABCDE1234F" maxlength="10"></div></div><p class="muted">Needed for TDS: without a PAN the law asks for 20% TDS.</p><button class="sm">Save</button></form></div>`;
}
r.post('/earnings/payee', async (req, res) => {
  const b = req.body, upi = String(b.upi || '').trim(), pan = String(b.pan || '').trim().toUpperCase();
  if (!/^[\w.\-]{2,}@[a-zA-Z][\w.\-]{1,}$/.test(upi)) return back(res, '/panel/earnings', 'Please enter a UPI ID like name@okaxis.');
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return back(res, '/panel/earnings', 'PAN should look like ABCDE1234F.');
  await db.q(`insert into payees(phone,name,upi,pan) values($1,$2,$3,$4) on conflict(phone) do update set name=$2, upi=$3, pan=coalesce(nullif($4,''),payees.pan), updated_at=now()`, [req.u.phone, String(b.name || '').trim().slice(0, 80), upi, pan]);
  back(res, '/panel/earnings', 'Payout details saved.');
});

// ---------- earnings (zone admins and supervisors)
r.get('/earnings', async (req, res) => {
  const u = req.u, x = await network.summary(u.phone);
  const rows = await db.all(`select e.*, s.name shop from earnings e left join payments p on p.id=e.payment_id left join shops s on s.id=p.ref where e.phone=$1 order by e.id desc limit 200`, [u.phone]);
  const st = { due: 'y', paid: 'g', reversed: 'r' };
  res.send(page(req, 'Earnings', `<h1>My earnings</h1><div class="kp"><div class="k"><small>${MONTH()}</small><b>${rs(x.month)}</b></div><div class="k"><small>Waiting for payout</small><b>${rs(x.due)}</b></div><div class="k"><small>Paid out so far</small><b>${rs(x.paid)}</b></div></div>
${await payeeForm(u)}${await myNetwork(u)}<h2>Every payment</h2><div class="tw"><table><tr><th>Date</th><th>Shop</th><th>Payment</th><th>Role</th><th>Your share</th><th>Status</th></tr>${rows.map((e) => `<tr><td>${new Date(e.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td><td>${esc(e.shop || '—')}</td><td>${e.source === 'setup' ? 'Setup fee' : 'Monthly fee'} ${rs(e.base)}</td><td>${e.role === 'admin' ? 'Zone admin' : 'Supervisor'} ${e.pct}%</td><td>${rs(e.amount)}${e.kind === 'reverse' ? ' (refund)' : ''}</td><td><span class="tag ${st[e.status] || 'b'}">${e.status}</span></td></tr>`).join('') || '<tr><td colspan="6">No earnings yet. You earn when shops in your zone pay.</td></tr>'}</table></div>`, 'Earnings'));
});

// ---------- shops
r.get('/shops', async (req, res) => {
  const u = req.u, shops = await shopsFor(u), areas = Object.fromEntries((await db.areas.all()).map((a) => [a.id, a]));
  const tnames = Object.fromEntries((await catalog.types(true)).map((t) => [t.id, t.name]));
  const q = String(req.query.q || '').toLowerCase();
  let rows = '';
  for (const s of shops.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.area || '').toLowerCase().includes(q) || x.owner_phone.includes(q))) {
    const ms = await db.shops.monthSales(s.id);
    const n = (await db.one('select count(*)::int c, count(*) filter (where stock<5)::int low from items where shop_id=$1', [s.id]));
    rows += `<tr><td><a href="/panel/shops/${s.id}"><b>${esc(s.name)}</b></a> <span class="muted">${s.code}</span><br><span class="muted">${esc(tnames[s.type_id] || 'Other')}</span></td><td>${esc(s.area)}${s.area_id && areas[s.area_id] ? `<br><span class="muted">${esc(areas[s.area_id].name)}</span>` : ''}</td><td>+${s.owner_phone}</td>
<td>${!s.paid ? '<span class="tag y">Fee pending</span>' : s.active ? '<span class="tag g">Live</span>' : '<span class="tag r">Paused</span>'}</td><td>${s.delivery ? 'Yes · ' + rs(s.del_fee) : 'Pickup only'}</td><td>${n.c}${n.low ? ` <span class="tag y">${n.low} low</span>` : ''}</td><td>${s.lat != null ? '✓' : '<span class="tag y">not set</span>'}</td><td>${rs(ms)}</td>
<td class="row">${!s.paid && u.isSuper ? `<form class="in" method="post" action="/panel/shops/${s.id}/paid"><button class="sm">Mark ${rs(cfg.SETUP_FEE)} paid</button></form>` : ''}<a class="btn ghost sm" href="/panel/shops/${s.id}">Open</a><a class="btn ghost sm" href="/panel/shops/${s.id}#excel">Excel</a></td></tr>`;
  }
  const areaOpts = (await areasFor(u)).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  res.send(page(req, 'Shops', `<h1>Shops</h1><form class="row" method="get" style="margin-bottom:10px"><input name="q" value="${esc(req.query.q || '')}" placeholder="Search name, locality or phone" style="max-width:320px"><button class="ghost">Search</button></form>
<div class="tw"><table><tr><th>Shop</th><th>Locality / area</th><th>Owner</th><th>Status</th><th>Delivery</th><th>Items</th><th>Location</th><th>${MONTH()} sales</th><th></th></tr>${rows || '<tr><td colspan="9">No shops yet.</td></tr>'}</table></div>
<h2 id="new">Add shop</h2><div class="card"><form method="post" action="/panel/shops"><div class="grid"><div><label>Shop name</label><input name="name" required></div><div><label>Owner WhatsApp number</label><input name="owner" required placeholder="9xxxxxxxxx"></div>
<div><label>Street / locality (shown to customers)</label><input name="area" required></div><div><label>Area</label><select name="area_id">${u.isSuper ? '<option value="">No area</option>' : ''}${areaOpts}</select></div>
<div><label>Shop type</label><select name="type_id">${await typeOptions(null)}</select></div>
<div><label>Home delivery</label><select name="delivery"><option value="1">Yes</option><option value="0">No, pickup only</option></select></div><div><label>Shop location (optional: Maps link or lat,lng)</label><input name="loc"></div></div>
<p class="muted">The owner gets a WhatsApp welcome with the ${rs(cfg.SETUP_FEE)} setup-fee request.</p><button>Add shop</button></form></div>`, 'Shops'));
});
r.post('/shops', async (req, res) => {
  const u = req.u, b = req.body;
  const owner = String(b.owner || '').replace(/\D/g, '').length >= 10 ? cfg.norm(String(b.owner).replace(/\D/g, '').slice(-10)) : null;
  if (!b.name || !owner || !b.area) return back(res, '/panel/shops', 'Name, owner number and locality are required.');
  let areaId = b.area_id ? +b.area_id : null;
  if (!u.isSuper) { if (!u.areaIds.includes(areaId)) areaId = u.areaIds[0]; }
  const loc = parseLoc(b.loc);
  const typeId = b.type_id && await catalog.type(+b.type_id) ? +b.type_id : null;
  const s = await db.one('insert into shops(code,name,owner_phone,area,delivery,area_id,lat,lng,type_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',
    [await bot.mkCode(b.name), b.name.trim(), owner, b.area.trim(), b.delivery === '1', areaId, loc ? loc.lat : null, loc ? loc.lng : null, typeId]);
  await bot.ownerWelcome(s);
  if (!u.isSuper) await bot.notifyAdmins(`🏪 Area admin +${u.phone} added *${s.name}* (web panel).`);
  back(res, '/panel/shops/' + s.id, `${s.name} added. Welcome message sent to +${s.owner_phone}.`);
});
r.get('/shops/:id', async (req, res) => {
  const u = req.u, s = await db.shops.get(+req.params.id);
  if (!inScope(u, s)) return res.status(404).send(page(req, 'Not found', '<p>Shop not found in your area.</p>', 'Shops'));
  const ms = await db.shops.monthSales(s.id), stype = s.type_id ? await catalog.type(s.type_id) : null, cats = await catalog.categories(s.type_id);
  const order = await catalog.sortCats(s, [...new Set((await db.items.byShop(s.id)).map((i) => i.cat))]);
  const items = (await db.items.byShop(s.id)).sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || a.name.localeCompare(b.name));
  const areaOpts = (await areasFor(u)).map((a) => `<option value="${a.id}"${a.id === s.area_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  const okCat = (c) => !cats.length || cats.some((x) => x.name === c);
  const irows = items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.cat)}${okCat(i.cat) ? '' : ' <span class="tag y" title="Not in this shop type\'s categories">check</span>'}</td><td colspan="3"><form class="row" method="post" action="/panel/items/${i.id}"><input name="price" type="number" step="0.01" min="0" value="${i.price}" style="width:110px" aria-label="Price"><input name="stock" type="number" min="0" value="${i.stock}" style="width:90px" aria-label="Stock">${i.stock === 0 ? '<span class="tag r">Out</span>' : i.stock < 5 ? '<span class="tag y">Low</span>' : ''}<button class="sm ghost">Save</button></form></td>
<td><form class="in" method="post" action="/panel/items/${i.id}/delete" onsubmit="return confirm('Remove ${esc(i.name)}?')"><button class="sm warn">Remove</button></form></td></tr>`).join('');
  const recent = await db.all('select * from orders where shop_id=$1 order by id desc limit 10', [s.id]);
  res.send(page(req, s.name, `<h1>${esc(s.name)} <span class="muted">${s.code}${stype ? ' · ' + esc(stype.name) : ''}</span></h1>
<div class="kp"><div class="k"><small>Status</small><b>${!s.paid ? 'Fee pending' : s.active ? 'Live' : 'Paused'}</b></div><div class="k"><small>${MONTH()} sales</small><b>${rs(ms)}</b></div><div class="k"><small>${cfg.COMM * 100}% fee</small><b>${rs(ms * cfg.COMM)}</b></div><div class="k"><small>Items</small><b>${items.length}</b></div></div>
<div class="row" style="margin-bottom:12px">${!s.paid ? (req.u.isSuper ? `<form class="in" method="post" action="/panel/shops/${s.id}/paid"><button>Mark ${rs(cfg.SETUP_FEE)} setup fee received</button></form>` : `<form class="in" method="post" action="/panel/shops/${s.id}/plink"><button>Send ${rs(cfg.SETUP_FEE)} payment link</button></form>`) : ''}<a class="btn ghost" href="/panel/orders?shop=${s.id}">Orders</a></div>
<h2>Shop settings</h2><div class="card"><form method="post" action="/panel/shops/${s.id}"><div class="grid">
<div><label>Shop name</label><input name="name" value="${esc(s.name)}"></div><div><label>Owner WhatsApp</label><input name="owner" value="${esc(s.owner_phone.slice(2))}"></div><div><label>Street / locality</label><input name="area" value="${esc(s.area)}"></div>
<div><label>Area</label><select name="area_id">${u.isSuper ? `<option value="">No area</option>` : ''}${areaOpts}</select></div>
<div><label>Shop type (sets the item categories)</label><select name="type_id">${await typeOptions(s.type_id)}</select></div><div><label>Shop UPI ID</label><input name="upi" value="${esc(s.upi || '')}" placeholder="shop@okaxis"></div>
<div><label>Shop location (Maps link or lat,lng)</label><input name="loc" value="${s.lat != null ? s.lat + ',' + s.lng : ''}"></div>
<div><label>Home delivery</label><select name="delivery"><option value="1"${s.delivery ? ' selected' : ''}>Yes</option><option value="0"${s.delivery ? '' : ' selected'}>No, pickup only</option></select></div>
<div><label>Delivery charge (₹)</label><input name="del_fee" type="number" min="0" value="${s.del_fee}"></div><div><label>Min order for delivery (₹)</label><input name="min_order" type="number" min="0" value="${s.min_order}"></div>
${s.paid ? `<div><label>Shop status</label><select name="active"><option value="1"${s.active ? ' selected' : ''}>Live</option><option value="0"${s.active ? '' : ' selected'}>Paused</option></select></div>` : ''}</div><p></p><button>Save settings</button></form></div>
<h2>Items (${items.length})</h2><div class="tw"><table><tr><th>Item</th><th>Category</th><th colspan="3">Price (₹) · Stock</th><th></th></tr>${irows || '<tr><td colspan="6">No items yet.</td></tr>'}</table></div>
<h2 id="excel">Upload items from Excel</h2><div class="card">
<ol style="margin:0 0 10px;padding-left:20px;line-height:1.7"><li><a href="/panel/shops/${s.id}/items.xlsx"><b>Download this shop's Excel sheet</b></a>${items.length ? ` (has its ${items.length} items)` : ' (empty template)'}.</li>
<li>Fill or edit the columns <b>Name, Category, Price, Stock</b>.${cats.length ? ` The Category column has a drop-down of this shop type's categories.` : ''}</li><li>Upload it here. Items with the same name are updated; new names are added.</li></ol>
<form method="post" action="/panel/shops/${s.id}/upload" enctype="multipart/form-data"><input type="file" name="file" accept=".xlsx,.csv" required>
<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="replace" value="1" style="width:auto"> Remove items that are not in the file (full price-list replace)</label><p></p><button>Upload</button></form>
${cats.length ? `<p class="muted">Allowed categories for ${esc(stype.name)}: ${cats.map((c) => esc(c.name)).join(', ')}</p>` : '<p class="muted">This shop has no shop type, so any category name is accepted. Set a shop type above to use fixed categories.</p>'}</div>
<h2>Or paste items</h2><div class="card"><form method="post" action="/panel/shops/${s.id}/items"><label>One item per line: Name | Category | Price | Stock</label><textarea name="lines" placeholder="Ponni Rice 5kg | Rice &amp; Grains | 320 | 25&#10;Toor Dal 1kg | Pulses &amp; Dals | 165 | 30"></textarea><p class="muted">An existing item name is updated instead of duplicated.</p><button>Save items</button></form></div>
<h2>Recent orders</h2><div class="tw"><table><tr><th>#</th><th>Customer</th><th>Total</th><th>Mode</th><th>Status</th><th>Invoice</th></tr>${recent.map((o) => `<tr><td>${o.id}</td><td>${esc(o.cust_name)} +${o.cust_phone}</td><td>${rs(o.total)}</td><td>${o.mode === 'delivery' ? 'Delivery' : 'Pickup'}</td><td><span class="tag ${STAT[o.status] || 'y'}">${o.status}</span></td><td><a href="/inv/${o.token}.pdf" target="_blank">${o.inv}</a></td></tr>`).join('') || '<tr><td colspan="6">No orders yet.</td></tr>'}</table></div>`, 'Shops'));
});
r.post('/shops/:id', async (req, res) => {
  const u = req.u, s = await db.shops.get(+req.params.id); if (!inScope(u, s)) return back(res, '/panel/shops', 'Shop not found.');
  const b = req.body, loc = parseLoc(b.loc);
  const owner = String(b.owner || '').replace(/\D/g, '').length >= 10 ? cfg.norm(String(b.owner).replace(/\D/g, '').slice(-10)) : s.owner_phone;
  let areaId = b.area_id ? +b.area_id : null; if (!u.isSuper && !u.areaIds.includes(areaId)) areaId = s.area_id;
  const f = { name: (b.name || s.name).trim(), owner_phone: owner, area: (b.area || s.area).trim(), area_id: areaId, upi: /^[\w.\-]+@[\w.\-]+$/.test(String(b.upi || '').trim()) ? b.upi.trim() : s.upi,
    delivery: b.delivery === '1', del_fee: Math.max(0, Number(b.del_fee) || 0), min_order: Math.max(0, Number(b.min_order) || 0) };
  if (loc) { f.lat = loc.lat; f.lng = loc.lng; }
  if (b.type_id !== undefined) f.type_id = b.type_id && await catalog.type(+b.type_id) ? +b.type_id : null;
  if (s.paid && b.active != null) f.active = b.active === '1';
  const n = await db.shops.set(s.id, f);
  if (n.active !== s.active) await bot.notify(n.owner_phone, n.active ? `▶️ Your shop is live again on ${cfg.BRAND}.` : '⏸ Your shop has been paused by the admin. Contact admin to resume.');
  back(res, '/panel/shops/' + s.id, 'Settings saved.');
});
r.post('/shops/:id/plink', async (req, res) => {
  const s = await db.shops.get(+req.params.id); if (!inScope(req.u, s)) return back(res, '/panel/shops', 'Shop not found.');
  if (s.paid) return back(res, '/panel/shops/' + s.id, 'Setup fee was already received.');
  const p = await pay.createLink({ kind: 'setup', ref: s.id, amount: cfg.SETUP_FEE, description: `${cfg.BRAND} setup fee – ${s.name}`, phone: s.owner_phone, name: s.name });
  await bot.notify(s.owner_phone, `*Setup fee: ${rs(cfg.SETUP_FEE)}* (one-time)

${pay.payText(p)}

Your shop goes live as soon as payment is confirmed.`);
  back(res, '/panel/shops/' + s.id, `Payment link sent to ${s.name} on WhatsApp.`);
});
// Cash or direct UPI: only the main admin confirms. Zone admins send the payment link.
r.post('/shops/:id/paid', superOnly, async (req, res) => {
  const s = await db.shops.get(+req.params.id); if (!inScope(req.u, s)) return back(res, '/panel/shops', 'Shop not found.');
  const ok = await bot.activate(s);
  back(res, '/panel/shops/' + s.id, ok ? `${s.name} is now live. Owner notified on WhatsApp.` : 'Setup fee was already received.');
});
r.post('/shops/:id/items', async (req, res) => {
  const s = await db.shops.get(+req.params.id); if (!inScope(req.u, s)) return back(res, '/panel/shops', 'Shop not found.');
  const r2 = await catalog.importItems(s, catalog.parseLines(req.body.lines));
  res.send(resultPage(req, s, r2, 'Paste'));
});

// ---------- Excel: download a shop's sheet, upload it back
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.result != null) return cellText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return cellText(v.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v).trim();
}
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim()));
}
const HEAD = { name: ['name', 'item', 'itemname', 'product', 'productname', 'items'], cat: ['category', 'cat', 'section', 'group'], price: ['price', 'rate', 'sellingprice', 'mrp', 'amount', 'priceinr', 'price₹', 'sp'], stock: ['stock', 'qty', 'quantity', 'stockqty', 'available', 'inventory'] };
const hkey = (h) => String(h || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z₹]/g, '');
function rowsFromGrid(grid) {
  // find the header row in the first 10 rows
  for (let h = 0; h < Math.min(10, grid.length); h++) {
    const cols = {};
    grid[h].forEach((v, i) => { const k = hkey(v); for (const [f, names] of Object.entries(HEAD)) if (cols[f] == null && names.includes(k)) cols[f] = i; });
    if (cols.name != null && cols.price != null) {
      const out = [];
      for (let r = h + 1; r < grid.length; r++) {
        const g = grid[r]; if (!g || g.every((x) => !String(x || '').trim())) continue;
        out.push({ row: r + 1, name: g[cols.name], cat: cols.cat != null ? g[cols.cat] : '', price: g[cols.price], stock: cols.stock != null ? g[cols.stock] : '' });
      }
      return { rows: out };
    }
  }
  return { err: 'Could not find the header row. The first row must have the columns Name, Category, Price and Stock.' };
}
function resultPage(req, s, r2, source) {
  const ok = r2.added.length + r2.updated.length;
  return page(req, 'Items saved', `<h1>${esc(s.name)}: items ${source === 'Paste' ? 'pasted' : 'uploaded'}</h1>
<div class="kp"><div class="k"><small>Added</small><b>${r2.added.length}</b></div><div class="k"><small>Updated</small><b>${r2.updated.length}</b></div><div class="k"><small>Removed</small><b>${r2.removed}</b></div><div class="k"><small>Problems</small><b>${r2.errors.length}</b></div></div>
${r2.errors.length ? `<div class="card"><b>These rows were not saved</b> — fix them and upload again (rows already saved are fine):<ul>${r2.errors.slice(0, 100).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${r2.errors.length > 100 ? `<p class="muted">…and ${r2.errors.length - 100} more.</p>` : ''}${r2.allowed.length ? `<p class="muted">Allowed categories: ${r2.allowed.map(esc).join(', ')}</p>` : ''}${req.body && req.body.replace ? '<p class="muted">Because some rows had problems, no items were removed.</p>' : ''}</div>` : ''}
<div class="row"><a class="btn" href="/panel/shops/${s.id}">Back to ${esc(s.name)}</a>${ok ? `<a class="btn ghost" href="/panel/shops/${s.id}/items.xlsx">Download updated sheet</a>` : ''}</div>`, 'Shops');
}
r.get('/shops/:id/items.xlsx', async (req, res) => {
  const s = await db.shops.get(+req.params.id); if (!inScope(req.u, s)) return res.status(404).send('Not found');
  const cats = await catalog.categories(s.type_id), items = await db.items.byShop(s.id);
  const order = await catalog.sortCats(s, [...new Set(items.map((i) => i.cat))]);
  items.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || a.name.localeCompare(b.name));
  const wb = new ExcelJS.Workbook(); wb.creator = cfg.BRAND;
  const ws = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ header: 'Name', key: 'name', width: 38 }, { header: 'Category', key: 'cat', width: 26 }, { header: 'Price', key: 'price', width: 12 }, { header: 'Stock', key: 'stock', width: 10 }];
  ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF166534' } }; });
  items.forEach((i) => ws.addRow({ name: i.name, cat: i.cat, price: i.price, stock: i.stock }));
  if (!items.length) ws.addRow({ name: 'Example item 1kg', cat: cats[0] ? cats[0].name : 'Category', price: 100, stock: 10 });
  ws.getColumn('price').numFmt = '0.00';
  const last = Math.max(items.length + 1, 2) + 1000;
  for (let r = 2; r <= last; r++) {
    ws.getCell('C' + r).dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', formulae: [0], showErrorMessage: true, errorTitle: 'Price', error: 'Enter a price of 0 or more' };
    ws.getCell('D' + r).dataValidation = { type: 'whole', operator: 'greaterThanOrEqual', formulae: [0], showErrorMessage: true, errorTitle: 'Stock', error: 'Enter a whole number of 0 or more' };
  }
  if (cats.length) {
    const cs = wb.addWorksheet('Categories');
    cs.columns = [{ header: 'Allowed categories', key: 'n', width: 30 }];
    cs.getRow(1).font = { bold: true };
    cats.forEach((c) => cs.addRow({ n: c.name }));
    for (let r = 2; r <= last; r++) ws.getCell('B' + r).dataValidation = { type: 'list', allowBlank: false, formulae: [`Categories!$A$2:$A$${cats.length + 1}`], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Category', error: 'Pick a category from the list' };
  }
  const hs = wb.addWorksheet('How to');
  hs.getColumn(1).width = 100;
  [`${cfg.BRAND} item sheet for ${s.name}`, '', '1. One item per row on the Items sheet. Keep the header row as it is.', '2. Name: what customers see, e.g. "Toor Dal 1kg". Same name = the item is updated, not duplicated.',
    cats.length ? '3. Category: pick from the drop-down (list on the Categories sheet).' : '3. Category: any group name, e.g. Pulses.', '4. Price: selling price in rupees. Stock: how many are available now.', '5. Save as .xlsx and upload it on the shop page in the admin panel.']
    .forEach((t, i) => { const c = hs.getCell('A' + (i + 1)); c.value = t; if (i === 0) c.font = { bold: true, size: 13 }; });
  const fname = `${s.code}-items.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  await wb.xlsx.write(res); res.end();
});
r.post('/shops/:id/upload', (req, res, next) => upload.single('file')(req, res, (e) => {
  if (e) return back(res, '/panel/shops/' + req.params.id + '#excel', e.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB.' : 'Upload failed: ' + e.message);
  next();
}), async (req, res) => {
  const s = await db.shops.get(+req.params.id); if (!inScope(req.u, s)) return back(res, '/panel/shops', 'Shop not found.');
  const f = req.file; if (!f) return back(res, '/panel/shops/' + s.id + '#excel', 'Choose a file first.');
  const ext = (f.originalname.split('.').pop() || '').toLowerCase();
  let grid;
  try {
    if (ext === 'csv') grid = parseCsv(f.buffer.toString('utf8').replace(/^\uFEFF/, ''));
    else if (ext === 'xlsx') {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(f.buffer);
      const ws = wb.getWorksheet('Items') || wb.worksheets[0];
      grid = []; ws.eachRow({ includeEmpty: true }, (row, n) => { grid[n - 1] = []; row.eachCell({ includeEmpty: true }, (c, col) => { grid[n - 1][col - 1] = cellText(c.value); }); });
      grid = Array.from(grid, (r) => r || []);
    } else return back(res, '/panel/shops/' + s.id + '#excel', 'Please upload an .xlsx or .csv file. (Old .xls: open it in Excel and Save As .xlsx.)');
  } catch (e) { return back(res, '/panel/shops/' + s.id + '#excel', 'Could not read the file. Is it a real Excel (.xlsx) file?'); }
  const g = rowsFromGrid(grid);
  if (g.err) return back(res, '/panel/shops/' + s.id + '#excel', g.err);
  if (!g.rows.length) return back(res, '/panel/shops/' + s.id + '#excel', 'The file has no item rows under the header.');
  if (g.rows.length > 5000) return back(res, '/panel/shops/' + s.id + '#excel', 'Too many rows (max 5,000 per upload).');
  const r2 = await catalog.importItems(s, g.rows, { replace: req.body.replace === '1' });
  res.send(resultPage(req, s, r2, 'Excel'));
});
r.post('/items/:id', async (req, res) => {
  const i = await db.items.get(+req.params.id); const s = i && await db.shops.get(i.shop_id);
  if (!inScope(req.u, s)) return back(res, '/panel/shops', 'Item not found.');
  await db.q('update items set price=$2, stock=$3 where id=$1', [i.id, Math.max(0, Number(req.body.price) || 0), Math.max(0, parseInt(req.body.stock, 10) || 0)]);
  back(res, '/panel/shops/' + s.id, `${i.name} updated.`);
});
r.post('/items/:id/delete', async (req, res) => {
  const i = await db.items.get(+req.params.id); const s = i && await db.shops.get(i.shop_id);
  if (!inScope(req.u, s)) return back(res, '/panel/shops', 'Item not found.');
  await db.q('delete from items where id=$1', [i.id]);
  back(res, '/panel/shops/' + s.id, `${i.name} removed.`);
});

// ---------- shop types and categories (main admin)
r.get('/catalog', superOnly, async (req, res) => {
  const ts = await catalog.types(true); let cards = '';
  for (const t of ts) {
    const cats = await catalog.categories(t.id);
    cards += `<div class="card" id="t${t.id}"><form method="post" action="/panel/catalog/${t.id}"><div class="grid"><div><label>Shop type name</label><input name="name" value="${esc(t.name)}" required></div>
<div><label>Order in lists</label><input name="sort" type="number" value="${t.sort}"></div><div><label>Status</label><select name="active"><option value="1"${t.active ? ' selected' : ''}>Active</option><option value="0"${t.active ? '' : ' selected'}>Hidden for new shops</option></select></div>
<div><label>Shops of this type</label><input value="${t.shops}" disabled></div></div>
<label>Item categories — one per line, in the order customers see them</label><textarea name="cats" rows="${Math.max(5, cats.length + 1)}">${esc(cats.map((c) => c.name).join('\n'))}</textarea>
<p class="muted">Items must use one of these categories (upper/lower case and "&amp;" vs "and" don't matter). Renaming a category doesn't move existing items — re-upload the shop's Excel.</p>
<div class="row"><button class="sm">Save ${esc(t.name)}</button></div></form>
${t.shops ? '' : `<form method="post" action="/panel/catalog/${t.id}/delete" onsubmit="return confirm('Delete shop type ${esc(t.name)}?')" style="margin-top:8px"><button class="sm warn">Delete type</button></form>`}</div>`;
  }
  res.send(page(req, 'Shop types', `<h1>Shop types & item categories</h1><p class="muted">Each shop has a type. The type decides which item categories the shop can use, on WhatsApp, the website and Excel uploads.</p>
${cards || '<p>No shop types yet.</p>'}<h2 id="new">Add a shop type</h2><div class="card"><form method="post" action="/panel/catalog"><div class="grid"><div><label>Shop type name</label><input name="name" required placeholder="e.g. Sweets & Snacks"></div></div>
<label>Item categories — one per line</label><textarea name="cats" placeholder="Sweets&#10;Namkeen&#10;Others"></textarea><p></p><button>Add shop type</button></form></div>`, 'Shop types'));
});
r.post('/catalog', superOnly, async (req, res) => {
  const name = String(req.body.name || '').trim(); if (!name) return back(res, '/panel/catalog', 'Name is required.');
  if (await db.one('select 1 from shop_types where lower(name)=lower($1)', [name])) return back(res, '/panel/catalog', `${name} already exists.`);
  const max = (await db.one('select coalesce(max(sort),0)::int m from shop_types')).m;
  const t = await db.one('insert into shop_types(name,sort) values($1,$2) returning *', [name, max + 1]);
  const cats = await catalog.setCategories(t.id, String(req.body.cats || '').split('\n'));
  back(res, '/panel/catalog#t' + t.id, `${t.name} added with ${cats.length} categories.`);
});
r.post('/catalog/:id', superOnly, async (req, res) => {
  const t = await catalog.type(+req.params.id); if (!t) return back(res, '/panel/catalog', 'Not found.');
  const name = String(req.body.name || t.name).trim();
  if (await db.one('select 1 from shop_types where lower(name)=lower($1) and id<>$2', [name, t.id])) return back(res, '/panel/catalog#t' + t.id, `Another type is already called ${name}.`);
  await db.q('update shop_types set name=$2, sort=$3, active=$4 where id=$1', [t.id, name, parseInt(req.body.sort, 10) || 0, req.body.active !== '0']);
  const cats = await catalog.setCategories(t.id, String(req.body.cats || '').split('\n'));
  const stray = (await db.one(`select count(*)::int n from items i join shops s on s.id=i.shop_id where s.type_id=$1 and not (i.cat = any($2))`, [t.id, cats])).n;
  back(res, '/panel/catalog#t' + t.id, `${name} saved (${cats.length} categories).${stray ? ` ${stray} existing item(s) in these shops use other categories — they still show, marked "check" on the shop page.` : ''}`);
});
r.post('/catalog/:id/delete', superOnly, async (req, res) => {
  const t = await catalog.type(+req.params.id); if (!t) return back(res, '/panel/catalog', 'Not found.');
  if ((await db.one('select count(*)::int n from shops where type_id=$1', [t.id])).n) return back(res, '/panel/catalog', 'Move its shops to another type first.');
  await db.q('delete from shop_types where id=$1', [t.id]);
  back(res, '/panel/catalog', `${t.name} deleted.`);
});

// ---------- orders
const NEXT = (o) => o.status === 'New' ? [['Accepted', 'Accept'], ['Cancelled', 'Reject']] : o.status === 'Accepted' ? [['Ready', 'Mark ready']]
  : o.status === 'Ready' ? (o.mode === 'pickup' ? [['Completed', 'Picked up']] : [['Out for delivery', 'Dispatch']]) : o.status === 'Out for delivery' ? [['Completed', 'Delivered']] : [];
r.get('/orders', async (req, res) => {
  const shops = await shopsFor(req.u), ids = shops.map((s) => s.id), names = Object.fromEntries(shops.map((s) => [s.id, s.name]));
  const st = req.query.status || 'open', shop = req.query.shop ? +req.query.shop : null;
  let list = ids.length ? await db.all(`select * from orders where shop_id = any($1) order by id desc limit 300`, [shop && ids.includes(shop) ? [shop] : ids]) : [];
  if (st === 'open') list = list.filter((o) => !['Completed', 'Cancelled'].includes(o.status)); else if (st !== 'all') list = list.filter((o) => o.status === st);
  const tabs = [['open', 'Open'], ['New', 'New'], ['Ready', 'Ready'], ['Out for delivery', 'Out for delivery'], ['Completed', 'Completed'], ['Cancelled', 'Cancelled'], ['all', 'All']]
    .map(([v, n]) => `<a class="btn ${st === v ? '' : 'ghost'} sm" href="/panel/orders?status=${encodeURIComponent(v)}${shop ? '&shop=' + shop : ''}">${n}</a>`).join(' ');
  const rows = list.map((o) => `<tr><td>${o.id}</td><td>${new Date(o.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(names[o.shop_id])}</td><td>${esc(o.cust_name)}<br><span class="muted">+${o.cust_phone}</span></td>
<td>${o.lines.map((l) => `${l.q}× ${esc(l.name)}`).join('<br>')}</td><td>${rs(o.total)}<br><span class="muted">${o.paid ? 'Paid' : o.pay === 'UPI' ? 'UPI – verify' : 'Cash due'}</span></td><td>${o.mode === 'delivery' ? 'Delivery<br><span class="muted">' + esc(o.addr) + '</span>' : 'Pickup'}</td>
<td><span class="tag ${STAT[o.status] || 'y'}">${o.status}</span></td><td class="row">${NEXT(o).map(([to, n]) => `<form class="in" method="post" action="/panel/orders/${o.id}/status"><input type="hidden" name="to" value="${esc(to)}"><button class="sm ${to === 'Cancelled' ? 'warn' : ''}">${n}</button></form>`).join('')}<a href="/inv/${o.token}.pdf" target="_blank">Invoice</a></td></tr>`).join('');
  res.send(page(req, 'Orders', `<h1>Orders</h1><div class="row" style="margin-bottom:10px">${tabs}</div><div class="tw"><table><tr><th>#</th><th>Time</th><th>Shop</th><th>Customer</th><th>Items</th><th>Total</th><th>Mode</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="9">No orders here.</td></tr>'}</table></div>
<p class="muted">Each status change messages the customer (and rider/area admin) on WhatsApp automatically.</p>`, 'Orders'));
});
r.post('/orders/:id/status', async (req, res) => {
  const o = await db.orders.get(+req.params.id); const s = o && await db.shops.get(o.shop_id);
  if (!inScope(req.u, s)) return back(res, '/panel/orders', 'Order not found.');
  const allowed = NEXT(o).map(([t]) => t);
  if (!allowed.includes(req.body.to)) return back(res, '/panel/orders', `Order #${o.id} is already ${o.status}.`);
  await bot.setStatus(o, req.body.to);
  back(res, '/panel/orders', `Order #${o.id} → ${req.body.to}. Customer notified.`);
});

// ---------- bills & payments (main admin)
r.get('/bills', superOnly, async (req, res) => {
  const mk = bot.PREV_MONTH_KEY(), shops = (await db.shops.all()).filter((s) => s.paid); let rows = '', tot = 0;
  for (const s of shops) {
    const ms = await db.shops.salesIn(s.id, mk), b = await db.one(`select status from payments where kind='bill' and ref=$1 and month=$2 and status not in ('cancelled') order by id desc limit 1`, [s.id, mk]);
    tot += ms * cfg.COMM; rows += `<tr><td>${esc(s.name)}</td><td>+${s.owner_phone}</td><td>${rs(ms)}</td><td>${rs(ms * cfg.COMM)}</td><td>${b ? `<span class="tag ${b.status === 'paid' ? 'g' : 'y'}">${b.status === 'created' ? 'sent' : b.status}</span>` : '—'}</td></tr>`;
  }
  const pays = await db.all(`select p.*, s.name, a.name zone from payments p left join shops s on s.id=p.ref left join areas a on a.id=coalesce(p.area_id, s.area_id) where p.status<>'cancelled' order by p.id desc limit 60`);
  const act = (p) => p.status === 'created' ? `<form class="in" method="post" action="/panel/payments/${p.id}/confirm" onsubmit="return confirm('Did ${rs(p.amount)} really reach your UPI account?')"><button class="sm">Mark paid</button></form>`
    : p.status === 'paid' ? `<form class="in" method="post" action="/panel/payments/${p.id}/refund" onsubmit="return confirm('Refund ${rs(p.amount)}? Commission on it will be taken back.')"><button class="sm warn">Refunded</button></form>` : '';
  res.send(page(req, 'Bills', `<h1>${bot.MONTH_NAME(mk)} bills</h1><p class="muted">Bills for last month go out automatically on the 1st (10 AM), with reminders on the 5th and 10th. Each shop is billed once a month.</p><div class="tw"><table><tr><th>Shop</th><th>Owner</th><th>Sales</th><th>${cfg.COMM * 100}% fee</th><th>Bill</th></tr>${rows || '<tr><td colspan="5">No live shops.</td></tr>'}<tr><th colspan="3">Total</th><th>${rs(tot)}</th><th></th></tr></table></div><p></p>
<form method="post" action="/panel/bills" onsubmit="return confirm('Send ${bot.MONTH_NAME(mk)} bills to every shop not billed yet?')"><button>Send ${bot.MONTH_NAME(mk)} bills now</button></form>
<p class="muted">Shops pay ${cfg.RZP_KEY ? 'by Razorpay link (confirms by itself)' : 'to ' + esc(cfg.ADMIN_UPI || 'your UPI ID')}. Mark a payment paid only after the money is in your account.</p>
<h2>Payments</h2><div class="tw"><table><tr><th>#</th><th>Type</th><th>Shop</th><th>Zone</th><th>Amount</th><th>Status</th><th>Date</th><th></th></tr>${pays.map((p) => `<tr><td>${p.id}</td><td>${p.kind === 'setup' ? 'Setup fee' : 'Bill ' + esc(p.month || '')}</td><td>${esc(p.name)}</td><td>${esc(p.zone || '—')}</td><td>${rs(p.amount)}</td><td><span class="tag ${p.status === 'paid' ? 'g' : p.status === 'refunded' ? 'r' : 'y'}">${p.status === 'created' ? 'waiting' : p.status}</span></td><td>${new Date(p.paid_at || p.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td><td>${act(p)}</td></tr>`).join('') || '<tr><td colspan="8">None yet.</td></tr>'}</table></div>`, 'Bills'));
});
r.post('/bills', superOnly, async (req, res) => { const n = await bot.sendBills(); back(res, '/panel/bills', `Bills sent to ${n} shop(s) on WhatsApp.`); });
r.post('/payments/:id/confirm', superOnly, async (req, res) => { const p = await bot.confirmPayment(+req.params.id); back(res, '/panel/bills', p ? `${rs(p.amount)} confirmed. Commission added.` : 'Already handled.'); });
r.post('/payments/:id/refund', superOnly, async (req, res) => { const p = await bot.refundPayment(+req.params.id); back(res, '/panel/bills', p ? `${rs(p.amount)} marked refunded. Commission taken back.` : 'Not a paid payment.'); });

module.exports = r;
