// Public website pages: browse EDeal ads in the browser.
//   /offers            all live ads (near a location if lat/lng given), with filters
//   /u/:token          personal link sent on WhatsApp (opens offers near the customer)
//   /ad/:id            one ad, shareable, with buttons that open WhatsApp
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const bot = require('./bot');

const r = express.Router();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const botNo = () => { const d = String(process.env.BOT_PHONE || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; };
const waLink = (text) => (botNo() ? `https://wa.me/${botNo()}?text=${encodeURIComponent(text)}` : '#');
const fmtKm = (d) => (d < 1 ? `${Math.max(50, Math.round((d * 1000) / 50) * 50)} m` : `${d.toFixed(1)} km`);
const COL = { Grocery: '#d7f5dd,#a8e6b6', Food: '#ffe7c7,#ffc98a', Fashion: '#fde0ef,#f7b3d6', Electronics: '#dde7ff,#a9c1ff', 'Salon & Spa': '#efe3ff,#cfb3ff', Kids: '#fff6c2,#ffe36b', Tuition: '#e6ecff,#b5c6ff', Coaching: '#ffe4e1,#ffb3a7', Schools: '#e1f5fe,#9fd8f5', Events: '#d9f4ff,#9bdcff', Property: '#e3f1e8,#9fd4b4' };
const emo = (a) => (a.type === 'property' ? { Rent: '🔑', 'Flat sale': '🏢', 'House sale': '🏡' }[a.sub] || '🏠' : a.type === 'event' ? '🎉' : bot.EMO[a.cat] || '🏷');
const img = (a) => (a.media_id ? `/m/${a.media_id}.jpg` : null);

// What the customer can do on WhatsApp for this ad (text the bot understands)
function actions(a) {
  if (a.type === 'property') return [['📞 Contact owner', `Enquiry #${a.id}`], ['📅 Book a visit', `Visit #${a.id}`]];
  if (a.type === 'event') return [["🙋 I'm interested", `Interested #${a.id}`]];
  if (bot.EDU.includes(a.cat)) return [['🎟 Get offer code', `Offer #${a.id}`], [a.cat === 'Schools' ? '📝 Enquire now' : '📅 Book free demo', `Demo #${a.id}`]];
  return [['🎟 Get coupon on WhatsApp', `Offer #${a.id}`]];
}

const CSS = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#111b21}
a{color:inherit}header{background:#075e54;color:#fff;padding:10px 14px;position:sticky;top:0;z-index:5}
.top{display:flex;align-items:center;gap:10px;max-width:1100px;margin:0 auto}.top img{height:30px}.top b{font-size:20px}.top .wa{margin-left:auto;background:#25d366;color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:7px 12px;border-radius:18px;white-space:nowrap}
.bar{max-width:1100px;margin:8px auto 0;display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}
.chip{white-space:nowrap;text-decoration:none;font-size:13px;padding:6px 12px;border-radius:16px;background:rgba(255,255,255,.15);color:#fff}.chip.on{background:#fff;color:#075e54;font-weight:600}
main{max-width:1100px;margin:0 auto;padding:12px}.where{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#fff;border-radius:12px;padding:10px 12px;margin-bottom:12px;font-size:14px}
.where select,.where button{font:inherit;font-size:14px;padding:7px 10px;border-radius:8px;border:1px solid #d1d7db;background:#fff}.where button{background:#00a884;color:#fff;border-color:#00a884;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.card{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.06);display:flex;flex-direction:column;text-decoration:none}
.ph{height:150px;display:flex;align-items:center;justify-content:center;font-size:54px;position:relative;background-size:cover;background-position:center}
.ft{position:absolute;top:8px;left:8px;background:#ffd400;color:#3d3000;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px}
.ds{position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,.6);color:#fff;font-size:12px;padding:2px 8px;border-radius:10px}
.bd{padding:10px 12px 12px;flex:1;display:flex;flex-direction:column;gap:3px}.bd b{font-size:15px}.off{color:#d93025;font-weight:700;font-size:14px}.mt{color:#54656f;font-size:12.5px}
.btn{display:inline-block;text-align:center;text-decoration:none;font-weight:600;font-size:14px;padding:10px 14px;border-radius:22px;background:#25d366;color:#fff;margin:4px 6px 0 0}.btn.g{background:#fff;color:#075e54;border:1px solid #075e54}
.empty{background:#fff;border-radius:12px;padding:24px;text-align:center;color:#54656f}footer{text-align:center;color:#54656f;font-size:13px;padding:24px 10px}
.big{max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden}.big .ph{height:260px;font-size:80px}.big .bd{padding:16px}.big h1{font-size:22px;margin:0}.big .off{font-size:18px}`;

function layout(title, body, { og = {}, chips = '' } = {}) {
  const ogImg = og.image ? (og.image.startsWith('http') ? og.image : cfg.PUBLIC_URL + og.image) : `${cfg.PUBLIC_URL}/edeal-whatsapp-dp.png`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link rel="icon" href="/edeal-icon.svg"><meta property="og:title" content="${esc(og.title || title)}"><meta property="og:description" content="${esc(og.desc || 'Offers, events, classes and homes near you – on WhatsApp')}"><meta property="og:image" content="${esc(ogImg)}"><meta name="description" content="${esc(og.desc || '')}">
<style>${CSS}</style></head><body><header><div class="top"><a href="/offers" style="display:flex;align-items:center;gap:8px;text-decoration:none"><img src="/edeal-icon.svg" alt=""><b>${esc(cfg.BRAND)}</b></a>
<a class="wa" href="${waLink('Hi')}">💬 Open on WhatsApp</a></div>${chips ? `<div class="bar">${chips}</div>` : ''}</header><main>${body}</main>
<footer>${esc(cfg.BRAND)} · local offers on WhatsApp · <a href="/">About</a> · <a href="/privacy">Privacy</a><br>Own a shop, school or property? <a href="${waLink('business')}">Advertise free for 15 days</a></footer></body></html>`;
}

function card(a) {
  const bg = img(a) ? `background-image:url('${img(a)}')` : `background:linear-gradient(135deg,${COL[a.cat] || (a.type === 'deal' ? '#e8f0ec,#c5e3d2' : COL.Events)})`;
  return `<a class="card" href="/ad/${a.id}"><div class="ph" style="${bg}">${img(a) ? '' : emo(a)}${a.featured ? '<span class="ft">⭐ Featured</span>' : ''}${a.dist != null ? `<span class="ds">📍 ${fmtKm(a.dist)}</span>` : ''}</div>
<div class="bd"><b>${esc(a.title)}</b><span class="off">${esc(a.offer)}</span>${a.type === 'property' && a.details ? `<span class="mt">${esc(a.details)}</span>` : ''}<span class="mt">${a.type === 'property' ? '👤' : bot.EDU.includes(a.cat) ? '🎓' : '🏪'} ${esc(a.shop)}${a.type === 'deal' ? ' · ' + esc(a.cat) : ''}</span>
${a.valid_until && a.type !== 'property' ? `<span class="mt">⏳ Till ${bot.istDate(a.valid_until)}</span>` : ''}</div></a>`;
}

const FILTERS = () => [['', 'All'], ['offers', '🔥 Offers'], ['edu', '🎓 Tuition & schools'], ['events', '🎉 Events'], ['property', '🏠 Rent & property'], ...bot.CATS.filter((c) => !bot.EDU.includes(c)).map((c) => ['cat:' + c, `${bot.EMO[c] || '🏷'} ${c}`]), ...bot.EDU.map((c) => ['cat:' + c, `${bot.EMO[c] || '🏷'} ${c}`]), ...Object.entries(bot.SUBS).map(([k, v]) => ['sub:' + k, v])];
function applyFilter(list, f) {
  if (!f) return list;
  if (f === 'offers') return list.filter((a) => a.type === 'deal' && !bot.EDU.includes(a.cat));
  if (f === 'edu') return list.filter((a) => bot.EDU.includes(a.cat));
  if (f === 'events') return list.filter((a) => a.type === 'event');
  if (f === 'property') return list.filter((a) => a.type === 'property');
  if (f.startsWith('cat:')) return list.filter((a) => a.cat === f.slice(4));
  if (f.startsWith('sub:')) return list.filter((a) => a.sub === f.slice(4));
  return list;
}

r.get('/offers', async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const R = Math.min(cfg.MAX_RADIUS_KM, Math.max(1, parseInt(req.query.r, 10) || 3));
  const f = String(req.query.f || ''), q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
  let list;
  if (hasLoc) list = await bot.nearby({ lat, lng, radius_km: R });
  else list = (await db.ads.live()).sort((x, y) => (y.featured - x.featured) || (new Date(y.approved_at || y.created_at) - new Date(x.approved_at || x.created_at)));
  list = applyFilter(list, f);
  if (q) list = list.filter((a) => q.split(/\s+/).every((w) => `${a.title} ${a.offer} ${a.shop} ${a.cat} ${a.details || ''}`.toLowerCase().includes(w)));
  const base = (extra) => { const p = new URLSearchParams(); if (hasLoc) { p.set('lat', lat.toFixed(5)); p.set('lng', lng.toFixed(5)); p.set('r', R); } if (q) p.set('q', q); for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v); else p.delete(k); return '/offers?' + p.toString(); };
  const chips = FILTERS().map(([k, l]) => `<a class="chip${k === f ? ' on' : ''}" href="${esc(base({ f: k }))}">${esc(l)}</a>`).join('');
  const locs = (await db.localities.active()).filter((l) => l.lat != null);
  const where = `<div class="where">${hasLoc ? `📍 Showing ads within <b>${R} km</b> of your location · ${[2, 3, 5].map((k) => k === R ? `<b>${k} km</b>` : `<a href="${esc(base({ r: k, f }).replace(/r=\d/, 'r=' + k))}">${k} km</a>`).join(' · ')}` : '📍 Showing all areas.'}
<button type="button" onclick="loc()">Use my location</button>${locs.length ? `<select onchange="if(this.value)location=this.value"><option value="">Pick an area…</option>${locs.map((l) => `<option value="/offers?lat=${l.lat}&lng=${l.lng}&r=${R}${f ? '&f=' + encodeURIComponent(f) : ''}">${esc(l.name)}</option>`).join('')}</select>` : ''}
<form action="/offers" method="get" style="display:flex;gap:6px;flex:1 1 100%;min-width:0">${hasLoc ? `<input type="hidden" name="lat" value="${lat}"><input type="hidden" name="lng" value="${lng}"><input type="hidden" name="r" value="${R}">` : ''}<input name="q" value="${esc(q)}" placeholder="Search: tuition, 2 bhk rent…" style="flex:1;min-width:0;font:inherit;font-size:14px;padding:7px 10px;border-radius:8px;border:1px solid #d1d7db"></form></div>
<script>function loc(){if(!navigator.geolocation)return alert('Location not available');navigator.geolocation.getCurrentPosition(function(p){location='/offers?lat='+p.coords.latitude.toFixed(5)+'&lng='+p.coords.longitude.toFixed(5)+'&r=${R}${f ? '&f=' + encodeURIComponent(f) : ''}'},function(){alert('Please allow location, or pick an area')})}</script>`;
  const body = where + (list.length ? `<div class="grid">${list.slice(0, 120).map(card).join('')}</div>` : `<div class="empty">No ads here yet. Try a bigger distance or another area.<br><br><a class="btn" href="${waLink('Hi')}">💬 Get offers on WhatsApp</a></div>`);
  res.send(layout(`${cfg.BRAND} – Offers near you`, body, { chips, og: { title: `${cfg.BRAND} – offers, events, classes & homes near you`, desc: 'Sales, discounts, tuition & schools, local events and houses for rent or sale within 2–5 km.' } }));
});

// Personal link sent on WhatsApp: opens offers near the customer's saved location
r.get('/u/:token', async (req, res) => {
  const c = await db.one('select * from customers where web_token=$1', [String(req.params.token).slice(0, 40)]);
  if (!c || c.lat == null) return res.redirect('/offers');
  const f = req.query.f ? '&f=' + encodeURIComponent(req.query.f) : '';
  res.redirect(`/offers?lat=${c.lat.toFixed(5)}&lng=${c.lng.toFixed(5)}&r=${Number(c.radius_km) || 2}${f}`);
});

r.get('/ad/:id', async (req, res) => {
  const a = await db.ads.get(+req.params.id || 0);
  if (!a || a.status !== 'live') return res.status(404).send(layout('Ad not found', `<div class="empty">This ad has ended or doesn't exist.<br><br><a class="btn" href="/offers">See current offers</a></div>`));
  await db.q('update ads set views=views+1 where id=$1', [a.id]);
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  const d = Number.isFinite(lat) && Number.isFinite(lng) ? bot.km({ lat, lng }, a) : null;
  const bg = img(a) ? `background-image:url('${img(a)}')` : `background:linear-gradient(135deg,${COL[a.cat] || (a.type === 'deal' ? '#e8f0ec,#c5e3d2' : COL.Events)})`;
  const share = `${cfg.PUBLIC_URL}/ad/${a.id}`;
  const body = `<div class="big"><div class="ph" style="${bg}">${img(a) ? '' : emo(a)}${a.featured ? '<span class="ft">⭐ Featured</span>' : ''}${d != null ? `<span class="ds">📍 ${fmtKm(d)}</span>` : ''}</div>
<div class="bd"><h1>${esc(a.title)}</h1><span class="off">${esc(a.offer)}</span>${a.details ? `<p class="mt" style="font-size:14px">${esc(a.details)}</p>` : ''}
<p class="mt" style="font-size:14px">${a.type === 'property' ? '👤' : '🏪'} <b>${esc(a.shop)}</b>${a.type === 'deal' ? ' · ' + esc(a.cat) : a.type === 'property' ? ' · ' + esc(bot.SUBS[a.sub] || '') : ''}${a.address ? `<br>📍 ${esc(a.address)}` : ''}${a.valid_until && a.type !== 'property' ? `<br>⏳ Valid till ${bot.istDate(a.valid_until)}` : ''}</p>
<div>${actions(a).map(([l, t]) => `<a class="btn" href="${waLink(t)}">${esc(l)}</a>`).join('')}
<a class="btn g" href="https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}" target="_blank" rel="noopener">📍 Directions</a>
<a class="btn g" href="https://wa.me/?text=${encodeURIComponent(`${a.title} – ${a.offer} at ${a.shop}\n${share}`)}">↗ Share</a></div>
<p class="mt">Buttons open WhatsApp with ${esc(cfg.BRAND)}. Your code or enquiry arrives there.</p></div></div>
<p style="text-align:center"><a href="/offers?lat=${a.lat}&lng=${a.lng}&r=3">See more offers near ${esc(a.shop)} →</a></p>`;
  res.send(layout(`${a.title} – ${a.shop} | ${cfg.BRAND}`, body, { og: { title: `${a.title} – ${a.offer}`, desc: `${a.shop} · on ${cfg.BRAND}`, image: img(a) } }));
});

module.exports = r;
