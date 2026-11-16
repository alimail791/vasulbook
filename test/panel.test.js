process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/bazaar';
process.env.ADMIN_PHONES = '9003264537'; process.env.PUBLIC_URL = 'https://example.test'; process.env.ADMIN_KEY = 'k1';
const assert = require('assert'); const db = require('../src/db'); const wa = require('../src/wa'); const bot = require('../src/bot');
const sent = []; wa.setSink((b) => { sent.push(b); return {}; });
const { app } = require('../src/index');
(async () => {
  await db.q('drop table if exists shops, items, orders, sessions, menus, payments, areas, otps, cust_links, web_orders, categories, shop_types cascade'); await db.init();
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
  x = await go(`/panel/shops/${shop.id}/items`, { lines: 'Tomato 1kg | Veg | 32 | 40\nbad line\nOnion 1kg | Veg | 38 | 3' }); assert(/Added<\/small><b>2</.test(x.text) && x.text.includes('price missing'), 'paste result');
  // ---- shop types & categories
  x = await go('/panel/catalog'); assert(x.text.includes('Vegetables &amp; Fruits') && x.text.includes('Leafy Greens'));
  x = await go('/panel/catalog', { name: 'Sweets', cats: 'Sweets\nNamkeen\n\nnamkeen\nOthers' }); const sw = await db.one(`select * from shop_types where name='Sweets'`);
  assert.deepEqual((await db.all('select name from categories where type_id=$1 order by sort', [sw.id])).map((c) => c.name), ['Sweets', 'Namkeen', 'Others']);
  const veg = await db.one(`select * from shop_types where name='Vegetables & Fruits'`);
  await go(`/panel/catalog/${veg.id}`, { name: 'Vegetables & Fruits', sort: '1', active: '1', cats: 'Vegetables\nLeafy Greens\nFruits\nExotic\nOthers' });
  assert((await db.all('select name from categories where type_id=$1', [veg.id])).some((c) => c.name === 'Exotic'));
  // set shop type -> categories enforced
  await go(`/panel/shops/${shop.id}`, { name: 'Fresh Mart', owner: '9222233333', area: 'Main Rd', area_id: String(area.id), type_id: String(veg.id), upi: '', delivery: '1', del_fee: '25', min_order: '0', loc: '' });
  assert.equal((await db.shops.get(shop.id)).type_id, veg.id);
  x = await go(`/panel/shops/${shop.id}/items`, { lines: 'Spinach | leafy greens | 20 | 15\nApple 1kg | fruit | 180 | 10\nRice 5kg | Grains | 300 | 5' });
  assert(/Added<\/small><b>2</.test(x.text) && x.text.includes('unknown category') && x.text.includes('Allowed categories'));
  assert.equal((await db.items.find(shop.id, 'spinach')).cat, 'Leafy Greens'); assert.equal((await db.items.find(shop.id, 'apple')).cat, 'Fruits');
  // ---- Excel: download, edit, upload
  const ExcelJS = require('exceljs');
  let dl = await fetch(B + `/panel/shops/${shop.id}/items.xlsx`, { headers: { cookie } }); assert.equal(dl.status, 200);
  assert(dl.headers.get('content-type').includes('spreadsheetml'));
  let wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await dl.arrayBuffer()));
  const ws = wb.getWorksheet('Items'); assert(wb.getWorksheet('Categories')); assert.equal(ws.getCell('A1').value, 'Name');
  assert(ws.getCell('B2').dataValidation && ws.getCell('B2').dataValidation.type === 'list');
  const names = []; ws.eachRow((r, n) => { if (n > 1) names.push(r.getCell(1).value); }); assert(names.includes('Spinach') && names.includes('Tomato 1kg'));
  // change Tomato price, add 2 new items, one bad row
  ws.eachRow((r, n) => { if (r.getCell(1).value === 'Tomato 1kg') { r.getCell(3).value = 35; r.getCell(4).value = 50; } });
  ws.addRow(['Banana (dozen)', 'Fruits', 60, 20]); ws.addRow(['Carrot 500g', 'vegetables', '₹28', 30]); ws.addRow(['Chips', 'Snacks', 20, 5]); ws.addRow(['', '', '', '']);
  const up = async (buf, name, extra = {}) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const r = await fetch(B + `/panel/shops/${shop.id}/upload`, { method: 'POST', body: fd, headers: { cookie }, redirect: 'manual' }); return { status: r.status, loc: r.headers.get('location'), text: await r.text() }; };
  x = await up(await wb.xlsx.writeBuffer(), 'fresh.xlsx');
  assert(/Added<\/small><b>2</.test(x.text), 'excel added 2'); assert(x.text.includes('Row') && x.text.includes('unknown category &quot;Snacks&quot;'));
  assert.equal((await db.items.find(shop.id, 'tomato')).price, 35); assert.equal((await db.items.find(shop.id, 'carrot')).price, 28); assert.equal((await db.items.find(shop.id, 'carrot')).cat, 'Vegetables');
  // replace mode with errors removes nothing; without errors removes missing
  const before = (await db.items.byShop(shop.id)).length;
  x = await up(await wb.xlsx.writeBuffer(), 'fresh.xlsx', { replace: '1' }); assert.equal((await db.items.byShop(shop.id)).length, before); assert(x.text.includes('no items were removed'));
  x = await up(Buffer.from('Item Name,Category,Rate,Qty\n"Tomato 1kg",Vegetables,36,40\nSpinach,Leafy Greens,22,10\n'), 'list.csv', { replace: '1' });
  assert(/Updated<\/small><b>2</.test(x.text) && /Removed<\/small><b>\d+</.test(x.text)); assert.equal((await db.items.byShop(shop.id)).length, 2);
  x = await up(Buffer.from('foo,bar\n1,2\n'), 'x.csv'); assert(decodeURIComponent(x.loc).includes('header row'));
  x = await up(Buffer.from('hello'), 'x.xls'); assert(decodeURIComponent(x.loc).includes('.xlsx or .csv'));
  x = await up(Buffer.from('not excel'), 'x.xlsx'); assert(decodeURIComponent(x.loc).includes('Could not read'));
  // restore items for the rest of the test
  await go(`/panel/shops/${shop.id}/items`, { lines: 'Tomato 1kg | Vegetables | 32 | 40\nOnion 1kg | Vegetables | 38 | 3' });
  // ---- WhatsApp owner gets the category list on errors; customer sees categories in type order
  await bot.handle('919222233333', 'X', 'Mango 1kg | Juice | 120 | 10', false);
  const ownerMsg = sent.filter((m) => m.to === '919222233333').at(-1); const om = ownerMsg.text ? ownerMsg.text.body : ownerMsg.interactive.body.text;
  assert(om.includes('unknown category') && om.includes('Leafy Greens'), om);
  x = await go(`/panel/shops/${shop.id}/paid`, {}); assert(decodeURIComponent(x.loc).includes('now live'));
  x = await go(`/panel/shops/${shop.id}`, { name: 'Fresh Mart', owner: '9222233333', area: 'Main Rd', area_id: String(area.id), type_id: String(veg.id), upi: 'fresh@okaxis', delivery: '1', del_fee: '30', min_order: '100', active: '1', loc: '' });
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
  x = await go('/panel/catalog'); assert.equal(x.status, 403);
  dl = await fetch(B + `/panel/shops/${shop.id}/items.xlsx`, { headers: { cookie } }); assert.equal(dl.status, 200);
  // shop outside area hidden
  const other = await db.one(`insert into shops(code,name,owner_phone,area) values('OTH','Other Shop','919444455555','Elsewhere') returning *`);
  x = await go('/panel/shops'); assert(x.text.includes('Fresh Mart') && !x.text.includes('Other Shop'));
  x = await go('/panel/shops/' + other.id); assert.equal(x.status, 404);
  x = await go('/panel/shops/' + other.id + '/paid', {}); assert(decodeURIComponent(x.loc).includes('not found'));
  x = await go('/panel/logout'); x = await go('/panel'); assert.equal(x.loc, '/panel/login');
  // admin key login form
  cookie = ''; x = await go('/panel/keylogin', { key: 'wrong' }); assert.equal(x.status, 401);
  x = await go('/panel/keylogin', { key: 'k1' }); assert.equal(x.loc, '/panel'); x = await go('/panel'); assert(x.text.includes('Main admin'));
  // key fallback
  cookie = ''; x = await go('/panel?key=k1'); assert(x.text.includes('Main admin'));
  console.log('✅ PANEL TESTS PASSED'); srv.close(); process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
