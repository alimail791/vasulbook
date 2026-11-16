// Website shop: browse shops and order in the browser.
//   /shops         shops near a location (or all), area picker
//   /u/:token      personal link sent on WhatsApp – remembers who the customer is (cookie)
//   /s/:id         one shop: categories, items, cart, checkout
//   POST /s/:id/order  place the order (known customer) or get a WhatsApp code to confirm
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const bot = require('./bot');

const r = express.Router();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rs = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const botNo = () => { const d = String(process.env.BOT_PHONE || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; };
const waLink = (text) => (botNo() ? `https://wa.me/${botNo()}?text=${encodeURIComponent(text)}` : '#');
const fmtKm = (d) => (d < 1 ? `${Math.max(50, Math.round((d * 1000) / 50) * 50)} m` : `${d.toFixed(1)} km`);
function cookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const me = async (req) => { const t = cookie(req, 'em_u'); return t ? db.one('select * from cust_links where token=$1', [t]) : null; };

const CSS = `*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f3f5f2;color:#14231a}a{color:inherit}
header{background:#1b7f3b;color:#fff;padding:10px 14px;position:sticky;top:0;z-index:5}.top{display:flex;align-items:center;gap:10px;max-width:900px;margin:0 auto}.top b{font-size:20px}
.top .wa{margin-left:auto;background:#25d366;color:#fff;text-decoration:none;font-weight:600;font-size:13px;padding:7px 12px;border-radius:18px;white-space:nowrap}
.bar{max-width:900px;margin:8px auto 0;display:flex;gap:6px;overflow-x:auto}.chip{white-space:nowrap;text-decoration:none;font-size:13px;padding:6px 12px;border-radius:16px;background:rgba(255,255,255,.18);color:#fff;border:0;cursor:pointer}.chip.on{background:#fff;color:#1b7f3b;font-weight:600}
main{max-width:900px;margin:0 auto;padding:12px 12px 110px}.box{background:#fff;border-radius:12px;padding:12px 14px;margin-bottom:10px}
.where{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:14px}.where select,.where button{font:inherit;font-size:14px;padding:7px 10px;border-radius:8px;border:1px solid #cfd8d2;background:#fff}.where button{background:#1b7f3b;color:#fff;border-color:#1b7f3b;cursor:pointer}
.shop{display:flex;gap:12px;align-items:center;text-decoration:none;background:#fff;border-radius:12px;padding:12px 14px;margin-bottom:10px}.shop .ic{font-size:30px;width:52px;height:52px;border-radius:12px;background:#e6f4ea;display:flex;align-items:center;justify-content:center}
.shop b{display:block;font-size:16px}.mt{color:#5b6b60;font-size:13px}.go{margin-left:auto;color:#1b7f3b;font-weight:700}
h2{font-size:15px;margin:16px 4px 8px;color:#1b7f3b}.it{display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:10px 12px;margin-bottom:6px}
.it .nm{flex:1}.it .nm b{display:block;font-size:15px;font-weight:600}.pr{font-weight:700}.qty{display:flex;align-items:center;gap:6px}
.qty button{width:34px;height:34px;border-radius:50%;border:1px solid #1b7f3b;background:#fff;color:#1b7f3b;font-size:18px;font-weight:700;cursor:pointer}.qty button.add{background:#1b7f3b;color:#fff;width:auto;border-radius:18px;padding:0 14px;font-size:14px}
.qty span{min-width:18px;text-align:center;font-weight:700}.out{color:#b42318;font-size:12px}
.cartbar{position:fixed;left:0;right:0;bottom:0;background:#1b7f3b;color:#fff;padding:12px 16px;display:none;align-items:center;gap:10px;z-index:9;box-shadow:0 -2px 10px rgba(0,0,0,.15)}.cartbar b{font-size:16px}.cartbar button{margin-left:auto;background:#fff;color:#1b7f3b;border:0;border-radius:20px;padding:10px 18px;font-weight:700;font-size:15px;cursor:pointer}
.sheet{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:20;align-items:flex-end;justify-content:center}.sheet .in{background:#fff;width:100%;max-width:560px;border-radius:16px 16px 0 0;padding:16px;max-height:90vh;overflow:auto}
.sheet h3{margin:0 0 10px}.ln{display:flex;justify-content:space-between;font-size:14px;padding:3px 0}.opt{display:flex;gap:8px;align-items:center;padding:9px 10px;border:1px solid #d9e2dc;border-radius:10px;margin:6px 0;font-size:15px}
textarea{width:100%;font:inherit;padding:8px;border:1px solid #cfd8d2;border-radius:8px;min-height:70px}.big{width:100%;background:#25d366;color:#fff;border:0;border-radius:24px;padding:13px;font-size:16px;font-weight:700;cursor:pointer;margin-top:10px}
.btn{display:inline-block;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:22px;background:#25d366;color:#fff}.err{color:#b42318;font-size:14px;margin-top:6px}
footer{text-align:center;color:#5b6b60;font-size:13px;padding:20px}`;

function layout(title, body, chips = '') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="Order from shops near you – pickup or home delivery"><style>${CSS}</style></head><body>
<header><div class="top"><a href="/shops" style="text-decoration:none;display:flex;gap:8px;align-items:center"><span style="font-size:24px">🛒</span><b>${esc(cfg.BRAND)}</b></a><a class="wa" href="${waLink('Hi')}">💬 WhatsApp</a></div>${chips ? `<div class="bar">${chips}</div>` : ''}</header>
<main>${body}</main><footer>${esc(cfg.BRAND)} · order from local shops · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></footer></body></html>`;
}

// ---------- personal link from WhatsApp
r.get('/u/:token', async (req, res) => {
  const l = await db.one('select * from cust_links where token=$1', [String(req.params.token).slice(0, 40)]);
  if (!l) return res.redirect('/shops');
  res.setHeader('Set-Cookie', `em_u=${encodeURIComponent(l.token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 86400}`);
  if (req.query.shop) return res.redirect('/s/' + (+req.query.shop || 0));
  res.redirect(l.lat != null ? `/shops?lat=${l.lat.toFixed(5)}&lng=${l.lng.toFixed(5)}` : '/shops');
});

// ---------- shops list
r.get('/shops', async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng), area = +req.query.area || 0;
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
  const live = await db.shops.live(), areas = await db.areas.active();
  let list;
  if (hasLoc) list = await bot.nearbyShops({ lat, lng });
  else list = live.filter((s) => !area || s.area_id === area).map((s) => ({ s, d: null }));
  const counts = Object.fromEntries((await db.all('select shop_id, count(*)::int n from items where stock>0 group by shop_id')).map((x) => [x.shop_id, x.n]));
  const where = `<div class="box where">${hasLoc ? '📍 Shops that serve your location' : area ? `🗺 ${esc((areas.find((a) => a.id === area) || {}).name || '')}` : '🏪 All shops'}
<button type="button" onclick="loc()">Use my location</button>${areas.length ? `<select onchange="if(this.value)location=this.value"><option value="">Pick an area…</option>${areas.map((a) => `<option value="/shops?area=${a.id}"${a.id === area ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}</div>
<script>function loc(){if(!navigator.geolocation)return alert('Location not available');navigator.geolocation.getCurrentPosition(function(p){location='/shops?lat='+p.coords.latitude.toFixed(5)+'&lng='+p.coords.longitude.toFixed(5)},function(){alert('Please allow location, or pick an area')})}</script>`;
  const rows = list.map(({ s, d }) => `<a class="shop" href="/s/${s.id}"><span class="ic">🏪</span><span><b>${esc(s.name)}</b><span class="mt">${esc(s.area || '')}${d != null ? ' · 📍 ' + fmtKm(d) : ''} · ${counts[s.id] || 0} items<br>${s.delivery ? `🛵 Delivery ${rs(s.del_fee)} · 🏃 Pickup` : '🏃 Pickup only'}</span></span><span class="go">›</span></a>`).join('');
  res.send(layout(`${cfg.BRAND} – Shops near you`, where + (rows || `<div class="box">No shops ${hasLoc ? 'serve your location' : 'here'} yet. Try another area.</div>`)));
});

// ---------- one shop
r.get('/s/:id', async (req, res) => {
  const s = await db.shops.get(+req.params.id || 0);
  if (!s || !s.active || !s.paid) return res.status(404).send(layout('Shop not available', `<div class="box">This shop isn't taking orders right now.<br><br><a class="btn" href="/shops">See other shops</a></div>`));
  const its = await db.items.byShop(s.id), who = await me(req);
  const cats = await require('./catalog').sortCats(s, [...new Set(its.map((i) => i.cat))]);
  const chips = `<button class="chip on" onclick="window.scrollTo({top:0,behavior:'smooth'})">All</button>` + cats.map((c, k) => `<a class="chip" href="#c${k}">${esc(c)}</a>`).join('');
  const sections = cats.map((c, k) => `<h2 id="c${k}">${esc(c)}</h2>` + its.filter((i) => i.cat === c).map((i) => `<div class="it"><div class="nm"><b>${esc(i.name)}</b><span class="pr">${rs(i.price)}</span>${i.stock === 0 ? ' <span class="out">Out of stock</span>' : i.stock < 5 ? ` <span class="out">Only ${i.stock} left</span>` : ''}</div>
${i.stock > 0 ? `<div class="qty" data-id="${i.id}"></div>` : ''}</div>`).join('')).join('');
  const data = { shop: { id: s.id, name: s.name, delivery: !!s.delivery, fee: Number(s.del_fee), min: Number(s.min_order || 0), upi: !!s.upi }, items: Object.fromEntries(its.map((i) => [i.id, { n: i.name, p: Number(i.price), st: i.stock }])), known: !!who };
  const body = `<div class="box"><b style="font-size:18px">🏪 ${esc(s.name)}</b><div class="mt">${esc(s.area || '')} · ${s.delivery ? `🛵 Home delivery ${rs(s.del_fee)}${s.min_order ? ` (min ${rs(s.min_order)})` : ''} · 🏃 Pickup` : '🏃 Store pickup only'}</div>
<input id="q" placeholder="Search items…" style="width:100%;margin-top:10px;font:inherit;padding:9px 10px;border:1px solid #cfd8d2;border-radius:8px" oninput="search(this.value)"></div>
${sections || '<div class="box">This shop hasn’t added items yet.</div>'}
<div class="cartbar" id="bar"><b id="bt"></b><button onclick="openSheet()">View cart ›</button></div>
<div class="sheet" id="sheet" onclick="if(event.target===this)closeSheet()"><div class="in"><h3>🛒 Your cart</h3><div id="lines"></div>
<div id="modeBox"><p><b>How do you want it?</b></p><label class="opt"><input type="radio" name="mode" value="pickup" checked onchange="draw()"> 🏃 Pickup at shop</label>
${s.delivery ? `<label class="opt"><input type="radio" name="mode" value="delivery" onchange="draw()"> 🛵 Home delivery +${rs(s.del_fee)}</label><div id="addrBox" style="display:none"><textarea id="addr" placeholder="House no, street, landmark"></textarea></div>` : ''}
<p><b>Payment</b></p>${s.upi ? `<label class="opt"><input type="radio" name="pay" value="UPI"> 💳 Pay by UPI</label>` : ''}<label class="opt"><input type="radio" name="pay" value="Cash" checked> 💵 <span id="cashLbl">Pay at shop</span></label></div>
<div id="tot" style="margin-top:8px"></div><div class="err" id="err"></div>
<button class="big" id="go" onclick="place()">${who ? '✅ Place order' : '💬 Place order on WhatsApp'}</button>
<p class="mt" style="text-align:center">${who ? 'Updates and your invoice come on WhatsApp.' : 'Opens WhatsApp with your order code – just tap Send.'}</p></div></div>
<script>
const D=${JSON.stringify(data).replace(/</g, '\\u003c')};const KEY='em_cart_'+D.shop.id;let cart={};try{cart=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
const rs=n=>'₹'+Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
function save(){try{localStorage.setItem(KEY,JSON.stringify(cart))}catch(e){}}
function setQ(id,q){const it=D.items[id];q=Math.max(0,Math.min(q,it.st));if(q)cart[id]=q;else delete cart[id];save();draw()}
function sub(){return Object.entries(cart).reduce((a,[id,q])=>a+(D.items[id]?D.items[id].p*q:0),0)}
function mode(){const m=document.querySelector('input[name=mode]:checked');return m?m.value:'pickup'}
function draw(){document.querySelectorAll('.qty').forEach(el=>{const id=el.dataset.id,q=cart[id]||0;el.innerHTML=q?'<button onclick="setQ('+id+','+(q-1)+')">−</button><span>'+q+'</span><button onclick="setQ('+id+','+(q+1)+')">+</button>':'<button class="add" onclick="setQ('+id+',1)">Add</button>'});
 const n=Object.values(cart).reduce((a,b)=>a+b,0),bar=document.getElementById('bar');bar.style.display=n?'flex':'none';document.getElementById('bt').textContent=n+' item'+(n>1?'s':'')+' · '+rs(sub());
 document.getElementById('lines').innerHTML=Object.entries(cart).map(([id,q])=>'<div class="ln"><span>'+q+' × '+D.items[id].n.replace(/</g,'&lt;')+'</span><span>'+rs(q*D.items[id].p)+'</span></div>').join('');
 const del=mode()==='delivery';const ab=document.getElementById('addrBox');if(ab)ab.style.display=del?'block':'none';document.getElementById('cashLbl').textContent=del?'Cash on delivery':'Pay at shop';
 const fee=del?D.shop.fee:0;document.getElementById('tot').innerHTML='<div class="ln"><span>Items</span><span>'+rs(sub())+'</span></div>'+(fee?'<div class="ln"><span>Delivery</span><span>'+rs(fee)+'</span></div>':'')+'<div class="ln"><b>Total</b><b>'+rs(sub()+fee)+'</b></div>'+(del&&D.shop.min>sub()?'<div class="err">Home delivery needs a minimum of '+rs(D.shop.min)+'</div>':'')}
function openSheet(){draw();document.getElementById('sheet').style.display='flex'}function closeSheet(){document.getElementById('sheet').style.display='none'}
function search(t){t=t.toLowerCase();document.querySelectorAll('.it').forEach(el=>{el.style.display=el.textContent.toLowerCase().includes(t)?'flex':'none'})}
async function place(){const err=document.getElementById('err');err.textContent='';const m=mode(),a=document.getElementById('addr');
 if(m==='delivery'&&(!a||a.value.trim().length<8)){err.textContent='Please enter your full delivery address.';return}
 const body={cart,mode:m,addr:a?a.value.trim():'',pay:(document.querySelector('input[name=pay]:checked')||{}).value||'Cash'};
 const b=document.getElementById('go');b.disabled=true;b.textContent='Please wait…';
 try{const r=await fetch('/s/'+D.shop.id+'/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();
  if(j.error){err.textContent=j.error;b.disabled=false;b.textContent=D.known?'✅ Place order':'💬 Place order on WhatsApp';return}
  cart={};save();if(j.wa){location=j.wa;return}location=j.done}catch(e){err.textContent='Network problem. Please try again.';b.disabled=false}}
draw();
</script>`;
  res.send(layout(`${s.name} – ${cfg.BRAND}`, body, chips));
});

// ---------- place an order from the website
r.post('/s/:id/order', async (req, res) => {
  const s = await db.shops.get(+req.params.id || 0);
  if (!s || !s.active || !s.paid) return res.json({ error: 'This shop is not taking orders right now.' });
  const b = req.body || {}, cart = {};
  for (const [id, q] of Object.entries(b.cart || {})) { const n = parseInt(q, 10); if (n > 0 && n <= 999 && /^\d+$/.test(id)) cart[id] = n; }
  if (!Object.keys(cart).length) return res.json({ error: 'Your cart is empty.' });
  const mode = b.mode === 'delivery' ? 'delivery' : 'pickup', payMode = b.pay === 'UPI' && s.upi ? 'UPI' : 'Cash', addr = String(b.addr || '').trim().slice(0, 300);
  if (mode === 'delivery') {
    if (!s.delivery) return res.json({ error: 'This shop offers pickup only.' });
    if (addr.length < 8) return res.json({ error: 'Please enter your full delivery address.' });
    const its = await db.items.byShop(s.id), sub = Object.entries(cart).reduce((a, [id, q]) => { const i = its.find((x) => x.id === +id); return a + (i ? i.price * q : 0); }, 0);
    if (sub < Number(s.min_order || 0)) return res.json({ error: `Home delivery needs a minimum of ${rs(s.min_order)}.` });
  }
  const who = await me(req);
  if (who) {
    const r2 = await bot.createOrder({ s, phone: who.phone, name: '', cart, mode, addr, payMode });
    if (r2.err) return res.json({ error: r2.err.replace(/\*/g, '') });
    await bot.orderPlaced(r2.o, s, r2.lines, payMode);
    return res.json({ done: `/done/${r2.o.token}` });
  }
  // Unknown visitor: keep the cart and let them confirm on WhatsApp (that gives us their number)
  const code = 'W' + crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  await db.q('insert into web_orders(code,shop_id,cart,mode,addr,pay) values($1,$2,$3,$4,$5,$6)', [code, s.id, JSON.stringify(cart), mode, addr, payMode]);
  await db.q(`delete from web_orders where created_at < now() - interval '2 days'`);
  res.json({ wa: waLink(`Order ${code}`) });
});

// ---------- order placed page
r.get('/done/:token', async (req, res) => {
  const o = await db.one('select * from orders where token=$1', [String(req.params.token).slice(0, 40)]);
  if (!o) return res.redirect('/shops');
  const s = await db.shops.get(o.shop_id);
  const upi = o.pay === 'UPI' && s.upi ? `upi://pay?${new URLSearchParams({ pa: s.upi, pn: s.name, am: Number(o.total).toFixed(2), cu: 'INR', tn: 'Order ' + o.id }).toString().replace(/\+/g, '%20')}` : null;
  res.send(layout(`Order #${o.id} placed`, `<div class="box" style="text-align:center"><div style="font-size:48px">🎉</div><h2 style="font-size:20px;color:#14231a">Order #${o.id} placed with ${esc(s.name)}</h2>
<p>Total <b>${rs(o.total)}</b> · ${o.mode === 'delivery' ? '🛵 Home delivery' : '🏃 Pickup at shop'}</p>
${upi ? `<p><a class="btn" href="${esc(upi)}">💳 Pay ${rs(o.total)} by UPI</a></p><p class="mt">UPI ID: ${esc(s.upi)} · note "Order ${o.id}"</p>` : `<p>${o.mode === 'delivery' ? 'Pay cash on delivery.' : 'Pay at the shop.'}</p>`}
<p class="mt">Your invoice and order updates are on WhatsApp.</p><p><a href="/inv/${o.token}.pdf">📄 Invoice</a> · <a href="/s/${s.id}">Order more</a></p></div>`));
});

module.exports = r;
