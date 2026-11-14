process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/bazaar';
process.env.ADMIN_PHONES = '9003264537'; process.env.PUBLIC_URL = 'https://example.test'; process.env.ADMIN_KEY = 'k1';
const assert = require('assert'); const db = require('../src/db'); const wa = require('../src/wa'); const bot = require('../src/bot');
const sent = []; wa.setSink((b) => { sent.push(b); return {}; });
const { app } = require('../src/index');
(async () => {
  await db.q('drop table if exists shops, items, orders, sessions, menus, payments, areas, otps cascade'); await db.init();
  const srv = app.listen(3998); const B = 'http://localhost:3998';
  let cookie = '';
  const go = async (path, body) => { const r = await fetch(B + path, { method: body ? 'POST' : 'GET', redirect: 'manual', headers: { cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, loc: r.headers.get('location'), text: await r.text() }; };
  let x = await go('/panel'); assert.equal(x.loc, '/panel/login');
  // non-admin gets no code
  await go('/panel/login', { phone: '9999999999' }); assert.equal(sent.length, 0);
  await go('/panel/login', { phone: '9003264537' });
  const msg = sent.at(-1); const code = (msg.text ? msg.text.body : JSON.stringify(msg)).match(/\*(\d{6})\*/)[1];
  x = await go('/panel/verify', { phone: '919003264537', code: '000000' }); assert(x.text.includes('not accepted'));
  x = await go('/panel/verify', { phone: '919003264537', code }); assert.equal(x.loc, '/panel'); assert(cookie.startsWith('em_s='));
  x = await go('/panel'); assert.equal(x.status, 200); assert(x.text.includes('Main admin'));
  x = await go('/panel/areas', { name: 'KK Nagar', admin: '91111 22222', loc: 'https://maps.google.com/?q=13.04,80.20', radius: '3' }); assert(x.loc.includes('created'));
  const area = await db.one('select * from areas'); assert.equal(area.lat, 13.04); assert(sent.some((m) => m.to === '919111122222'));
  x = await go('/panel/shops', { name: 'Fresh Mart', owner: '92222 33333', area: 'Main Rd', area_id: String(area.id), delivery: '1', loc: '13.041, 80.201' });
  const shop = await db.one('select * from shops'); assert(x.loc.startsWith('/panel/shops/' + shop.id)); assert(sent.some((m) => m.to === '919222233333'));
  x = await go(`/panel/shops/${shop.id}/items`, { lines: 'Tomato 1kg | Veg | 32 | 40\nbad line\nOnion 1kg | Veg | 38 | 3' }); assert(decodeURIComponent(x.loc).includes('2 item(s) saved'));
  x = await go(`/panel/shops/${shop.id}/paid`, {}); assert(decodeURIComponent(x.loc).includes('now live'));
  x = await go(`/panel/shops/${shop.id}`, { name: 'Fresh Mart', owner: '9222233333', area: 'Main Rd', area_id: String(area.id), upi: 'fresh@okaxis', delivery: '1', del_fee: '30', min_order: '100', active: '1', loc: '' });
  assert.equal((await db.shops.get(shop.id)).upi, 'fresh@okaxis');
  x = await go(`/panel/shops/${shop.id}`); assert(x.text.includes('Tomato 1kg') && x.text.includes('Low'));
  // customer orders via bot, then admin moves it through the web
  await bot.handle('919333344444', 'Ravi', 'hi', false); await bot.handle('919333344444', 'Ravi', 'loc:13.042,80.202|Home', true);
  await bot.handle('919333344444', 'Ravi', 'shop:' + shop.id, true); const tom = await db.items.find(shop.id, 'tomato');
  for (const v of ['add:' + tom.id, 'add:' + tom.id, 'add:' + tom.id, 'add:' + tom.id, 'checkout', 'mode:pickup', 'pay:Cash']) await bot.handle('919333344444', 'Ravi', v, true);
  const o = await db.one('select * from orders'); assert.equal(o.status, 'New');
  x = await go('/panel/orders'); assert(x.text.includes('Ravi') && x.text.includes('Accept'));
  for (const to of ['Accepted', 'Ready', 'Completed']) { x = await go(`/panel/orders/${o.id}/status`, { to }); assert(decodeURIComponent(x.loc).includes(to), to); }
  x = await go(`/panel/orders/${o.id}/status`, { to: 'Accepted' }); assert(decodeURIComponent(x.loc).includes('already'));
  assert.equal((await db.orders.get(o.id)).status, 'Completed');
  x = await go('/panel/bills'); assert(x.text.includes('Fresh Mart')); x = await go('/panel/bills', {}); assert(decodeURIComponent(x.loc).includes('Bills sent to 1'));
  x = await go('/panel'); console.log('DASH KPIs:', x.text.match(/<div class="kp">.*?<div class="row"/s)[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  // area admin login: scoped
  cookie = ''; sent.length = 0;
  await go('/panel/login', { phone: '9111122222' }); const c2 = JSON.stringify(sent.at(-1)).match(/\*(\d{6})\*/)[1];
  await go('/panel/verify', { phone: '919111122222', code: c2 });
  x = await go('/panel'); assert(x.text.includes('Area admin'));
  x = await go('/panel/areas'); assert.equal(x.status, 403);
  x = await go('/panel/bills'); assert.equal(x.status, 403);
  // shop outside area hidden
  const other = await db.one(`insert into shops(code,name,owner_phone,area) values('OTH','Other Shop','919444455555','Elsewhere') returning *`);
  x = await go('/panel/shops'); assert(x.text.includes('Fresh Mart') && !x.text.includes('Other Shop'));
  x = await go('/panel/shops/' + other.id); assert.equal(x.status, 404);
  x = await go('/panel/shops/' + other.id + '/paid', {}); assert(decodeURIComponent(x.loc).includes('not found'));
  x = await go('/panel/logout'); x = await go('/panel'); assert.equal(x.loc, '/panel/login');
  // key fallback
  cookie = ''; x = await go('/panel?key=k1'); assert(x.text.includes('Main admin'));
  console.log('✅ PANEL TESTS PASSED'); srv.close(); process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
