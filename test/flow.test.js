// End-to-end flow test: simulates WhatsApp messages from admin, owner, customer.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/bazaar';
process.env.PUBLIC_URL = 'https://example.test';
process.env.ADMIN_PHONES = '9003264537';
const assert = require('assert');
const db = require('../src/db'); const wa = require('../src/wa'); const bot = require('../src/bot');
const ADMIN = '919003264537', OWNER = '919840011111', CUST = '919876543210';
const box = {}; let lastBody;
wa.setSink((b) => {
  (box[b.to] = box[b.to] || []).push(b); lastBody = b;
  if (b.type === 'interactive') { const it = b.interactive;
    if (it.type === 'button') assert(it.action.buttons.length <= 3 && it.action.buttons.every((x) => x.reply.title.length <= 20));
    else { assert(it.action.sections[0].rows.length <= 10); it.action.sections[0].rows.forEach((r) => assert(r.title.length <= 24)); }
    assert(it.body.text.length <= 1024); }
  return {};
});
const last = (p) => box[p][box[p].length - 1];
const txt = (m) => m.type === 'text' ? m.text.body : m.type === 'document' ? '[doc] ' + m.document.link : m.interactive.body.text;
const opts = (m) => m.type !== 'interactive' ? [] : m.interactive.type === 'button' ? m.interactive.action.buttons.map((b) => [b.reply.title, b.reply.id]) : m.interactive.action.sections[0].rows.map((r) => [r.description || r.title, r.id]);
const find = (p, label) => { for (let i = box[p].length - 1; i >= 0; i--) { const o = opts(box[p][i]).find(([l]) => l.includes(label)); if (o) return o[1]; } throw new Error(`no button "${label}" for ${p}`); };
const say = (p, t) => bot.handle(p, p === CUST ? 'Priya' : 'X', t, false);
const loc = (p, lat, lng, label = '') => bot.handle(p, 'X', `loc:${lat},${lng}|${label}`, true);
const tap = (p, label) => bot.handle(p, p === CUST ? 'Priya' : 'X', find(p, label), true);
(async () => {
  await db.q('drop table if exists shops, items, orders, sessions, menus, payments, areas cascade'); await db.init();
  await say(ADMIN, 'hi'); assert(/admin/i.test(txt(last(ADMIN))));
  await tap(ADMIN, 'Add new shop'); await say(ADMIN, 'Sri Murugan Stores'); await say(ADMIN, '98400 11111'); await say(ADMIN, 'Anna Nagar'); await tap(ADMIN, 'Yes, opt in');
  assert(txt(box[OWNER][0]).includes('Welcome'));
  await say(OWNER, 'Ponni Rice 5kg | Rice & Grains | 320 | 25; Toor Dal 1kg | Pulses | 165 | 6; Ghee 500ml | Oil & Ghee | 340 | 6; Sugar 1kg | Essentials | 48 | 30');
  assert(txt(last(OWNER)).includes('4 item(s) saved'));
  for (let i = 0; i < 12; i++) await say(OWNER, `Item${i} 1kg | Misc | ${10 + i} | 10`);
  await say(OWNER, 'price sugar 52'); assert(txt(last(OWNER)).includes('₹52'));
  await say(OWNER, 'upi murugan@okaxis'); await say(OWNER, 'minorder 200');
  await say(CUST, 'hi'); assert(txt(last(CUST)).includes('No shops'));
  await tap(OWNER, 'Pay setup fee'); console.log('OWNER pay:', txt(last(OWNER)).split('\n').slice(0,3).join(' / '));
  await tap(ADMIN, 'Mark'); assert(txt(last(OWNER)).includes('LIVE'));
  await say(CUST, 'hi'); await tap(CUST, 'Sri Murugan'); await tap(CUST, 'Pulses'); await tap(CUST, 'Toor Dal'); await tap(CUST, 'One more');
  await tap(CUST, 'Categories'); await tap(CUST, 'Oil'); await tap(CUST, 'Ghee');
  await say(CUST, 'misc'); console.log('search rows:', opts(last(CUST)).length, opts(last(CUST)).map((o) => o[1]).slice(-2));
  await tap(CUST, 'More options'); console.log('page2:', opts(last(CUST)).map((o) => o[0]).join(' | '));
  await tap(CUST, 'Checkout'); await tap(CUST, 'Delivery'); await say(CUST, '12, 3rd Street, Anna Nagar West'); await tap(CUST, 'Pay now (UPI)');
  console.log('CUST:', box[CUST].slice(-3).map(txt).join('\n---\n'));
  console.log('OWNER:', box[OWNER].slice(-2).map(txt).join('\n---\n'));
  console.log('ADMIN:', txt(last(ADMIN)));
  const oid = 1001;
  await tap(OWNER, 'Accept #1001'); await tap(OWNER, 'Mark ready #1001'); assert(txt(last(ADMIN)).includes('Pickup ready'));
  await tap(ADMIN, 'Dispatch #1001'); await tap(ADMIN, 'Delivered #1001');
  assert(txt(box[CUST].slice(-1)[0]).includes('completed'));
  const o = await db.orders.get(oid); assert.equal(o.status, 'Completed'); assert(o.paid); assert.equal(o.inv, 'INV-SMS-0001');
  const stock = await db.items.find(1, 'toor'); assert.equal(stock.stock, 4);
  // pickup + reject flow
  await say(CUST, 'hi'); await tap(CUST, 'Sri Murugan'); await say(CUST, 'sugar'); await tap(CUST, 'Sugar'); await say(CUST, 'checkout'); await tap(CUST, 'Pickup'); await tap(CUST, 'Pay at shop');
  await tap(OWNER, 'Reject #1002'); assert(txt(last(CUST)).includes("couldn't accept"));
  assert.equal((await db.items.find(1, 'sugar')).stock, 30);
  await tap(ADMIN, 'Sales'); console.log('ADMIN sales:', txt(last(ADMIN)));
  await say(ADMIN, '#customer'); assert(txt(last(ADMIN)).includes('Choose a shop')); await say(ADMIN, '#admin'); assert(/admin/i.test(txt(last(ADMIN))));

  // ---------- multi-locality ----------
  const AADMIN = '919111122222', OWNER2 = '919222233333', CUST2 = '919333344444';
  await say(ADMIN, 'hi'); await tap(ADMIN, 'Areas'); await tap(ADMIN, 'Add area');
  await say(ADMIN, 'KK Nagar'); await say(ADMIN, '91111 22222'); await loc(ADMIN, 13.0400, 80.2000); await tap(ADMIN, '3 km');
  assert(txt(box[AADMIN][0]).includes('area admin'));
  await say(AADMIN, 'hi'); assert(/Area admin/.test(txt(last(AADMIN))));
  await tap(AADMIN, 'Add new shop'); await say(AADMIN, 'Fresh Mart'); await say(AADMIN, '92222 33333'); await say(AADMIN, 'KK Nagar Main Rd'); await tap(AADMIN, 'Yes, opt in');
  assert(txt(last(OWNER2)).includes('Welcome'));
  const fm = await db.one("select * from shops where name='Fresh Mart'"); assert(fm.area_id);
  await say(OWNER2, 'Tomato 1kg | Vegetables | 32 | 40'); await say(OWNER2, 'upi fresh@okaxis');
  await tap(OWNER2, 'Menu'); await tap(OWNER2, 'Settings'); await tap(OWNER2, 'Set shop location'); await loc(OWNER2, 13.0410, 80.2010);
  assert(txt(last(OWNER2)).includes('location saved'));
  await tap(AADMIN, 'Mark'); assert(txt(last(OWNER2)).includes('LIVE'));
  // area admin must not see shop 1 (no area)
  await say(AADMIN, 'menu'); await tap(AADMIN, 'Manage shops'); assert(!txt(last(AADMIN)).includes('Sri Murugan'));
  // customer near KK Nagar sees Fresh Mart with distance; Sri Murugan (no location) not listed
  await say(CUST2, 'hi'); assert(txt(last(CUST2)).includes('Share your location'));
  await loc(CUST2, 13.0420, 80.2020, 'Home');
  console.log('NEARBY:', opts(last(CUST2)).map((o) => o[0]).join(' | '));
  await tap(CUST2, 'Fresh Mart'); await tap(CUST2, 'Vegetables'); await tap(CUST2, 'Tomato'); await tap(CUST2, 'Checkout'); await tap(CUST2, 'Delivery');
  await say(CUST2, 'checkout'); // ignore - then share location as address
  await tap(CUST2, 'Delivery'); await loc(CUST2, 13.0425, 80.2025, 'Flat 4, Lake View');
  // min order 0 -> asks pay
  await tap(CUST2, 'Pay now'); const o2 = await db.one('select * from orders order by id desc limit 1'); assert(o2.addr.includes('maps.google'));
  // delivery request goes to area admin, not main admin
  const beforeAdmin = box[ADMIN].length;
  await tap(OWNER2, 'Accept #' + o2.id); await tap(OWNER2, 'Mark ready #' + o2.id);
  assert(txt(last(AADMIN)).includes('Pickup ready')); assert.equal(box[ADMIN].length, beforeAdmin);
  await tap(AADMIN, 'Dispatch #' + o2.id); await tap(AADMIN, 'Delivered #' + o2.id);
  await say(AADMIN, 'menu'); await tap(AADMIN, 'Sales'); console.log('AREA ADMIN SALES:', txt(last(AADMIN)));
  await say(ADMIN, 'menu'); await tap(ADMIN, 'Sales'); console.log('MAIN SALES:', txt(last(ADMIN)));
  // far-away customer sees no shops
  await loc(CUST2, 13.20, 80.30); assert(txt(last(CUST2)).includes('No shops'));
  const inv = require('../src/invoice'); const pdf = await inv.pdf(o, await db.shops.get(1)); assert(pdf.slice(0, 4).toString() === '%PDF');
  const dash = await require('../src/dashboard').html(); assert(dash.includes('INV-SMS-0001'));
  // ---- website shop + personal link from WhatsApp
  process.env.BOT_PHONE = '6383087827';
  const tok = (await db.one('select token, lat from cust_links where phone=$1', [CUST2]));
  assert(tok && tok.lat, 'location saved for web link');
  await loc(CUST2, 13.0420, 80.2020); assert(txt(last(CUST2)).includes('/u/' + tok.token), 'nearby list has web link');
  const { app } = require('../src/index'); const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  let r = await fetch(`${base}/u/${tok.token}`, { redirect: 'manual' }); assert.equal(r.status, 302);
  const ck = r.headers.get('set-cookie').split(';')[0]; assert(r.headers.get('location').startsWith('/shops?lat='));
  let h = await (await fetch(base + r.headers.get('location'))).text(); assert(h.includes('Fresh Mart') && !h.includes('Sri Murugan'), 'nearby shops only');
  h = await (await fetch(`${base}/shops`)).text(); assert(h.includes('Sri Murugan') && h.includes('Fresh Mart'));
  h = await (await fetch(`${base}/s/${fm.id}`)).text(); assert(h.includes('Tomato 1kg') && h.includes('Vegetables'));
  const tom = await db.one("select * from items where name='Tomato 1kg'");
  // known customer (cookie): order placed directly, shop owner notified
  const ownerBefore = box[OWNER2].length;
  r = await fetch(`${base}/s/${fm.id}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ cart: { [tom.id]: 2 }, mode: 'pickup', pay: 'UPI' }) });
  let j = await r.json(); assert(j.done, JSON.stringify(j));
  const o3 = await db.one('select * from orders order by id desc limit 1'); assert.equal(o3.cust_phone, CUST2); assert.equal(Number(o3.total), 64); assert.equal(o3.pay, 'UPI');
  assert(box[OWNER2].slice(ownerBefore).some((m) => txt(m).includes('New order #' + o3.id)), 'owner told');
  assert(box[CUST2].some((m) => txt(m).includes('Order #' + o3.id + ' placed')), 'customer told on WhatsApp');
  h = await (await fetch(base + j.done)).text(); assert(h.includes('upi://pay') && h.includes('#' + o3.id));
  assert.equal((await db.items.get(tom.id)).stock, tom.stock - 2, 'stock reduced');
  // too many
  j = await (await fetch(`${base}/s/${fm.id}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ cart: { [tom.id]: 999 }, mode: 'pickup', pay: 'Cash' }) })).json();
  assert(j.error && j.error.includes('only'));
  // unknown visitor: gets a WhatsApp code; sending it places the order
  j = await (await fetch(`${base}/s/${fm.id}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cart: { [tom.id]: 1 }, mode: 'delivery', addr: '12, Lake View Road, near temple', pay: 'Cash' }) })).json();
  assert(j.wa && j.wa.includes('wa.me/916383087827'), JSON.stringify(j));
  const code = decodeURIComponent(j.wa.split('text=')[1]); const NEWC = '919811112222';
  await bot.handle(NEWC, 'Ravi', code, false); assert(box[NEWC].some((m) => txt(m).includes('placed* with Fresh Mart')), 'web code order');
  const o4 = await db.one('select * from orders order by id desc limit 1'); assert.equal(o4.cust_phone, NEWC); assert.equal(o4.mode, 'delivery'); assert(o4.addr.includes('Lake View'));
  await bot.handle(NEWC, 'Ravi', code, false); assert(txt(last(NEWC)).includes('expired'), 'code used once');
  await bot.handle(OWNER2, 'X', code, false); // owner sending a code goes to customer flow, not owner commands
  srv.close();
  console.log('✔ website shop: personal link, nearby shops, cart order, WhatsApp code order');
  console.log('\n✅ ALL FLOWS PASSED'); process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
