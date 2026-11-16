// End-to-end test: simulates WhatsApp messages from admins, businesses and customers,
// then checks the web panel. Needs a Postgres database (DATABASE_URL).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/edeal';
process.env.PUBLIC_URL = 'https://edeal.test';
process.env.ADMIN_PHONES = '9000000001';
process.env.ADMIN_UPI = 'edeal@okaxis';
process.env.ADMIN_KEY = 'testkey';
process.env.BOT_PHONE = '9003264537';
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
  await db.q('drop table if exists localities, advertisers, media, ads, customers, coupons, leads, payments, settings, broadcasts, sessions, menus, otps, categories cascade');
  await db.init();

  // ---- main admin sets up two localities (one run by self, one by an area admin)
  await say(ADMIN, 'hi'); assert(/main admin/.test(txt(last(ADMIN))));
  await tap(ADMIN, 'Add locality'); await say(ADMIN, 'Gandhi Nagar'); await tap(ADMIN, "I'll run it");
  assert.equal(last(ADMIN).interactive.type, 'location_request_message');
  await loc(ADMIN, 13.0400, 80.2000); assert(txt(last(ADMIN)).includes('Gandhi Nagar* added'));
  await say(ADMIN, 'menu'); await tap(ADMIN, 'Add locality'); await say(ADMIN, 'Anna Nagar'); await say(ADMIN, '90000 00002'); await loc(ADMIN, 13.0850, 80.2100);
  assert(has(AREA, 'area admin* for *Anna Nagar'));
  ok('localities + area admin via WhatsApp');
  // ---- admin adds a category on WhatsApp
  await say(ADMIN, 'menu'); await tap(ADMIN, 'Categories'); assert(txt(last(ADMIN)).includes('📖 Tuition · 🎓'));
  await tap(ADMIN, 'Add category'); await say(ADMIN, 'Medical'); await say(ADMIN, '💊'); await tap(ADMIN, 'Shops & services');
  assert(txt(last(ADMIN)).includes('💊 Medical* added')); assert(bot.CATS.includes('Medical'));
  await tap(ADMIN, 'Categories'); await tap(ADMIN, 'More options'); await tap(ADMIN, 'Medical'); await tap(ADMIN, 'Hide'); assert(!bot.CATS.includes('Medical'));
  await tap(ADMIN, 'Show'); assert(bot.CATS.includes('Medical'));
  ok('admin adds / hides / shows a category on WhatsApp');

  // ---- tutor registers in Gandhi Nagar, takes free trial, posts an offer
  await say(TUTOR, 'business'); assert(txt(last(TUTOR)).includes('business name'));
  await say(TUTOR, 'Bright Minds Tuition'); await tap(TUTOR, 'Tuition'); await loc(TUTOR, 13.0410, 80.2030, 'Bright Minds, 4th St');
  assert(txt(last(TUTOR)).includes('registered in *Gandhi Nagar*'));
  assert(has(ADMIN, 'New advertiser: *Bright Minds Tuition*'));
  await tap(TUTOR, 'free trial'); assert(has(TUTOR, 'Free trial started'));
  await tap(TUTOR, 'Post an offer'); assert(txt(last(TUTOR)).includes('any category')); await tap(TUTOR, 'Tuition'); await say(TUTOR, 'Maths & Science tuition, Class 6–10'); await say(TUTOR, 'First month 50% off + free demo class');
  await tap(TUTOR, 'Skip photo'); await tap(TUTOR, '7 days');
  assert(has(TUTOR, 'shows ads within *2 km*')); assert(txt(last(TUTOR)).includes('Preview'));
  await tap(TUTOR, 'Submit'); assert(txt(last(TUTOR)).includes('Submitted'));
  assert(txt(last(ADMIN)).includes('Ad waiting for approval'), 'Gandhi Nagar ad goes to main admin');
  await tap(TUTOR, 'Business menu'); await tap(TUTOR, 'Post an offer'); assert(txt(last(TUTOR)).includes('covers 1 ad'));
  ok('business registration, free trial, post, 1-ad limit');

  await tap(ADMIN, 'Approve'); assert(has(TUTOR, 'is now *LIVE*'));
  ok('approve on WhatsApp');
  // ---- advertiser changes business category, moves running offers
  await say(TUTOR, 'menu'); assert(txt(last(TUTOR)).includes('🏷 Tuition'));
  await tap(TUTOR, 'Category: Tuition'); await tap(TUTOR, 'Coaching');
  assert(txt(last(TUTOR)).includes('Move it to Coaching'));
  await tap(TUTOR, 'Yes, move them'); assert(has(TUTOR, '1 offer moved to *Coaching*'));
  assert.equal((await db.one(`select cat from ads where title like 'Maths%'`)).cat, 'Coaching');
  await say(TUTOR, 'menu'); await tap(TUTOR, 'Category: Coaching'); await tap(TUTOR, 'Tuition'); await tap(TUTOR, 'Yes, move them');
  assert.equal((await db.one(`select cat from ads where title like 'Maths%'`)).cat, 'Tuition');
  ok('advertiser changes category (and moves running offers)');
  // ---- main admin posts their own ad from business view and approves it from there
  await say(ADMIN, '#business'); await say(ADMIN, 'Akbar Rentals'); await tap(ADMIN, 'More options'); await tap(ADMIN, 'Property owner'); await loc(ADMIN, 13.0402, 80.2002);
  await tap(ADMIN, 'free trial'); await tap(ADMIN, 'Post a property'); await tap(ADMIN, 'Houses for rent');
  await say(ADMIN, '1 BHK near market'); await say(ADMIN, '₹7,000/month'); await say(ADMIN, 'First floor · 600 sq ft');
  await tap(ADMIN, 'Skip photo'); await tap(ADMIN, '7 days'); await tap(ADMIN, 'Submit');
  assert(has(ADMIN, 'Ad waiting for approval'));
  await tap(ADMIN, 'Approve'); assert(has(ADMIN, 'Approved – “1 BHK near market” is live'), 'approve works from business view');
  assert.equal((await db.one(`select status from ads where title='1 BHK near market'`)).status, 'live');
  await say(ADMIN, '#admin');
  ok('main admin can approve own ad from business view');

  // ---- shop in Anna Nagar pays Monthly by direct UPI; admin confirms
  await say(SHOP, 'advertise'); await say(SHOP, 'Style Point Boutique'); await tap(SHOP, 'Fashion'); await loc(SHOP, 13.0860, 80.2110);
  assert(has(AREA, 'New advertiser: *Style Point Boutique*'));
  await tap(SHOP, 'Monthly'); assert(txt(last(SHOP)).includes('edeal@okaxis') && txt(last(SHOP)).includes('/pay/'));
  await tap(SHOP, "I've paid"); await say(SHOP, '412345678901');
  assert(txt(last(ADMIN)).includes('Payment to confirm') && txt(last(ADMIN)).includes('412345678901'));
  await tap(ADMIN, 'Confirm'); assert(has(SHOP, 'Monthly* plan is active'));
  assert(has(AREA, '₹299 received from *Style Point Boutique*'));
  await tap(SHOP, 'Post an ad'); await tap(SHOP, 'Medical'); assert(txt(last(SHOP)).includes('*Medical* offer')); await say(SHOP, 'Season clearance'); await say(SHOP, 'Buy 2 get 1 free on kurtis'); await tap(SHOP, 'Skip photo'); await tap(SHOP, '30 days');
  await tap(SHOP, 'Change category'); await tap(SHOP, 'Kids'); assert(txt(last(SHOP)).includes('🏷 Kids'));
  await tap(SHOP, 'Change category'); await tap(SHOP, 'Fashion'); await tap(SHOP, 'Submit');
  assert.equal((await db.one(`select cat from ads where title='Season clearance'`)).cat, 'Fashion');
  assert.equal((await db.advertisers.byPhone(SHOP)).cat, 'Fashion');
  assert(txt(last(AREA)).includes('Ad waiting for approval'), 'Anna Nagar ad goes to the area admin');
  await say(AREA, 'hi'); assert(/area admin/.test(txt(last(AREA))));
  await tap(AREA, 'Pending ads'); await tap(AREA, 'Approve'); assert(has(SHOP, 'is now *LIVE*'));
  ok('UPI payment claim + admin confirm, area admin approval');

  // ---- house owner: property listing
  await say(OWNER, 'business'); await say(OWNER, 'Owner Kumar'); await tap(OWNER, 'More options'); await tap(OWNER, 'Property owner'); await loc(OWNER, 13.0395, 80.1990);
  await tap(OWNER, 'free trial'); await tap(OWNER, 'Post a property'); await tap(OWNER, 'Houses for rent');
  await say(OWNER, '2 BHK house near bus stand'); await say(OWNER, '₹12,000/month'); await say(OWNER, 'Ground floor · 900 sq ft · bike parking');
  await bot.handle(OWNER, 'X', 'img:FAKE', true); await tap(OWNER, '15 days'); await tap(OWNER, 'Submit');
  await tap(ADMIN, 'Approve');
  // property owner can also post an offer in any category (trial = 1 ad, so check the menu + category list only)
  await say(OWNER, 'menu'); assert(opts(last(OWNER)).some(([l]) => l.includes('Post an offer')) && opts(last(OWNER)).some(([l]) => l.includes('Post an event')));
  ok('property listing');

  // ---- customer near Gandhi Nagar
  await say(CUST, 'hi'); assert.equal(msgs(CUST)[0].interactive.type, 'location_request_message');
  await loc(CUST, 13.0405, 80.2005); await tap(CUST, '2 km');
  assert(txt(last(CUST)).includes('🎓 1 education') && txt(last(CUST)).includes('🏠 2 homes'), txt(last(CUST)));
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
  const med = await db.one(`select id from categories where name='Medical'`);
  r = await fetch(`${base}/panel/categories?key=testkey`); assert((await r.text()).includes('Medical'));
  r = await fetch(`${base}/panel/categories?key=testkey`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Hardware&emoji=%F0%9F%94%A7&edu=0', redirect: 'manual' });
  assert(bot.CATS.includes('Hardware'));
  r = await fetch(`${base}/panel/categories/${med.id}?key=testkey`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=Pharmacy&emoji=%F0%9F%92%8A&edu=0&active=1&sort=15', redirect: 'manual' });
  assert(bot.CATS.includes('Pharmacy') && !bot.CATS.includes('Medical'));
  r = await fetch(`${base}/offers`); { const hh = await r.text(); assert(hh.includes('Pharmacy') && hh.includes('Hardware'), 'website chips'); }
  const tutorId = (await db.advertisers.byPhone(TUTOR)).id;
  r = await fetch(`${base}/panel/advertisers/${tutorId}/cat?key=testkey`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'cat=Schools', redirect: 'manual' });
  assert.equal(r.status, 302); assert.equal((await db.advertisers.byPhone(TUTOR)).cat, 'Schools');
  r = await fetch(`${base}/panel/localities?key=testkey`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=KK+Nagar&admin=9000000002&loc=13.03,80.19&share=50', redirect: 'manual' });
  assert.equal((await db.localities.byAdmin(AREA)).length, 2, 'one area admin, two localities');
  await say(SHOP, 'hi'); await tap(SHOP, 'Plans'); await tap(SHOP, 'Premium'); const pid = (await db.one(`select id from payments where status='created' order by id desc limit 1`)).id;
  r = await fetch(`${base}/pay/${pid}`); assert((await r.text()).includes('upi://pay'));
  r = await fetch(`${base}/`); assert((await r.text()).includes('free trial'));
  r = await fetch(`${base}/panel`, { redirect: 'manual' }); assert.equal(r.status, 302, 'login required');
  srv.close();
  ok('web panel pages, price change, locality add, UPI pay page, login guard');
  // ---- public website + personal link + WhatsApp deep links
  const tok = (await db.one('select web_token from customers where phone=$1', [CUST])).web_token;
  assert(tok && has(CUST, '/u/' + tok), 'menu includes personal web link');
  const srv2 = app.listen(0); const b2 = `http://127.0.0.1:${srv2.address().port}`;
  r = await fetch(`${b2}/u/${tok}`, { redirect: 'manual' }); assert.equal(r.status, 302); const loc2 = r.headers.get('location'); assert(loc2.includes('lat=13.04050'), loc2);
  let h = await (await fetch(b2 + loc2)).text(); assert(h.includes('Season clearance') === false && h.includes('2 BHK house near bus stand'), 'nearby only');
  h = await (await fetch(`${b2}/offers`)).text(); assert(h.includes('Season clearance'), 'all areas');
  h = await (await fetch(`${b2}/offers?f=property`)).text(); assert(h.includes('2 BHK') && !h.includes('Season clearance'));
  const shopAd = (await db.one(`select id from ads where title='Season clearance'`)).id;
  h = await (await fetch(`${b2}/ad/${shopAd}`)).text(); assert(h.includes('Offer%20%23' + shopAd) && h.includes('og:title'));
  assert(has(SHOP, `/ad/${shopAd}`), 'advertiser got share link on approval');
  srv2.close();
  const NEW = '919000000009';
  await say(NEW, `Offer #${shopAd}`); assert(/Your code: ED\d+/.test(txt(last(NEW))), txt(last(NEW)));
  await say(ADMIN, `Offer #${shopAd}`); assert(/Your code/.test(txt(last(ADMIN))), 'admin can also use web links');
  ok('website offers page, personal link, ad page, share link, WhatsApp deep links');

  console.log('\nAll EDeal tests passed ✅');
  await db.pool.end();
})().catch(async (e) => { console.error('❌', e); await db.pool.end(); process.exit(1); });
