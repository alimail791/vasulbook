// Web admin panel: /panel. Main admins and area admins log in with a one-time
// code sent by the bot on WhatsApp. Area admins only see their own localities.
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const bot = require('./bot');
const pay = require('./pay');
const jobs = require('./jobs');

const r = express.Router();
r.use(express.urlencoded({ extended: false }));

const rs = bot.rs;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('edeal:' + cfg.ADMIN_KEY + ':' + cfg.WA_TOKEN).digest('hex');
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex').slice(0, 32);
const MONTH = () => new Date().toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
const d8 = (d) => (d ? bot.istDate(d) : '—');

// ---------- auth
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
async function who(phone) {
  const isMain = cfg.ADMINS.includes(phone);
  const myLocs = await db.localities.byAdmin(phone);
  if (!isMain && !myLocs.length) return null;
  return { phone, isMain, myLocs, locIds: myLocs.map((l) => l.id) };
}
async function auth(req, res, next) {
  if (req.query.key && req.query.key === cfg.ADMIN_KEY && cfg.ADMINS[0]) { req.u = await who(cfg.ADMINS[0]); return next(); }
  const c = readCookie(req, 'ed_s');
  if (c) {
    const [phone, exp, sig] = c.split('.');
    if (sig === sign(phone + '.' + exp) && Number(exp) > Date.now()) { req.u = await who(phone); if (req.u) return next(); }
  }
  return res.redirect('/panel/login');
}
const mainOnly = (req, res, next) => (req.u.isMain ? next() : res.status(403).send(page(req, 'Not allowed', '<p>Only the main admin can open this page.</p>')));
const inScope = (u, locId) => u.isMain || u.locIds.includes(locId);
const back = (res, url, msg) => res.redirect(url + (url.includes('?') ? '&' : '?') + 'm=' + encodeURIComponent(msg));

// ---------- layout
const CSS = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#111b21}
header{background:#075e54;color:#fff;padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header .logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:18px}header .logo img{height:28px}
header nav{display:flex;gap:4px;flex-wrap:wrap}header a{color:#d9fdd3;text-decoration:none;padding:6px 10px;border-radius:8px;font-size:14px}
header a.on,header a:hover{background:rgba(255,255,255,.15);color:#fff}header .me{margin-left:auto;font-size:13px;opacity:.9}
main{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:20px;margin:6px 0 14px}h2{font-size:16px;margin:22px 0 10px;color:#3b4a54}
.card{background:#fff;border-radius:12px;padding:14px 16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.kp{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}.k{background:#fff;border-radius:12px;padding:12px 14px}
.k small{color:#54656f;font-size:12px}.k b{display:block;font-size:21px;margin-top:3px;color:#075e54}
.tw{overflow-x:auto;background:#fff;border-radius:12px}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid #eef0f1;vertical-align:middle}th{background:#f7f9fa;color:#54656f;font-weight:600;white-space:nowrap}
.tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600}.g{background:#d9fdd3;color:#0a6b3d}.y{background:#fff4c2;color:#7a5b00}.r{background:#ffe0dc;color:#a52714}.b{background:#e0ecff;color:#1e40af}.x{background:#e9edef;color:#54656f}
form.in{display:inline}label{display:block;font-size:13px;color:#3b4a54;margin:8px 0 4px}
input,select{font:inherit;padding:8px 10px;border:1px solid #d1d7db;border-radius:8px;width:100%;background:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
button,.btn{font:inherit;font-size:14px;padding:8px 14px;border-radius:8px;border:1px solid #00a884;background:#00a884;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost,.btn.ghost{background:#fff;color:#075e54;border-color:#075e54}button.warn{background:#fff;color:#a52714;border-color:#a52714}button.sm,select.sm{padding:5px 9px;font-size:13px;width:auto}
.msg{background:#d9fdd3;border:1px solid #9de6a8;padding:10px 14px;border-radius:10px;margin-bottom:12px}.muted{color:#54656f;font-size:13px}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}a{color:#075e54}.thumb{width:56px;height:56px;object-fit:cover;border-radius:8px;background:#eee}
.ads{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}.ad{background:#fff;border-radius:12px;padding:12px}.ad img{width:100%;max-height:180px;object-fit:cover;border-radius:8px}
.login{max-width:380px;margin:60px auto}`;
function page(req, title, body, tab) {
  const u = req.u;
  const nav = u ? [['', 'Dashboard'], ['/approvals', 'Approvals'], ['/ads', 'Ads'], ['/advertisers', 'Advertisers'], ['/payments', 'Payments'], ...(u.isMain ? [['/localities', 'Localities'], ['/plans', 'Plans'], ['/broadcast', 'Broadcast']] : [])]
    .map(([p, n]) => `<a href="/panel${p}" class="${tab === n ? 'on' : ''}">${n}</a>`).join('') : '';
  const msg = req.query && req.query.m ? `<div class="msg">${esc(req.query.m)}</div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} – ${esc(cfg.BRAND)} admin</title><link rel="icon" href="/edeal-icon.svg"><style>${CSS}</style></head><body>
<header><span class="logo"><img src="/edeal-icon.svg" alt="">${esc(cfg.BRAND)} admin</span><nav>${nav}</nav>${u ? `<span class="me">${u.isMain ? 'Main admin' : 'Area admin · ' + esc(u.myLocs.map((a) => a.name).join(', '))} · +${u.phone} · <a href="/panel/logout" style="color:#fff">Log out</a></span>` : ''}</header>
<main>${msg}${body}</main></body></html>`;
}
const STAT = { live: 'g', pending: 'y', rejected: 'r', paused: 'x', expired: 'x', paid: 'g', claimed: 'y', created: 'x' };
const tag = (s) => `<span class="tag ${STAT[s] || 'b'}">${esc(s)}</span>`;

// ---------- login with WhatsApp code
r.get('/login', (req, res) => res.send(page(req, 'Log in', `<div class="login card"><p style="text-align:center"><img src="/edeal-logo.svg" style="height:56px" alt="${esc(cfg.BRAND)}"></p><h1>Admin log in</h1>
<form method="post" action="/panel/login"><label>Your WhatsApp number</label><input name="phone" inputmode="tel" placeholder="98xxxxxxxx" required>
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
  res.setHeader('Set-Cookie', `ed_s=${encodeURIComponent(phone + '.' + exp + '.' + sign(phone + '.' + exp))}; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`);
  res.redirect('/panel');
});
r.get('/logout', (req, res) => { res.setHeader('Set-Cookie', 'ed_s=; Path=/panel; Max-Age=0'); res.redirect('/panel/login'); });

r.use(auth);

// ---------- helpers
const locsFor = (u) => (u.isMain ? db.localities.all() : u.myLocs);
const scopeSql = (u, col, n) => (u.isMain ? '' : ` and ${col} = any($${n})`);
const scopeArg = (u) => (u.isMain ? [] : [u.locIds]);
const parseLoc = (t) => { const m = String(t || '').match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/); return m ? { lat: +m[1], lng: +m[2] } : null; };
const img = (a) => (a.media_id ? `/m/${a.media_id}.jpg` : null);

// ---------- dashboard
r.get('/', async (req, res) => {
  const u = req.u, locs = await locsFor(u), A = scopeArg(u);
  const one = (sql) => db.one(sql, A);
  const live = (await one(`select count(*)::int n from ads a join advertisers v on v.id=a.adv_id where a.status='live'${scopeSql(u, 'v.locality_id', 1)}`)).n;
  const pend = (await one(`select count(*)::int n from ads a join advertisers v on v.id=a.adv_id where a.status='pending'${scopeSql(u, 'v.locality_id', 1)}`)).n;
  const advs = await one(`select count(*)::int n, count(*) filter (where plan_until>now())::int act, count(*) filter (where plan='trial' and plan_until>now())::int trial from advertisers where true${scopeSql(u, 'locality_id', 1)}`);
  const subs = (await one(`select count(*)::int n from customers where subscribed${scopeSql(u, 'locality_id', 1)}`)).n;
  const users = (await one(`select count(*)::int n from customers where lat is not null${scopeSql(u, 'locality_id', 1)}`)).n;
  const leads = (await one(`select count(*)::int n from leads l join ads a on a.id=l.ad_id join advertisers v on v.id=a.adv_id where l.created_at > now() - interval '30 days'${scopeSql(u, 'v.locality_id', 1)}`)).n;
  const rev = await db.all(`select locality_id, coalesce(sum(amount),0) s from payments where status='paid' and paid_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'${scopeSql(u, 'locality_id', 1)} group by locality_id`, A);
  const revOf = (id) => (rev.find((x) => x.locality_id === id) || { s: 0 }).s;
  const total = rev.reduce((t, x) => t + x.s, 0);
  const adminShare = locs.reduce((t, l) => t + (l.admin_phone ? revOf(l.id) * l.share : 0), 0);
  const mine = u.isMain ? total - adminShare : locs.reduce((t, l) => t + revOf(l.id) * l.share, 0);
  const claims = u.isMain ? (await db.one(`select count(*)::int n from payments where status='claimed'`)).n : 0;
  const k = (t, v) => `<div class="k"><small>${t}</small><b>${v}</b></div>`;
  const kp = k('Localities', locs.length) + k('Live ads', live) + k('Pending approval', pend) + k('Advertisers', `${advs.act} active / ${advs.n}`) + k('On free trial', advs.trial)
    + k('Customers', users) + k('Daily-offer subscribers', subs) + k('Leads (30 days)', leads) + k(`${MONTH()} collected`, rs(total)) + k(u.isMain ? 'Your share' : 'Your share', rs(mine));
  const cnt = await db.all(`select v.locality_id, count(*) filter (where a.status='live')::int live, count(*) filter (where a.status='pending')::int pend from ads a join advertisers v on v.id=a.adv_id group by v.locality_id`);
  const ac = await db.all(`select locality_id, count(*)::int n from advertisers group by locality_id`);
  const sc = await db.all(`select locality_id, count(*)::int n from customers where subscribed group by locality_id`);
  const f = (arr, id, key = 'n') => (arr.find((x) => x.locality_id === id) || {})[key] || 0;
  const rows = locs.map((l) => `<tr><td><b>${esc(l.name)}</b>${l.active ? '' : ' <span class="tag x">paused</span>'}</td><td>${l.admin_phone ? '+' + l.admin_phone : 'Main admin'}</td><td>${f(cnt, l.id, 'live')}</td><td>${f(cnt, l.id, 'pend')}</td><td>${f(ac, l.id)}</td><td>${f(sc, l.id)}</td><td>${rs(revOf(l.id))}</td></tr>`).join('');
  res.send(page(req, 'Dashboard', `<h1>Dashboard — ${MONTH()}</h1><div class="kp">${kp}</div>
<div class="row" style="margin-bottom:14px"><a class="btn" href="/panel/approvals">Approvals (${pend})</a>${u.isMain ? `<a class="btn ghost" href="/panel/payments">Payments to confirm (${claims})</a><a class="btn ghost" href="/panel/localities#new">+ Add locality</a>` : ''}</div>
<h2>By locality</h2><div class="tw"><table><tr><th>Locality</th><th>Admin</th><th>Live ads</th><th>Pending</th><th>Advertisers</th><th>Subscribers</th><th>${MONTH()} revenue</th></tr>${rows || '<tr><td colspan="7">No localities yet.</td></tr>'}</table></div>`, 'Dashboard'));
});

// ---------- approvals
r.get('/approvals', async (req, res) => {
  const u = req.u, list = (await db.ads.pending()).filter((a) => inScope(u, a.locality_id));
  const ls = Object.fromEntries((await db.localities.all()).map((l) => [l.id, l.name]));
  const reasons = Object.entries(bot.REASONS).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('');
  const cards = list.map((a) => `<div class="ad">${img(a) ? `<img src="${img(a)}" alt="">` : ''}<p><b>${esc(a.title)}</b><br><span style="color:#d93025;font-weight:700">${esc(a.offer)}</span>${a.details ? `<br><span class="muted">${esc(a.details)}</span>` : ''}</p>
<p class="muted">${esc(a.shop)} · +${a.adv_phone}<br>${esc(a.type)} · ${esc(a.sub || a.cat)} · ${esc(ls[a.locality_id] || 'No locality')} · ${a.radius_km} km · till ${d8(a.valid_until)}</p>
<div class="row"><form class="in" method="post" action="/panel/ads/${a.id}/approve"><button class="sm">✅ Approve</button></form>
<form class="in row" method="post" action="/panel/ads/${a.id}/reject"><select class="sm" name="reason">${reasons}</select><button class="sm warn">Reject</button></form></div></div>`).join('');
  res.send(page(req, 'Approvals', `<h1>Waiting for approval (${list.length})</h1>${cards ? `<div class="ads">${cards}</div>` : '<p>Nothing pending 🎉</p>'}<p class="muted">Approving or rejecting here also messages the advertiser on WhatsApp.</p>`, 'Approvals'));
});
r.post('/ads/:id/approve', async (req, res) => {
  const a = await db.ads.get(+req.params.id);
  if (!a || !inScope(req.u, a.locality_id)) return back(res, '/panel/approvals', 'Ad not found.');
  await bot.approveAd(a.id, req.u.phone);
  back(res, req.get('referer') && req.get('referer').includes('/ads') ? '/panel/ads' : '/panel/approvals', `Approved: ${a.title}`);
});
r.post('/ads/:id/reject', async (req, res) => {
  const a = await db.ads.get(+req.params.id);
  if (!a || !inScope(req.u, a.locality_id)) return back(res, '/panel/approvals', 'Ad not found.');
  await bot.rejectAd(a.id, bot.REASONS[req.body.reason] || bot.REASONS.other);
  back(res, '/panel/approvals', `Rejected: ${a.title}`);
});
r.post('/ads/:id/status', async (req, res) => {
  const a = await db.ads.get(+req.params.id), st = req.body.status;
  if (!a || !inScope(req.u, a.locality_id) || !['live', 'paused', 'expired'].includes(st)) return back(res, '/panel/ads', 'Not allowed.');
  if (st === 'live' && a.status !== 'paused') return back(res, '/panel/ads', 'Only paused ads can be resumed.');
  await db.ads.set(a.id, { status: st });
  back(res, '/panel/ads', `${a.title}: ${st === 'expired' ? 'removed' : st}`);
});

// ---------- ads
r.get('/ads', async (req, res) => {
  const u = req.u, st = req.query.status || '', loc = +req.query.loc || 0;
  const list = await db.all(`select a.*, v.name shop, v.phone, v.locality_id from ads a join advertisers v on v.id=a.adv_id where true${scopeSql(u, 'v.locality_id', 1)} order by a.id desc limit 500`, scopeArg(u));
  const locs = await locsFor(u), ls = Object.fromEntries((await db.localities.all()).map((l) => [l.id, l.name]));
  const rows = list.filter((a) => (!st || a.status === st) && (!loc || a.locality_id === loc)).map((a) => `<tr><td>${img(a) ? `<img class="thumb" src="${img(a)}" alt="">` : ''}</td><td><b>${esc(a.title)}</b>${a.featured ? ' ⭐' : ''}<br><span class="muted">${esc(a.offer)}</span></td><td>${esc(a.shop)}<br><span class="muted">+${a.phone}</span></td><td>${esc(a.sub || a.cat)}</td><td>${esc(ls[a.locality_id] || '—')}</td><td>${tag(a.status)}</td><td>${d8(a.valid_until)}</td><td>${a.views}</td><td>${a.leads}</td><td>${a.redeemed}</td>
<td class="row">${a.status === 'pending' ? `<form class="in" method="post" action="/panel/ads/${a.id}/approve"><button class="sm">Approve</button></form>` : ''}${a.status === 'live' ? `<form class="in" method="post" action="/panel/ads/${a.id}/status"><input type="hidden" name="status" value="paused"><button class="sm ghost">Pause</button></form>` : ''}${a.status === 'paused' ? `<form class="in" method="post" action="/panel/ads/${a.id}/status"><input type="hidden" name="status" value="live"><button class="sm">Resume</button></form>` : ''}${['live', 'paused'].includes(a.status) ? `<form class="in" method="post" action="/panel/ads/${a.id}/status" onsubmit="return confirm('Remove this ad?')"><input type="hidden" name="status" value="expired"><button class="sm warn">Remove</button></form>` : ''}</td></tr>`).join('');
  const sopt = ['', 'live', 'pending', 'paused', 'expired', 'rejected'].map((s) => `<option value="${s}"${s === st ? ' selected' : ''}>${s || 'All statuses'}</option>`).join('');
  const lopt = `<option value="">All localities</option>` + locs.map((l) => `<option value="${l.id}"${l.id === loc ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
  res.send(page(req, 'Ads', `<h1>Ads</h1><form class="row" method="get" style="margin-bottom:10px"><select class="sm" name="status">${sopt}</select><select class="sm" name="loc">${lopt}</select><button class="sm ghost">Filter</button></form>
<div class="tw"><table><tr><th></th><th>Ad</th><th>Advertiser</th><th>Category</th><th>Locality</th><th>Status</th><th>Till</th><th>Views</th><th>Leads</th><th>Redeemed</th><th></th></tr>${rows || '<tr><td colspan="11">No ads.</td></tr>'}</table></div>`, 'Ads'));
});

// ---------- advertisers
r.get('/advertisers', async (req, res) => {
  const u = req.u, P = await db.plans(), q = String(req.query.q || '').toLowerCase();
  const list = await db.all(`select v.*, (select count(*)::int from ads a where a.adv_id=v.id and a.status='live') live, (select coalesce(sum(leads),0)::int from ads a where a.adv_id=v.id) leads,
    (select coalesce(sum(amount),0) from payments p where p.adv_id=v.id and p.status='paid') paid from advertisers v where true${scopeSql(u, 'v.locality_id', 1)} order by v.id desc`, scopeArg(u));
  const ls = Object.fromEntries((await db.localities.all()).map((l) => [l.id, l.name]));
  const popt = Object.entries(P).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('');
  const rows = list.filter((a) => !q || a.name.toLowerCase().includes(q) || a.phone.includes(q) || (a.cat || '').toLowerCase().includes(q)).map((a) => `<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.cat || '')}</td><td>+${a.phone}</td><td>${esc(ls[a.locality_id] || '—')}</td>
<td>${a.plan ? esc(P[a.plan] ? P[a.plan].name : a.plan) : '—'} ${bot.planActive(a) ? `<span class="tag g">till ${d8(a.plan_until)}</span>` : a.plan ? '<span class="tag x">ended</span>' : ''}</td><td>${a.live}</td><td>${a.leads}</td><td>${rs(a.paid)}</td>
<td>${u.isMain ? `<form class="row" method="post" action="/panel/advertisers/${a.id}/plan"><select class="sm" name="plan">${popt}</select><button class="sm ghost" title="Start a plan without online payment (e.g. paid in cash)">Give plan</button></form>` : ''}</td></tr>`).join('');
  res.send(page(req, 'Advertisers', `<h1>Advertisers</h1><form class="row" method="get" style="margin-bottom:10px"><input name="q" value="${esc(req.query.q || '')}" placeholder="Search name, phone or category" style="max-width:320px"><button class="ghost">Search</button></form>
<div class="tw"><table><tr><th>Business</th><th>Category</th><th>WhatsApp</th><th>Locality</th><th>Plan</th><th>Live ads</th><th>Leads</th><th>Paid (all time)</th><th></th></tr>${rows || '<tr><td colspan="9">No advertisers yet. Businesses register by sending <b>business</b> to the bot.</td></tr>'}</table></div>
${u.isMain ? '<p class="muted">“Give plan” starts a plan without online payment (for cash payments or a free extension). Cash amounts are recorded as a paid payment.</p>' : ''}`, 'Advertisers'));
});
r.post('/advertisers/:id/plan', mainOnly, async (req, res) => {
  const a = await db.advertisers.get(+req.params.id), P = await db.plans(), k = req.body.plan;
  if (!a || !P[k]) return back(res, '/panel/advertisers', 'Not found.');
  if (P[k].price > 0) {
    const pm = await db.one(`insert into payments(adv_id,plan,amount,method,locality_id,utr) values($1,$2,$3,'cash',$4,'panel') returning *`, [a.id, k, P[k].price, a.locality_id]);
    await bot.confirmPayment(pm.id);
  } else { await bot.activatePlan(a, k); await bot.notify(a.phone, `🎁 Your ${P[k].name} has started. Post your ad now!`, [['🏪 Business menu', 'menu']]); }
  back(res, '/panel/advertisers', `${a.name}: ${P[k].name} started.`);
});

// ---------- payments
r.get('/payments', async (req, res) => {
  const u = req.u, P = await db.plans();
  const list = await db.all(`select p.*, v.name, v.phone from payments p join advertisers v on v.id=p.adv_id where p.status<>'created'${scopeSql(u, 'p.locality_id', 1)} order by (p.status='claimed') desc, p.id desc limit 300`, scopeArg(u));
  const ls = Object.fromEntries((await db.localities.all()).map((l) => [l.id, l.name]));
  const rows = list.map((p) => `<tr><td>${pay.ref(p)}</td><td><b>${esc(p.name)}</b><br><span class="muted">+${p.phone}</span></td><td>${esc(P[p.plan] ? P[p.plan].name : p.plan)}</td><td>${rs(p.amount)}</td><td>${esc(p.method || '')}${p.utr ? `<br><span class="muted">${esc(p.utr)}</span>` : ''}</td><td>${esc(ls[p.locality_id] || '—')}</td><td>${tag(p.status)}</td><td>${d8(p.paid_at || p.created_at)}</td>
<td>${u.isMain && p.status === 'claimed' ? `<div class="row"><form class="in" method="post" action="/panel/payments/${p.id}/confirm"><button class="sm">✅ Confirm</button></form><form class="in" method="post" action="/panel/payments/${p.id}/reject"><button class="sm warn">Not received</button></form></div>` : ''}</td></tr>`).join('');
  res.send(page(req, 'Payments', `<h1>Payments</h1><p class="muted">${pay.rzpEnabled() ? 'Razorpay payments confirm automatically. ' : ''}${pay.upiEnabled() ? `Direct UPI payments to <b>${esc(cfg.ADMIN_UPI)}</b> show as <b>claimed</b> until you confirm them.` : ''}</p>
<div class="tw"><table><tr><th>Ref</th><th>Advertiser</th><th>Plan</th><th>Amount</th><th>Method</th><th>Locality</th><th>Status</th><th>Date</th><th></th></tr>${rows || '<tr><td colspan="9">No payments yet.</td></tr>'}</table></div>`, 'Payments'));
});
r.post('/payments/:id/confirm', mainOnly, async (req, res) => { const p = await bot.confirmPayment(+req.params.id); back(res, '/panel/payments', p ? `Confirmed ${rs(p.amount)} – plan activated.` : 'Already handled.'); });
r.post('/payments/:id/reject', mainOnly, async (req, res) => {
  const p = await db.one(`update payments set status='rejected' where id=$1 and status='claimed' returning *`, [+req.params.id]);
  if (p) { const a = await db.advertisers.get(p.adv_id); await bot.notify(a.phone, `⚠️ We couldn't find your payment of ${rs(p.amount)} (${pay.ref(p)}). Please check your UPI app and try again.`, [['💳 Plans & renew', 'plans']]); }
  back(res, '/panel/payments', p ? 'Marked as not received.' : 'Already handled.');
});

// ---------- localities (main admin)
r.get('/localities', mainOnly, async (req, res) => {
  const ls = await db.localities.all();
  const ac = await db.all(`select locality_id, count(*)::int n from advertisers group by locality_id`);
  const rows = ls.map((l) => `<tr><td><b>${esc(l.name)}</b></td><td>${(ac.find((x) => x.locality_id === l.id) || { n: 0 }).n}</td><td>${l.lat != null ? `<a href="https://maps.google.com/?q=${l.lat},${l.lng}" target="_blank">map</a>` : '<span class="tag y">no centre</span>'}</td><td>${l.active ? tag('live') : '<span class="tag x">paused</span>'}</td>
<td><form class="row" method="post" action="/panel/localities/${l.id}"><input name="name" value="${esc(l.name)}" style="width:140px"><input name="admin" value="${l.admin_phone ? esc(l.admin_phone.slice(2)) : ''}" placeholder="Area admin no. (blank = you)" style="width:190px"><input name="share" type="number" min="0" max="100" value="${Math.round(l.share * 100)}" style="width:70px" title="Area admin share %">%
<input name="loc" value="${l.lat != null ? l.lat + ',' + l.lng : ''}" placeholder="lat,lng" style="width:170px"><select class="sm" name="active"><option value="1"${l.active ? ' selected' : ''}>Active</option><option value="0"${l.active ? '' : ' selected'}>Paused</option></select><button class="sm">Save</button></form></td></tr>`).join('');
  res.send(page(req, 'Localities', `<h1>Localities &amp; area admins</h1><div class="tw"><table><tr><th>Locality</th><th>Advertisers</th><th>Centre</th><th>Status</th><th>Edit (name · area admin · share · centre)</th></tr>${rows || '<tr><td colspan="5">No localities yet.</td></tr>'}</table></div>
<p class="muted">One admin can run many localities – just enter the same number on each. Leave the admin blank to run it yourself. Businesses and customers are matched to the nearest locality centre.</p>
<h2 id="new">Add locality</h2><div class="card"><form method="post" action="/panel/localities"><div class="grid"><div><label>Locality name</label><input name="name" required placeholder="Nehru Nagar"></div><div><label>Area admin WhatsApp (optional)</label><input name="admin" placeholder="9xxxxxxxxx"></div>
<div><label>Centre (Google Maps link or lat,lng)</label><input name="loc" required placeholder="13.0400, 80.2000"></div><div><label>Area admin share (%)</label><input name="share" type="number" min="0" max="100" value="${Math.round(cfg.AREA_SHARE * 100)}"></div></div>
<p class="muted">Tip: in Google Maps, long-press the centre of the area and copy the numbers shown at the top.</p><button>Add locality</button></form></div>`, 'Localities'));
});
r.post('/localities', mainOnly, async (req, res) => {
  const b = req.body, loc = parseLoc(b.loc), admin = String(b.admin || '').replace(/\D/g, '').length >= 10 ? cfg.norm(String(b.admin).replace(/\D/g, '').slice(-10)) : null;
  if (!String(b.name || '').trim() || !loc) return back(res, '/panel/localities', 'Name and centre (lat,lng) are required.');
  const l = await db.one('insert into localities(name,admin_phone,lat,lng,share) values($1,$2,$3,$4,$5) returning *', [b.name.trim(), admin, loc.lat, loc.lng, Math.min(100, Math.max(0, Number(b.share) || 0)) / 100]);
  if (l.admin_phone) await bot.welcomeAreaAdmin(l);
  back(res, '/panel/localities', `${l.name} added.${l.admin_phone ? ' Area admin notified on WhatsApp.' : ''}`);
});
r.post('/localities/:id', mainOnly, async (req, res) => {
  const l0 = await db.localities.get(+req.params.id); if (!l0) return back(res, '/panel/localities', 'Not found.');
  const b = req.body, loc = parseLoc(b.loc), admin = String(b.admin || '').replace(/\D/g, '').length >= 10 ? cfg.norm(String(b.admin).replace(/\D/g, '').slice(-10)) : null;
  const l = await db.localities.set(l0.id, { name: (b.name || l0.name).trim(), admin_phone: admin, share: Math.min(100, Math.max(0, Number(b.share) || 0)) / 100, lat: loc ? loc.lat : l0.lat, lng: loc ? loc.lng : l0.lng, active: b.active === '1' });
  if (l.admin_phone && l.admin_phone !== l0.admin_phone) await bot.welcomeAreaAdmin(l);
  back(res, '/panel/localities', `${l.name} saved.`);
});

// ---------- plans (main admin)
r.get('/plans', mainOnly, async (req, res) => {
  const P = await db.plans();
  const rows = Object.entries(P).map(([k, p]) => `<tr><td><b>${esc(p.name)}</b>${p.featured ? ' ⭐ featured' : ''}</td><td>${k === 'trial' ? 'Free' : `<input name="${k}" type="number" min="1" value="${p.price}" style="width:110px">`}</td><td>${p.days === 30 ? '1 month' : p.days + ' day' + (p.days > 1 ? 's' : '')}${k === 'trial' ? ' · once per business' : ''}</td><td>${p.km} km</td><td>${p.oneAd ? '1 ad' : 'Unlimited'}</td></tr>`).join('');
  res.send(page(req, 'Plans', `<h1>Plans &amp; pricing</h1><form method="post" action="/panel/plans"><div class="tw"><table><tr><th>Plan</th><th>Price (₹)</th><th>Runs</th><th>Reach</th><th>Ads</th></tr>${rows}</table></div><p></p><button>Save prices</button></form>
<p class="muted">New prices apply right away in WhatsApp. Area admins get ${Math.round(cfg.AREA_SHARE * 100)}% of payments from their localities by default (change per locality).</p>`, 'Plans'));
});
r.post('/plans', mainOnly, async (req, res) => {
  for (const k of ['day', 'week', 'month', 'premium']) { const n = Number(req.body[k]); if (n > 0) await db.setPrice(k, Math.round(n)); }
  back(res, '/panel/plans', 'Prices saved.');
});

// ---------- broadcast (main admin)
r.get('/broadcast', mainOnly, async (req, res) => {
  const ls = await db.localities.all(), log = await db.all('select * from broadcasts order by id desc limit 15');
  const subs = await db.all('select locality_id, count(*)::int n from customers where subscribed group by locality_id');
  const total = subs.reduce((t, x) => t + x.n, 0);
  res.send(page(req, 'Broadcast', `<h1>Daily offers message</h1><div class="card"><p>Sent automatically every day at <b>${cfg.DIGEST_HOUR}:00 AM</b> to everyone who turned on daily offers (${total} now). Each person gets the top 5 live ads in their own distance, Premium first.</p>
<form class="row" method="post" action="/panel/broadcast"><select class="sm" name="loc"><option value="">All localities</option>${ls.map((l) => `<option value="${l.id}">${esc(l.name)} (${(subs.find((x) => x.locality_id === l.id) || { n: 0 }).n})</option>`).join('')}</select><button>Send now</button></form>
<p class="muted">People who haven't messaged the bot in 24 hours get the approved marketing template${cfg.WA_DIGEST_TEMPLATE ? ` (<b>${esc(cfg.WA_DIGEST_TEMPLATE)}</b>)` : ' – <b>not set up yet</b>, so only recent users get it'}. Meta charges per marketing message.</p></div>
<h2>History</h2><div class="tw"><table><tr><th>When</th><th>Scope</th><th>Sent</th></tr>${log.map((b) => `<tr><td>${new Date(b.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td><td>${esc(b.scope)}</td><td>${b.sent}</td></tr>`).join('') || '<tr><td colspan="3">Nothing sent yet.</td></tr>'}</table></div>`, 'Broadcast'));
});
r.post('/broadcast', mainOnly, async (req, res) => {
  const loc = +req.body.loc || 0;
  const n = await jobs.runDigest(true, loc ? [loc] : null);
  back(res, '/panel/broadcast', `Sent to ${n} subscribers.`);
});

module.exports = r;
