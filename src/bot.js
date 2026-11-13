// Conversation logic for the three roles: Admin, Shop owner, Customer.
// Mirrors the approved prototype.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');
const wa = require('./wa');
const pay = require('./pay');
const invoice = require('./invoice');

const rs = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const MONTH = () => new Date().toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
const MONTH_KEY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
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
      await notify(ck, `📦 Order #${n} is packed. A ${cfg.BRAND} rider will pick it up shortly.`);
      await notifyAdmins(`📦 *Pickup ready* — order #${n}\nFrom: ${s.name}, ${s.area}\nTo: ${o.addr}\nCustomer: +${o.cust_phone}\nCollect: ${o.paid ? 'Prepaid' : rs(o.total) + ' cash'}`,
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

async function activate(s) {
  if (s.paid) return false;
  s = await db.shops.set(s.id, { paid: true, active: true, paid_at: new Date() });
  await db.q(`update payments set status='paid', paid_at=coalesce(paid_at,now()) where kind='setup' and ref=$1`, [s.id]);
  const n = await itemCount(s.id);
  await notify(s.owner_phone, `🎉 Payment of ${rs(cfg.SETUP_FEE)} received.\n*${s.name} is now LIVE* — customers can order from you on WhatsApp.\n\nBilling: ${cfg.COMM * 100}% of monthly sales, sent at the start of every month.${n ? '' : '\n\n👉 Add your items to start getting orders.'}`,
    [['➕ Add items', 'additem'], ['Menu', 'menu']]);
  await notifyAdmins(`💰 Setup fee ${rs(cfg.SETUP_FEE)} received from *${s.name}*. Shop is now live.`, [['🏪 Manage shops', 'list']]);
  return true;
}

async function adminMenu(c) {
  c.sess.state = null;
  return c.reply(`👑 *${cfg.BRAND} — Admin*\nWhat would you like to do?`, [['➕ Add new shop', 'add'], ['🏪 Manage shops', 'list'], ['📊 Sales & commission', 'sales'], ['🛵 Delivery desk', 'deliv'], ['🌐 Web dashboard', 'web']]);
}

async function admin(c, v, btn) {
  const S = c.sess, low = v.trim().toLowerCase();
  let m;
  if (MENU_WORDS.includes(low)) return adminMenu(c);
  if (!btn && S.state === 'a_name') { S.data.ns = { name: v.trim() }; S.state = 'a_owner'; return c.reply(`Shop: *${S.data.ns.name}*\nSend the owner's WhatsApp number.`); }
  if (!btn && S.state === 'a_owner') {
    const n = v.replace(/\D/g, '');
    if (n.length < 10) return c.reply('Please send a valid 10-digit mobile number.');
    S.data.ns.owner = cfg.norm(n.slice(-10)); S.state = 'a_area';
    return c.reply('Area / locality of the shop?');
  }
  if (!btn && S.state === 'a_area') { S.data.ns.area = v.trim(); S.state = 'a_del'; return c.reply('Will this shop use *your home-delivery service*?', [['🛵 Yes, opt in', 'del:y'], ['🏃 No, pickup only', 'del:n']]); }
  if ((m = v.match(/^del:(y|n)$/)) && S.state === 'a_del' && S.data.ns) {
    const ns = S.data.ns; S.state = null; delete S.data.ns;
    const s = await db.one('insert into shops(code,name,owner_phone,area,delivery) values($1,$2,$3,$4,$5) returning *', [await mkCode(ns.name), ns.name, ns.owner, ns.area, m[1] === 'y']);
    await c.reply(`✅ *${s.name}* added (code ${s.code})\n📍 ${s.area} · 📱 +${s.owner_phone}\n${s.delivery ? '🛵 Home delivery by you: ON' : '🏃 Pickup only'}\n\n📩 Welcome message + ${rs(cfg.SETUP_FEE)} setup-fee request sent to the owner.\n_If the owner has never messaged this bot, ask them to send *hi* to this number once._`,
      [[`✅ Mark ${rs(cfg.SETUP_FEE)} received`, 'paid:' + s.id], ['🏪 Manage shops', 'list'], ['Menu', 'menu']]);
    return ownerWelcome(s);
  }
  if (v === 'add') { S.state = 'a_name'; return c.reply('➕ *New shop*\nSend the shop name.'); }
  if (v === 'web') return c.reply(cfg.PUBLIC_URL ? `🌐 Dashboard:\n${cfg.PUBLIC_URL}/admin?key=${encodeURIComponent(cfg.ADMIN_KEY)}` : 'Set PUBLIC_URL to enable the web dashboard.', [['Menu', 'menu']]);
  if (v === 'list') {
    const shops = await db.shops.all();
    if (!shops.length) return c.reply('No shops yet.', [['➕ Add new shop', 'add']]);
    const lines = [];
    for (const [i, s] of shops.entries()) lines.push(`${i + 1}. ` + shopLine(s, await itemCount(s.id)));
    return c.reply('🏪 *Your shops*\n\n' + lines.join('\n\n'), shops.map((s) => ['⚙️ ' + s.name, 'shop:' + s.id]).concat([['Menu', 'menu']]));
  }
  if ((m = v.match(/^shop:(\d+)$/))) {
    const s = await db.shops.get(+m[1]); if (!s) return c.reply('Shop not found.');
    const b = [];
    if (!s.paid) b.push([`✅ Mark ${rs(cfg.SETUP_FEE)} received`, 'paid:' + s.id]);
    else b.push([s.active ? '⏸ Pause shop' : '▶️ Resume shop', 'tog:' + s.id]);
    b.push([s.delivery ? '🛵 Turn delivery OFF' : '🛵 Turn delivery ON', 'dtog:' + s.id], ['🏪 All shops', 'list'], ['Menu', 'menu']);
    const ms = await db.shops.monthSales(s.id);
    return c.reply(shopLine(s, await itemCount(s.id)) + `\n\n📱 Owner: +${s.owner_phone}\n💳 UPI: ${s.upi || 'not set'}\n💰 ${MONTH()} sales: ${rs(ms)}\n🧾 Your ${cfg.COMM * 100}%: ${rs(ms * cfg.COMM)}\n🛵 Delivery charge: ${rs(s.del_fee)} · Min order ${rs(s.min_order)}`, b);
  }
  if ((m = v.match(/^paid:(\d+)$/))) {
    const s = await db.shops.get(+m[1]); if (!s) return c.reply('Shop not found.');
    if (!(await activate(s))) return c.reply('✅ Setup fee was already received.', [['Menu', 'menu']]);
    return;
  }
  if ((m = v.match(/^tog:(\d+)$/))) {
    let s = await db.shops.get(+m[1]); s = await db.shops.set(s.id, { active: !s.active });
    await notify(s.owner_phone, s.active ? `▶️ Your shop is live again on ${cfg.BRAND}.` : '⏸ Your shop has been paused by the admin. Contact admin to resume.');
    return c.reply(`${s.name} is now ${s.active ? '🟢 live' : '⏸ paused'}.`, [['🏪 Manage shops', 'list']]);
  }
  if ((m = v.match(/^dtog:(\d+)$/))) {
    let s = await db.shops.get(+m[1]); s = await db.shops.set(s.id, { delivery: !s.delivery });
    await notify(s.owner_phone, `🛵 Home delivery by ${cfg.BRAND} is now *${s.delivery ? 'ON' : 'OFF'}* for your shop.`);
    return c.reply(`🛵 Delivery for ${s.name}: *${s.delivery ? 'ON' : 'OFF'}*`, [['⚙️ ' + s.name, 'shop:' + s.id], ['Menu', 'menu']]);
  }
  if (v === 'sales') {
    const shops = await db.shops.all();
    let tot = 0, gmv = 0; const lines = [];
    for (const s of shops) { const ms = await db.shops.monthSales(s.id); gmv += ms; tot += ms * cfg.COMM; lines.push(`*${s.name}*\n   Sales ${rs(ms)} → ${cfg.COMM * 100}% = *${rs(ms * cfg.COMM)}* · Setup ${s.paid ? '✅' : '⏳'}`); }
    const setup = shops.filter((s) => s.paid).length * cfg.SETUP_FEE;
    const del = (await db.one(`select coalesce(sum(del_fee),0) s from orders where status='Completed' and mode='delivery' and created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`)).s;
    return c.reply(`📊 *${MONTH()} summary*\n\n${lines.join('\n') || 'No shops yet.'}\n\nTotal shop sales: ${rs(gmv)}\n💰 Commission due to you: *${rs(tot)}*\n🛵 Delivery charges: ${rs(del)}\n💳 Setup fees collected (all time): ${rs(setup)}`, [['📩 Send commission bills', 'bills'], ['Menu', 'menu']]);
  }
  if (v === 'bills') {
    const live = (await db.shops.all()).filter((s) => s.paid);
    let sent = 0;
    for (const s of live) {
      const ms = await db.shops.monthSales(s.id), amt = Math.round(ms * cfg.COMM * 100) / 100;
      if (amt <= 0) continue;
      const p = await pay.createLink({ kind: 'bill', ref: s.id, month: MONTH_KEY(), amount: amt, description: `${cfg.BRAND} ${MONTH()} service fee – ${s.name}`, phone: s.owner_phone, name: s.name });
      await notify(s.owner_phone, `🧾 *${cfg.BRAND} — ${MONTH()} bill*\nYour sales: ${rs(ms)}\nService fee (${cfg.COMM * 100}%): *${rs(amt)}*\n\n${pay.payText(p)}`);
      sent++;
    }
    return c.reply(`📩 Commission bills sent to ${sent} shop(s) on WhatsApp.`, [['Menu', 'menu']]);
  }
  if (v === 'deliv') {
    const ds = await db.orders.activeDeliveries();
    if (!ds.length) return c.reply('🛵 No active delivery orders right now.', [['Menu', 'menu']]);
    const b = [];
    for (const o of ds) { if (o.status === 'Ready') b.push([`🛵 Dispatch #${o.id}`, 'disp:' + o.id]); if (o.status === 'Out for delivery') b.push([`✅ Delivered #${o.id}`, 'dlv:' + o.id]); }
    b.push(['Menu', 'menu']);
    return c.reply('🛵 *Delivery desk*\n\n' + ds.map((o) => `#${o.id} · ${o.shop_name} (${o.shop_area}) → ${o.addr}\n   📱 +${o.cust_phone} · ${rs(o.total)} ${o.paid ? '(prepaid)' : '(collect cash)'} · *${o.status}*`).join('\n\n'), b);
  }
  if ((m = v.match(/^disp:(\d+)$/))) {
    const o = await db.orders.get(+m[1]); if (!o) return c.reply('Order not found.');
    if (o.status !== 'Ready') return c.reply(`Order #${o.id} is ${o.status}.`, [['🛵 Delivery desk', 'deliv']]);
    await setStatus(o, 'Out for delivery');
    return c.reply(`🛵 Rider dispatched for #${o.id}.`, [[`✅ Delivered #${o.id}`, 'dlv:' + o.id], ['🛵 Delivery desk', 'deliv']]);
  }
  if ((m = v.match(/^dlv:(\d+)$/))) {
    const o = await db.orders.get(+m[1]); if (!o) return c.reply('Order not found.');
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
  return c.reply(`🏪 *${s.name}* — shop panel\n${!s.paid ? '⏳ Not live yet — setup fee pending' : s.active ? '🟢 Live for customers' : '⏸ Paused by admin'}\n\nQuick commands:\n_Name | Category | Price | Stock_ → add item\n_price Sugar 1kg 50_ → change price\n_stock Sugar 1kg 40_ → set stock`, b);
}

async function addItems(c, s, v) {
  const ok = [], bad = [];
  const list = await db.items.byShop(s.id);
  for (const line of v.split(/\n|;/).map((x) => x.trim()).filter(Boolean)) {
    const p = line.split('|').map((x) => x.trim());
    const price = parseFloat(p[2]), stock = parseInt(p[3], 10);
    if (p.length < 3 || !p[0] || !p[1] || isNaN(price) || price < 0) { bad.push(line); continue; }
    const cat = (list.find((i) => i.cat.toLowerCase() === p[1].toLowerCase()) || { cat: p[1] }).cat;
    const ex = list.find((i) => i.name.toLowerCase() === p[0].toLowerCase());
    if (ex) {
      const u = await db.one('update items set cat=$2, price=$3, stock=$4 where id=$1 returning *', [ex.id, cat, price, isNaN(stock) ? ex.stock : stock]);
      ok.push(`✏️ ${u.name} — ${rs(price)} · ${u.stock} in stock (updated)`);
    } else {
      const n = await db.one('insert into items(shop_id,name,cat,price,stock) values($1,$2,$3,$4,$5) returning *', [s.id, p[0], cat, price, isNaN(stock) ? 0 : stock]);
      list.push(n);
      ok.push(`➕ ${n.name} — ${rs(price)} · ${n.stock} in stock`);
    }
  }
  c.sess.state = null;
  return c.reply((ok.length ? `✅ *${ok.length} item(s) saved*\n` + ok.join('\n') : '') + (bad.length ? `\n\n⚠️ Couldn't read:\n${bad.join('\n')}\nFormat: _Name | Category | Price | Stock_` : ''),
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
  if (v === 'additem') { S.state = 'additem'; return c.reply('➕ Send items in this format — one per line, or separate with *;*\n\n_Name | Category | Price | Stock_\n\nExample:\nToor Dal 1kg | Pulses | 165 | 30; Sugar 1kg | Essentials | 48 | 50'); }
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
  if (v === 'settings') return c.reply(`⚙️ *Settings*\n\n🛵 Home delivery by ${cfg.BRAND}: *${s.delivery ? 'ON' : 'OFF'}*\nDelivery charge: ${rs(s.del_fee)}\nMin order for delivery: ${rs(s.min_order)}\n💳 UPI ID: ${s.upi || 'not set'}\n\nChange: _delfee 30_ · _minorder 200_ · _upi name@okaxis_`,
    [[s.delivery ? '🛵 Delivery OFF' : '🛵 Opt in delivery', 'dtog'], ['Menu', 'menu']]);
  if (v === 'dtog') {
    s = await db.shops.set(s.id, { delivery: !s.delivery });
    await notifyAdmins(`🛵 *${s.name}* turned home delivery *${s.delivery ? 'ON' : 'OFF'}*.`);
    return c.reply(`🛵 Home delivery by ${cfg.BRAND} is now *${s.delivery ? 'ON' : 'OFF'}*.`, [['⚙️ Settings', 'settings'], ['Menu', 'menu']]);
  }
  return c.reply("Sorry, I didn't get that. Type *menu* for options.\n_Tip: send *#customer* to shop as a customer, *#shop* to come back._", [['Menu', 'menu']]);
}

/* ============================================================== CUSTOMER */
async function custWelcome(c) {
  c.sess.state = null; c.sess.data.cart = {}; delete c.sess.data.shop;
  const live = await db.shops.live();
  if (!live.length) return c.reply(`🙏 Welcome to *${cfg.BRAND}*!\nNo shops are live yet. Please check back soon.`);
  return c.reply(`🙏 Welcome to *${cfg.BRAND}*!\nOrder from shops near you on WhatsApp — pickup or home delivery.\n\nChoose a shop:`,
    live.map((s) => [`🏪 ${s.name} · ${s.area}${s.delivery ? ' · 🛵' : ''}`, 'shop:' + s.id]).concat([['📦 My orders', 'my']]));
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
  const cats = [...new Set(its.map((i) => i.cat))];
  if (!cats.length) return c.reply(`*${s.name}* hasn't added items yet.`, [['🏠 Other shops', 'menu']]);
  return c.reply(`🏪 *${s.name}* · ${s.area}\n${s.delivery ? `🛵 Home delivery ${rs(s.del_fee)}${s.min_order ? ` (min ${rs(s.min_order)})` : ''} · 🏃 Pickup` : '🏃 Store pickup only'}\n\nTap a category or *type an item name* to search.`,
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
async function placeOrder(c, s, payMode) {
  const D = c.sess.data;
  const client = await db.pool.connect();
  let o, lines;
  try {
    await client.query('begin');
    lines = [];
    for (const [id, q] of Object.entries(D.cart || {})) {
      const i = (await client.query('select * from items where id=$1 and shop_id=$2 for update', [+id, s.id])).rows[0];
      if (!i) continue;
      if (i.stock < q) { await client.query('rollback'); return c.reply(`Sorry, *${i.name}* now has only ${i.stock} left. Please update your cart.`, [['🛒 Cart', 'cart']]); }
      await client.query('update items set stock=stock-$2 where id=$1', [i.id, q]);
      lines.push({ id: i.id, name: i.name, price: i.price, q, left: i.stock - q });
    }
    if (!lines.length) { await client.query('rollback'); return c.reply('Your cart is empty.', [['⬅ Categories', 'cats']]); }
    const sub = lines.reduce((a, l) => a + l.q * l.price, 0), del = D.mode === 'delivery' ? s.del_fee : 0;
    const seq = (await client.query('update shops set inv_seq=inv_seq+1 where id=$1 returning inv_seq', [s.id])).rows[0].inv_seq;
    o = (await client.query(`insert into orders(shop_id,cust_phone,cust_name,lines,subtotal,del_fee,total,mode,addr,pay,inv,token)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [s.id, c.from, c.name, JSON.stringify(lines.map(({ left, ...l }) => l)), sub, del, sub + del, D.mode, D.mode === 'delivery' ? D.addr : '', payMode,
      `INV-${s.code}-${String(seq).padStart(4, '0')}`, crypto.randomBytes(12).toString('hex')])).rows[0];
    await client.query('commit');
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  D.cart = {}; c.sess.state = null;
  const n = o.id;
  await c.reply(`🎉 *Order #${n} placed* with ${s.name}!${payMode === 'UPI' ? `\n\n💳 Please pay *${rs(o.total)}* to UPI ID:\n*${s.upi}*\n(write "Order ${n}" in the note). The shop confirms once they see it.` : ''}\nYou'll get updates right here.`);
  await sendInvoice(c.from, o, s, [['📦 My orders', 'my'], ['🏠 Shops', 'menu']]);
  await notify(s.owner_phone, `🔔 *New order #${n}*\n${o.cust_name || ''} · +${o.cust_phone}\n\n` + lines.map((l) => `${l.q} × ${l.name} = ${rs(l.q * l.price)}`).join('\n') +
    `\n\nTotal: *${rs(o.total)}* · ${payMode === 'UPI' ? 'UPI to you – check your UPI app before accepting' : 'Cash'}\n${o.mode === 'delivery' ? `🛵 Home delivery (${cfg.BRAND} rider)\n📍 ${o.addr}` : '🏃 Customer will pick up'}`,
  [[`✅ Accept #${n}`, 'acc:' + n], [`❌ Reject #${n}`, 'rej:' + n]]);
  const low = lines.filter((l) => l.left < 5);
  if (low.length) await notify(s.owner_phone, '⚠️ *Low stock alert*\n' + low.map((l) => `• ${l.name}: ${l.left} left`).join('\n') + '\nReply _stock Item qty_ to update.');
  if (o.mode === 'delivery') await notifyAdmins(`🛵 *New delivery order #${n}*\n${s.name} → ${o.addr}\n${rs(o.total)} ${payMode === 'UPI' ? '(UPI)' : '(collect cash)'} · waiting for shop to pack.`, [['🛵 Delivery desk', 'deliv']]);
}

async function customer(c, v, btn) {
  const S = c.sess, D = S.data;
  D.cart = D.cart || {};
  let low = v.trim().toLowerCase(), m;
  if (MENU_WORDS.includes(low) || low === 'shops') return custWelcome(c);
  if (!btn) { if (low === 'cart') v = 'cart'; if (low === 'checkout') v = 'checkout'; if (low === 'orders' || low === 'my orders') v = 'my'; }
  if (!btn && S.state === 'addr') {
    if (v.trim().length < 8) return c.reply('Please send the full address (house no, street, landmark).');
    D.addr = v.trim(); S.state = null; return askPay(c, await db.shops.get(D.shop));
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
  const low = String(v).trim().toLowerCase();
  try {
    if (btn && /^pg:\d+$/.test(v)) {
      const mrow = await db.one('select * from menus where phone=$1', [from]);
      if (mrow) return await sendPage(from, mrow.text, mrow.items, +v.slice(3));
    }
    const isAdmin = cfg.ADMINS.includes(from);
    c.ownShops = await db.shops.byOwner(from);
    if (low === '#customer') { sess.data.mode = 'customer'; return await custWelcome(c); }
    if (low === '#admin' || low === '#shop') delete sess.data.mode;
    let role = sess.data.mode === 'customer' ? 'customer' : isAdmin ? 'admin' : c.ownShops.length ? 'owner' : 'customer';
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
    await db.sessions.save(from, sess);
  }
}

module.exports = { handle, activate, notify, notifyAdmins, rs };
