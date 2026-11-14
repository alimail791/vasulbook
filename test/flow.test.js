// End-to-end test: simulates WhatsApp messages from admins, businesses and customers,
// then checks the web panel. Needs a Postgres database (DATABASE_URL).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/edeal';
process.env.PUBLIC_URL = 'https://edeal.test';
process.env.ADMIN_PHONES = '9000000001';
process.env.ADMIN_UPI = 'edeal@okaxis';
process.env.ADMIN_KEY = 'testkey';
const assert = require('assert');
const db = require('../src/db'); const wa = require('../src/wa'); const bot = require('../src/bot'); const jobs = require('../src/jobs');
const ADMIN = '919000000001', AREA = '919000000002', TUTOR = '919000000003', SHOP = '919000000004', CUST = '919000000005', OWNER = '919000000006';
const box = {};
wa.setSink((b) => {
  (box[b.to] = box[b.to] || []).push(b);
  if (b.type === 'interactive') {
    const it = b.interactive;
    if (it.type === 'button') assert(it.action.buttons.length <= 3 && it.action.buttons.every((x) => x.reply.title.length <= 20), 'button limits: ' + JSON.stringify(it.action.buttons.map((x) => x.reply.title)));
    if (it.type === 'list') { assert(it.action.sections[0].rows.length <= 10); it.action.sections[0].rows.forEach((r) => assert(r.title.length <= 24)); }
    assert(it.body.text.length <= 1024);
  }
  return {};
});
const msgs = (p) => box[p] || [];
const last = (p) => msgs(p)[msgs(p).length - 1];
const txt = (m) => !m ? '' : m.type === 'text' ? m.text.body : m.type === 'image' ? '[img] ' + (m.image.caption || '') : m.type === 'location' ? '[pin] ' + m.location.name : m.type === 'template' ? '[tpl] ' + m.template.components[0].parameters[0].text : m.interactive.body.text;
const opts = (m) => !m || m.type !== 'interactive' ? [] : m.interactive.type === 'button' ? m.interactive.action.buttons.map((b) => [b.reply.title, b.reply.id]) : m.interactive.type === 'list' ? m.interactive.action.sections[0].rows.map((r) => [r.description || r.title, r.id]) : [];
const find = (p, label) => { for (let i = msgs(p).length - 1; i >= 0; i--) { const o = opts(msgs(p)[i]).find(([l]) => l.includes(label)); if (o) return o[1]; } throw new Error(`no button "${label}" for ${p}`); };
const say = (p, t) => bot.handle(p, 'User' + p.slice(-1), t, false);
const tap = (p, label) => bot.handle(p, 'User' + p.slice(-1), find(p, label), true);
const loc = (p, lat, lng, label = '') => bot.handle(p, 'X', `loc:${lat},${lng}|${label}`, true);
const has = (p, s) => msgs(p).some((m) => txt(m).includes(s));
const ok = (name) => console.log('✔', name);

(async () => {
  await db.q('drop table if exists localities, advertisers, media, ads, customers, coupons, leads, payments, settings, broadcasts, sessions, menus, otps cascade');
  await db.init();

  // ---- main admin sets up two localities (one run by self, one by an area admin)
  await say(ADMIN, 'hi'); assert(/main admin/.test(txt(last(ADMIN))));
  await tap(ADMIN, 'Add locality'); await say(ADMIN, 'Gandhi Nagar'); await tap(ADMIN, "I'll run it");
  assert.equal(last(ADMIN).interactive.type, 'location_request_message');
  await loc(ADMIN, 13.0400, 80.2000); assert(txt(last(ADMIN)).includes('Gandhi Nagar* added'));
  await say(ADMIN, 'menu'); await tap(ADMIN, 'Add locality'); await say(ADMIN, 'Anna Nagar'); await say(ADMIN, '90000 00002'); await loc(ADMIN, 13.0850, 80.2100);
  assert(has(AREA, 'area admin* for *Anna Nagar'));
  ok('localities + area admin via WhatsApp');

  // ---- tutor registers in Gandhi Nagar, takes free trial, posts an offer
  await say(TUTOR, 'business'); assert(txt(last(TUTOR)).includes('business name'));
  await say(TUTOR, 'Bright Minds Tuition'); await tap(TUTOR, 'Tuition'); await loc(TUTOR, 13.0410, 80.2030, 'Bright Minds, 4th St');
  assert(txt(last(TUTOR)).includes('registered in *Gandhi Nagar*'));
  assert(has(ADMIN, 'New advertiser: *Bright Minds Tuition*'));
  await tap(TUTOR, 'free trial'); assert(has(TUTOR, 'Free trial started'));
  await tap(TUTOR, 'Post an offer'); await say(TUTOR, 'Maths & Science tuition, Class 6–10'); await say(TUTOR, 'First month 50% off + free demo class');
  await tap(TUTOR, 'Skip photo'); await tap(TUTOR, '7 days');
  assert(has(TUTOR, 'shows ads within *2 km*')); assert(txt(last(TUTOR)).includes('Preview'));
  await tap(TUTOR, 'Submit'); assert(txt(last(TUTOR)).includes('Submitted'));
  assert(txt(last(ADMIN)).includes('Ad waiting for approval'), 'Gandhi Nagar ad goes to main admin');
  await tap(TUTOR, 'Business menu'); await tap(TUTOR, 'Post an offer'); assert(txt(last(TUTOR)).includes('covers 1 ad'));
  ok('business registration, free trial, post, 1-ad limit');

  await tap(ADMIN, 'Approve'); assert(has(TUTOR, 'is now *LIVE*'));
  ok('approve on WhatsApp');

  // ---- shop in Anna Nagar pays Monthly by direct UPI; admin confirms
  await say(SHOP, 'advertise'); await say(SHOP, 'Style Point Boutique'); await tap(SHOP, 'Fashion'); await loc(SHOP, 13.0860, 80.2110);
  assert(has(AREA, 'New advertiser: *Style Point Boutique*'));
  await tap(SHOP, 'Monthly'); assert(txt(last(SHOP)).includes('edeal@okaxis') && txt(last(SHOP)).includes('/pay/'));
  await tap(SHOP, "I've paid"); await say(SHOP, '412345678901');
  assert(txt(last(ADMIN)).includes('Payment to confirm') && txt(last(ADMIN)).includes('412345678901'));
  await tap(ADMIN, 'Confirm'); assert(has(SHOP, 'Monthly* plan is active'));
  assert(has(AREA, '₹299 received from *Style Point Boutique*'));
  await tap(SHOP, 'Post an ad'); await say(SHOP, 'Season clearance'); await say(SHOP, 'Buy 2 get 1 free on kurtis'); await tap(SHOP, 'Skip photo'); await tap(SHOP, '30 days'); await tap(SHOP, 'Submit');
  assert(txt(last(AREA)).includes('Ad waiting for approval'), 'Anna Nagar ad goes to the area admin');
  await say(AREA, 'hi'); assert(/area admin/.test(txt(last(AREA))));
  await tap(AREA, 'Pending ads'); await tap(AREA, 'Approve'); assert(has(SHOP, 'is now *LIVE*'));
  ok('UPI payment claim + admin confirm, area admin approval');

  // ---- house owner: property listing
  await say(OWNER, 'business'); await say(OWNER, 'Owner Kumar'); await tap(OWNER, 'Property owner'); await loc(OWNER, 13.0395, 80.1990);
  await tap(OWNER, 'free trial'); await tap(OWNER, 'Post a property'); await tap(OWNER, 'Houses for rent');
  await say(OWNER, '2 BHK house near bus stand'); await say(OWNER, '₹12,000/month'); await say(OWNER, 'Ground floor · 900 sq ft · bike parking');
  await bot.handle(OWNER, 'X', 'img:FAKE', true); await tap(OWNER, '15 days'); await tap(OWNER, 'Submit');
  await tap(ADMIN, 'Approve');
  ok('property listing');

  // ---- customer near Gandhi Nagar
  await say(CUST, 'hi'); assert.equal(msgs(CUST)[0].interactive.type, 'location_request_message');
  await loc(CUST, 13.0405, 80.2005); await tap(CUST, '2 km');
  assert(txt(last(CUST)).includes('🎓 1 education') && txt(last(CUST)).includes('🏠 1 homes'), txt(last(CUST)));
  await tap(CUST, 'Tuition, coaching'); await tap(CUST, 'Tuition (1)');
  assert(msgs(CUST).some((m) => txt(m).includes('First month 50% off')));
  await tap(CUST, 'Book free demo'); assert(has(TUTOR, 'New demo class request'));
  await tap(CUST, 'Get offer code'); const code = txt(last(CUST)).match(/ED\d+/)[0];
  await tap(TUTOR, 'My ads'); await tap(TUTOR, 'Business menu'); await tap(TUTOR, 'Redeem'); await say(TUTOR, code.toLowerCase());
  assert(txt(last(TUTOR)).includes('Valid!')); assert(has(CUST, `${code}* used at *Bright Minds`));
  await say(TUTOR, code); assert(txt(last(TUTOR)).includes('already used'));
  await tap(CUST, 'Menu'); await tap(CUST, 'Rent & property'); await tap(CUST, 'Houses for rent'); await tap(CUST, 'Book a visit'); await tap(CUST, 'This Sunday');
  assert(has(OWNER, 'Site visit request'));
  // Anna Nagar shop is ~5 km away: hidden at 2 km, and the shop's own reach is 2 km anyway
  await tap(CUST, 'Menu'); await tap(CUST, "Today's offers"); assert(!has(CUST, 'Buy 2 get 1'));
  await say(CUST, 'tuition'); assert(txt(last(CUST)).includes("That’s all") || has(CUST, 'Results for'));
  await say(CUST, 'menu'); await tap(CUST, 'Daily 9 AM'); assert(txt(last(CUST)).includes('Every morning'));
  ok('customer: location, education, demo lead, coupon + redeem, property visit, search, alerts');

  // ---- jobs: digest, reminders, expiry
  const n = await jobs.runDigest(true); assert.equal(n, 1); assert(txt(last(CUST)).includes('Top offers near you'));
  await db.q(`update advertisers set plan_until=now()+interval '1 day' where phone=$1`, [TUTOR]);
  await jobs.planJobs(); assert(txt(last(TUTOR)).includes('ends on'));
  await db.q(`update advertisers set plan_until=now()-interval '1 minute' where phone=$1`, [TUTOR]);
  await jobs.planJobs(); assert(txt(last(TUTOR)).includes('plan has ended'));
  assert.equal((await db.one(`select status from ads where title like 'Maths%'`)).status, 'expired');
  await tap(TUTOR, 'Plans'); assert(!opts(last(TUTOR)).some(([l]) => l.includes('free trial')), 'trial only once');
  ok('daily digest, plan reminder, plan end');

  // ---- web panel
  const { app } = require('../src/index');
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  for (const p of ['', '/approvals', '/ads', '/advertisers', '/payments', '/localities', '/plans', '/broadcast']) {
    const r = await fetch(`${base}/panel${p}?key=testkey`); const h = await r.text();
    assert.equal(r.status, 200, p); assert(h.includes('EDeal admin'), p);
  }
  let r = await fetch(`${base}/panel/plans?key=testkey`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'day=40&week=100&month=299&premium=499', redirect: 'manual' });
  assert.equal(r.status, 302); assert.equal((await db.plans()).day.price, 40);
  r = await fetch(`${base}/panel/localities?key=testkey`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=KK+Nagar&admin=9000000002&loc=13.03,80.19&share=50', redirect: 'manual' });
  assert.equal((await db.localities.byAdmin(AREA)).length, 2, 'one area admin, two localities');
  await say(SHOP, 'hi'); await tap(SHOP, 'Plans'); await tap(SHOP, 'Premium'); const pid = (await db.one(`select id from payments where status='created' order by id desc limit 1`)).id;
  r = await fetch(`${base}/pay/${pid}`); assert((await r.text()).includes('upi://pay'));
  r = await fetch(`${base}/`); assert((await r.text()).includes('free trial'));
  r = await fetch(`${base}/panel`, { redirect: 'manual' }); assert.equal(r.status, 302, 'login required');
  srv.close();
  ok('web panel pages, price change, locality add, UPI pay page, login guard');

  console.log('\nAll EDeal tests passed ✅');
  await db.pool.end();
})().catch(async (e) => { console.error('❌', e); await db.pool.end(); process.exit(1); });
