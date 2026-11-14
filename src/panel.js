// Web admin panel: /panel. Main admins and area admins log in with a one-time
// code sent by the bot on WhatsApp. Area admins only see their own areas.
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const bot = require('./bot');

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
  if (!isSuper && !myAreas.length) return null;
  return { phone, isSuper, myAreas, areaIds: myAreas.map((a) => a.id) };
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
  const nav = u ? [['', 'Dashboard'], ...(u.isSuper ? [['/areas', 'Areas']] : []), ['/shops', 'Shops'], ['/orders', 'Orders'], ...(u.isSuper ? [['/bills', 'Bills']] : [])]
    .map(([p, n]) => `<a href="/panel${p}" class="${tab === n ? 'on' : ''}">${n}</a>`).join('') : '';
  const msg = req.query && req.query.m ? `<div class="msg">${esc(req.query.m)}</div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} – ${esc(cfg.BRAND)} admin</title><style>${CSS}</style></head><body>
<header><b>${esc(cfg.BRAND)} admin</b><nav>${nav}</nav>${u ? `<span class="me">${u.isSuper ? 'Main admin' : 'Area admin · ' + esc(u.myAreas.map((a) => a.name).join(', '))} · +${u.phone} · <a href="/panel/logout" style="color:#fff">Log out</a></span>` : ''}</header>
<main>${msg}${body}</main></body></html>`;
}
const STAT = { New: 'y', Accepted: 'b', Ready: 'b', 'Out for delivery': 'b', Completed: 'g', Cancelled: 'r' };

// ---------- login with WhatsApp code
r.get('/login', (req, res) => res.send(page(req, 'Log in', `<div class="login card"><h1>Admin log in</h1>
<form method="post" action="/panel/login"><label>Your WhatsApp number</label><input name="phone" inputmode="tel" placeholder="9003264537" required>
<p class="muted">We'll send a 6-digit code to this number from ${esc(cfg.BRAND)} on WhatsApp.</p><button>Send code</button></form></div>`)));
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

// ---------- helpers
async function shopsFor(u) { const all = await db.shops.all(); return u.isSuper ? all : all.filter((s) => u.areaIds.includes(s.area_id)); }
async function areasFor(u) { return u.isSuper ? db.areas.all() : u.myAreas; }
const parseLoc = (t) => { const m = String(t || '').match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/); return m ? { lat: +m[1], lng: +m[2] } : null; };

// ---------- dashboard
r.get('/', async (req, res) => {
  const u = req.u, shops = await shopsFor(u);
  let gmv = 0; for (const s of shops) { s.ms = await db.shops.monthSales(s.id); gmv += s.ms; }
  const ids = shops.map((s) => s.id);
  const open = ids.length ? (await db.one(`select count(*)::int n from orders where shop_id = any($1) and status not in ('Completed','Cancelled')`, [ids])).n : 0;
  const today = ids.length ? await db.one(`select count(*)::int n, coalesce(sum(subtotal),0) s from orders where shop_id = any($1) and status<>'Cancelled' and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`, [ids]) : { n: 0, s: 0 };
  let areaShare = 0, areaSetup = 0;
  for (const a of await areasFor(u)) { const x = await bot.areaMoney(a); areaShare += x.commArea; areaSetup += x.setupArea; }
  const setup = shops.filter((s) => s.paid).length * cfg.SETUP_FEE, comm = gmv * cfg.COMM;
  const k = (t, v) => `<div class="k"><small>${t}</small><b>${v}</b></div>`;
  const kp = u.isSuper
    ? k('Live shops', `${shops.filter((s) => s.paid && s.active).length} / ${shops.length}`) + k(`${MONTH()} shop sales`, rs(gmv)) + k(`${cfg.COMM * 100}% commission`, rs(comm)) + k('Setup fees (all time)', rs(setup)) + k('Payable to area admins', rs(areaShare + areaSetup)) + k('Your net', rs(comm - areaShare + setup - areaSetup)) + k('Today', `${today.n} orders · ${rs(today.s)}`) + k('Open orders', open)
    : k('Live shops', `${shops.filter((s) => s.paid && s.active).length} / ${shops.length}`) + k(`${MONTH()} shop sales`, rs(gmv)) + k('Your 1% share', rs(areaShare)) + k('Your setup-fee share', rs(areaSetup)) + k('Today', `${today.n} orders · ${rs(today.s)}`) + k('Open orders', open);
  const rows = shops.sort((a, b) => b.ms - a.ms).slice(0, 10).map((s) => `<tr><td><a href="/panel/shops/${s.id}">${esc(s.name)}</a></td><td>${esc(s.area)}</td><td>${!s.paid ? '<span class="tag y">Fee pending</span>' : s.active ? '<span class="tag g">Live</span>' : '<span class="tag r">Paused</span>'}</td><td>${rs(s.ms)}</td></tr>`).join('');
  res.send(page(req, 'Dashboard', `<h1>Dashboard — ${MONTH()}</h1><div class="kp">${kp}</div>
<div class="row" style="margin-bottom:14px"><a class="btn" href="/panel/shops#new">+ Add shop</a>${u.isSuper ? '<a class="btn ghost" href="/panel/areas#new">+ Add area</a>' : ''}<a class="btn ghost" href="/panel/orders?status=open">Open orders (${open})</a></div>
<h2>Top shops this month</h2><div class="tw"><table><tr><th>Shop</th><th>Locality</th><th>Status</th><th>Month sales</th></tr>${rows || '<tr><td colspan="4">No shops yet.</td></tr>'}</table></div>`, 'Dashboard'));
});

// ---------- areas (main admin)
r.get('/areas', superOnly, async (req, res) => {
  const areas = await db.areas.all(); let rows = '';
  for (const a of areas) {
    const x = await bot.areaMoney(a);
    rows += `<tr><td><b>${esc(a.name)}</b></td><td>${a.admin_phone ? '+' + a.admin_phone : '—'}</td><td>${a.lat != null ? `${a.radius_km} km` : '<span class="tag y">no location</span>'}</td><td>${x.shops}</td><td>${rs(x.sales)}</td><td>${rs(x.commArea + x.setupArea)}</td><td>${a.active ? '<span class="tag g">Active</span>' : '<span class="tag r">Paused</span>'}</td>
<td><details><summary>Edit</summary><form method="post" action="/panel/areas/${a.id}"><div class="grid"><div><label>Name</label><input name="name" value="${esc(a.name)}"></div><div><label>Area admin WhatsApp (blank = none)</label><input name="admin" value="${a.admin_phone ? esc(a.admin_phone.slice(2)) : ''}"></div>
<div><label>Centre (Google Maps link or lat,lng)</label><input name="loc" value="${a.lat != null ? a.lat + ',' + a.lng : ''}"></div><div><label>Radius (km)</label><input name="radius" type="number" step="0.5" min="0.5" value="${a.radius_km}"></div>
<div><label>Setup-fee share (%)</label><input name="setup_share" type="number" min="0" max="100" value="${Math.round(a.setup_share * 100)}"></div><div><label>Sales share (%)</label><input name="comm_pct" type="number" step="0.1" min="0" max="${cfg.COMM * 100}" value="${a.comm_pct}"></div>
<div><label>Status</label><select name="active"><option value="1"${a.active ? ' selected' : ''}>Active</option><option value="0"${a.active ? '' : ' selected'}>Paused</option></select></div></div><p></p><button class="sm">Save</button></form></details></td></tr>`;
  }
  res.send(page(req, 'Areas', `<h1>Areas & area admins</h1><div class="tw"><table><tr><th>Area</th><th>Area admin</th><th>Radius</th><th>Shops</th><th>${MONTH()} sales</th><th>Admin share</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="8">No areas yet.</td></tr>'}</table></div>
<h2 id="new">Add area</h2><div class="card"><form method="post" action="/panel/areas"><div class="grid"><div><label>Area name</label><input name="name" required placeholder="KK Nagar"></div><div><label>Area admin WhatsApp (optional)</label><input name="admin" placeholder="9xxxxxxxxx"></div>
<div><label>Centre (Google Maps link or lat,lng)</label><input name="loc" placeholder="13.0400, 80.2000"></div><div><label>Radius (km)</label><input name="radius" type="number" step="0.5" min="0.5" value="3"></div></div>
<p class="muted">Tip: in Google Maps, long-press the centre of the area and copy the coordinates shown at the top.</p><button>Create area</button></form></div>`, 'Areas'));
});
r.post('/areas', superOnly, async (req, res) => {
  const b = req.body, loc = parseLoc(b.loc), admin = b.admin && b.admin.replace(/\D/g, '').length >= 10 ? cfg.norm(b.admin) : null;
  if (!String(b.name || '').trim()) return back(res, '/panel/areas', 'Area name is required.');
  const a = await db.one('insert into areas(name,admin_phone,lat,lng,radius_km) values($1,$2,$3,$4,$5) returning *', [b.name.trim(), admin, loc ? loc.lat : null, loc ? loc.lng : null, Number(b.radius) || cfg.DEFAULT_RADIUS_KM]);
  if (a.admin_phone) await bot.newAreaAdminWelcome(a);
  back(res, '/panel/areas', `Area ${a.name} created.${a.admin_phone ? ' Area admin notified on WhatsApp.' : ''}`);
});
r.post('/areas/:id', superOnly, async (req, res) => {
  const a0 = await db.areas.get(+req.params.id); if (!a0) return back(res, '/panel/areas', 'Area not found.');
  const b = req.body, loc = parseLoc(b.loc), admin = b.admin && b.admin.replace(/\D/g, '').length >= 10 ? cfg.norm(b.admin) : null;
  const a = await db.areas.set(a0.id, { name: (b.name || a0.name).trim(), admin_phone: admin, lat: loc ? loc.lat : a0.lat, lng: loc ? loc.lng : a0.lng, radius_km: Number(b.radius) || a0.radius_km,
    setup_share: Math.min(100, Math.max(0, Number(b.setup_share))) / 100, comm_pct: Math.min(cfg.COMM * 100, Math.max(0, Number(b.comm_pct))), active: b.active === '1' });
  if (a.admin_phone && a.admin_phone !== a0.admin_phone) await bot.newAreaAdminWelcome(a);
  back(res, '/panel/areas', `${a.name} saved.`);
});

// ---------- shops
r.get('/shops', async (req, res) => {
  const u = req.u, shops = await shopsFor(u), areas = Object.fromEntries((await db.areas.all()).map((a) => [a.id, a]));
  const q = String(req.query.q || '').toLowerCase();
  let rows = '';
  for (const s of shops.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.area || '').toLowerCase().includes(q) || x.owner_phone.includes(q))) {
    const ms = await db.shops.monthSales(s.id);
    const n = (await db.one('select count(*)::int c, count(*) filter (where stock<5)::int low from items where shop_id=$1', [s.id]));
    rows += `<tr><td><a href="/panel/shops/${s.id}"><b>${esc(s.name)}</b></a> <span class="muted">${s.code}</span></td><td>${esc(s.area)}${s.area_id && areas[s.area_id] ? `<br><span class="muted">${esc(areas[s.area_id].name)}</span>` : ''}</td><td>+${s.owner_phone}</td>
<td>${!s.paid ? '<span class="tag y">Fee pending</span>' : s.active ? '<span class="tag g">Live</span>' : '<span class="tag r">Paused</span>'}</td><td>${s.delivery ? 'Yes · ' + rs(s.del_fee) : 'Pickup only'}</td><td>${n.c}${n.low ? ` <span class="tag y">${n.low} low</span>` : ''}</td><td>${s.lat != null ? '✓' : '<span class="tag y">not set</span>'}</td><td>${rs(ms)}</td>
<td class="row">${!s.paid ? `<form class="in" method="post" action="/panel/shops/${s.id}/paid"><button class="sm">Mark ${rs(cfg.SETUP_FEE)} paid</button></form>` : ''}<a class="btn ghost sm" href="/panel/shops/${s.id}">Open</a></td></tr>`;
  }
  const areaOpts = (await areasFor(u)).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  res.send(page(req, 'Shops', `<h1>Shops</h1><form class="row" method="get" style="margin-bottom:10px"><input name="q" value="${esc(req.query.q || '')}" placeholder="Search name, locality or phone" style="max-width:320px"><button class="ghost">Search</button></form>
<div class="tw"><table><tr><th>Shop</th><th>Locality / area</th><th>Owner</th><th>Status</th><th>Delivery</th><th>Items</th><th>Location</th><th>${MONTH()} sales</th><th></th></tr>${rows || '<tr><td colspan="9">No shops yet.</td></tr>'}</table></div>
<h2 id="new">Add shop</h2><div class="card"><form method="post" action="/panel/shops"><div class="grid"><div><label>Shop name</label><input name="name" required></div><div><label>Owner WhatsApp number</label><input name="owner" required placeholder="9xxxxxxxxx"></div>
<div><label>Street / locality (shown to customers)</label><input name="area" required></div><div><label>Area</label><select name="area_id">${u.isSuper ? '<option value="">No area</option>' : ''}${areaOpts}</select></div>
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
  const s = await db.one('insert into shops(code,name,owner_phone,area,delivery,area_id,lat,lng) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',
    [await bot.mkCode(b.name), b.name.trim(), owner, b.area.trim(), b.delivery === '1', areaId, loc ? loc.lat : null, loc ? loc.lng : null]);
  await bot.ownerWelcome(s);
  if (!u.isSuper) await bot.notifyAdmins(`🏪 Area admin +${u.phone} added *${s.name}* (web panel).`);
  back(res, '/panel/shops/' + s.id, `${s.name} added. Welcome message sent to +${s.owner_phone}.`);
});
r.get('/shops/:id', async (req, res) => {
  const u = req.u, s = await db.shops.get(+req.params.id);
  if (!inScope(u, s)) return res.status(404).send(page(req, 'Not found', '<p>Shop not found in your area.</p>', 'Shops'));
  const items = await db.items.byShop(s.id), ms = await db.shops.monthSales(s.id);
  const areaOpts = (await areasFor(u)).map((a) => `<option value="${a.id}"${a.id === s.area_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  const irows = items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.cat)}</td><td colspan="3"><form class="row" method="post" action="/panel/items/${i.id}"><input name="price" type="number" step="0.01" min="0" value="${i.price}" style="width:110px" aria-label="Price"><input name="stock" type="number" min="0" value="${i.stock}" style="width:90px" aria-label="Stock">${i.stock === 0 ? '<span class="tag r">Out</span>' : i.stock < 5 ? '<span class="tag y">Low</span>' : ''}<button class="sm ghost">Save</button></form></td>
<td><form class="in" method="post" action="/panel/items/${i.id}/delete" onsubmit="return confirm('Remove ${esc(i.name)}?')"><button class="sm warn">Remove</button></form></td></tr>`).join('');
  const recent = await db.all('select * from orders where shop_id=$1 order by id desc limit 10', [s.id]);
  res.send(page(req, s.name, `<h1>${esc(s.name)} <span class="muted">${s.code}</span></h1>
<div class="kp"><div class="k"><small>Status</small><b>${!s.paid ? 'Fee pending' : s.active ? 'Live' : 'Paused'}</b></div><div class="k"><small>${MONTH()} sales</small><b>${rs(ms)}</b></div><div class="k"><small>${cfg.COMM * 100}% fee</small><b>${rs(ms * cfg.COMM)}</b></div><div class="k"><small>Items</small><b>${items.length}</b></div></div>
<div class="row" style="margin-bottom:12px">${!s.paid ? `<form class="in" method="post" action="/panel/shops/${s.id}/paid"><button>Mark ${rs(cfg.SETUP_FEE)} setup fee received</button></form>` : ''}<a class="btn ghost" href="/panel/orders?shop=${s.id}">Orders</a></div>
<h2>Shop settings</h2><div class="card"><form method="post" action="/panel/shops/${s.id}"><div class="grid">
<div><label>Shop name</label><input name="name" value="${esc(s.name)}"></div><div><label>Owner WhatsApp</label><input name="owner" value="${esc(s.owner_phone.slice(2))}"></div><div><label>Street / locality</label><input name="area" value="${esc(s.area)}"></div>
<div><label>Area</label><select name="area_id">${u.isSuper ? `<option value="">No area</option>` : ''}${areaOpts}</select></div><div><label>Shop UPI ID</label><input name="upi" value="${esc(s.upi || '')}" placeholder="shop@okaxis"></div>
<div><label>Shop location (Maps link or lat,lng)</label><input name="loc" value="${s.lat != null ? s.lat + ',' + s.lng : ''}"></div>
<div><label>Home delivery</label><select name="delivery"><option value="1"${s.delivery ? ' selected' : ''}>Yes</option><option value="0"${s.delivery ? '' : ' selected'}>No, pickup only</option></select></div>
<div><label>Delivery charge (₹)</label><input name="del_fee" type="number" min="0" value="${s.del_fee}"></div><div><label>Min order for delivery (₹)</label><input name="min_order" type="number" min="0" value="${s.min_order}"></div>
${s.paid ? `<div><label>Shop status</label><select name="active"><option value="1"${s.active ? ' selected' : ''}>Live</option><option value="0"${s.active ? '' : ' selected'}>Paused</option></select></div>` : ''}</div><p></p><button>Save settings</button></form></div>
<h2>Items (${items.length})</h2><div class="tw"><table><tr><th>Item</th><th>Category</th><th colspan="3">Price (₹) · Stock</th><th></th></tr>${irows || '<tr><td colspan="6">No items yet.</td></tr>'}</table></div>
<h2>Add or update items in bulk</h2><div class="card"><form method="post" action="/panel/shops/${s.id}/items"><label>One item per line: Name | Category | Price | Stock</label><textarea name="lines" placeholder="Ponni Rice 5kg | Rice &amp; Grains | 320 | 25&#10;Toor Dal 1kg | Pulses | 165 | 30"></textarea><p class="muted">An existing item name is updated instead of duplicated.</p><button>Save items</button></form></div>
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
  if (s.paid && b.active != null) f.active = b.active === '1';
  const n = await db.shops.set(s.id, f);
  if (n.active !== s.active) await bot.notify(n.owner_phone, n.active ? `▶️ Your shop is live again on ${cfg.BRAND}.` : '⏸ Your shop has been paused by the admin. Contact admin to resume.');
  back(res, '/panel/shops/' + s.id, 'Settings saved.');
});
r.post('/shops/:id/paid', async (req, res) => {
  const s = await db.shops.get(+req.params.id); if (!inScope(req.u, s)) return back(res, '/panel/shops', 'Shop not found.');
  const ok = await bot.activate(s);
  back(res, '/panel/shops/' + s.id, ok ? `${s.name} is now live. Owner notified on WhatsApp.` : 'Setup fee was already received.');
});
r.post('/shops/:id/items', async (req, res) => {
  const s = await db.shops.get(+req.params.id); if (!inScope(req.u, s)) return back(res, '/panel/shops', 'Shop not found.');
  const list = await db.items.byShop(s.id); let ok = 0; const bad = [];
  for (const line of String(req.body.lines || '').split(/\n|;/).map((x) => x.trim()).filter(Boolean)) {
    const p = line.split('|').map((x) => x.trim()); const price = parseFloat(p[2]), stock = parseInt(p[3], 10);
    if (p.length < 3 || !p[0] || !p[1] || isNaN(price) || price < 0) { bad.push(line); continue; }
    const cat = (list.find((i) => i.cat.toLowerCase() === p[1].toLowerCase()) || { cat: p[1] }).cat;
    const ex = list.find((i) => i.name.toLowerCase() === p[0].toLowerCase());
    if (ex) await db.q('update items set cat=$2, price=$3, stock=$4 where id=$1', [ex.id, cat, price, isNaN(stock) ? ex.stock : stock]);
    else list.push(await db.one('insert into items(shop_id,name,cat,price,stock) values($1,$2,$3,$4,$5) returning *', [s.id, p[0], cat, price, isNaN(stock) ? 0 : stock]));
    ok++;
  }
  back(res, '/panel/shops/' + s.id, `${ok} item(s) saved.${bad.length ? ` ${bad.length} line(s) skipped — use Name | Category | Price | Stock.` : ''}`);
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

// ---------- bills (main admin)
r.get('/bills', superOnly, async (req, res) => {
  const shops = (await db.shops.all()).filter((s) => s.paid); let rows = '', tot = 0;
  for (const s of shops) { const ms = await db.shops.monthSales(s.id); tot += ms * cfg.COMM; rows += `<tr><td>${esc(s.name)}</td><td>+${s.owner_phone}</td><td>${rs(ms)}</td><td>${rs(ms * cfg.COMM)}</td></tr>`; }
  const pays = await db.all(`select p.*, s.name from payments p left join shops s on s.id=p.ref order by p.id desc limit 30`);
  res.send(page(req, 'Bills', `<h1>${MONTH()} commission bills</h1><div class="tw"><table><tr><th>Shop</th><th>Owner</th><th>Sales</th><th>${cfg.COMM * 100}% fee</th></tr>${rows || '<tr><td colspan="4">No live shops.</td></tr>'}<tr><th colspan="3">Total</th><th>${rs(tot)}</th></tr></table></div><p></p>
<form method="post" action="/panel/bills" onsubmit="return confirm('Send this month\\'s bill to every live shop on WhatsApp?')"><button>Send bills on WhatsApp</button></form>
<p class="muted">Bills ask shops to pay ${cfg.RZP_KEY ? 'by Razorpay link' : 'to ' + esc(cfg.ADMIN_UPI || 'your UPI ID')}.</p>
<h2>Recent payment requests</h2><div class="tw"><table><tr><th>#</th><th>Type</th><th>Shop</th><th>Amount</th><th>Status</th><th>Date</th></tr>${pays.map((p) => `<tr><td>${p.id}</td><td>${p.kind}</td><td>${esc(p.name)}</td><td>${rs(p.amount)}</td><td><span class="tag ${p.status === 'paid' ? 'g' : 'y'}">${p.status}</span></td><td>${new Date(p.created_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>`).join('') || '<tr><td colspan="6">None yet.</td></tr>'}</table></div>`, 'Bills'));
});
r.post('/bills', superOnly, async (req, res) => { const n = await bot.sendBills(); back(res, '/panel/bills', `Bills sent to ${n} shop(s) on WhatsApp.`); });

module.exports = r;
