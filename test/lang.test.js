// Language test: a Tamil customer and a Hindi advertiser use EDeal end to end.
// Prints any outgoing line that still looks English, so missing translations are easy to spot.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/edeal';
process.env.PUBLIC_URL = 'https://edeal.test';
process.env.ADMIN_PHONES = '9000000001';
process.env.ADMIN_UPI = 'edeal@okaxis';
process.env.BOT_PHONE = '9003264537';
const assert = require('assert');
const db = require('../src/db'); const wa = require('../src/wa'); const bot = require('../src/bot');
const ADMIN = '919000000001', TA = '919000000011', HI = '919000000012', EN = '919000000013';
const box = {};
wa.setSink((b) => { (box[b.to] = box[b.to] || []).push(b); return {}; });
const msgs = (p) => box[p] || [];
const last = (p) => msgs(p)[msgs(p).length - 1];
const txt = (m) => !m ? '' : m.type === 'text' ? m.text.body : m.type === 'image' ? (m.image.caption || '') : m.type === 'location' ? '' : m.type === 'template' ? m.template.components[0].parameters[0].text : m.interactive.body.text;
const opts = (m) => !m || m.type !== 'interactive' ? [] : m.interactive.type === 'button' ? m.interactive.action.buttons.map((b) => [b.reply.title, b.reply.id]) : m.interactive.type === 'list' ? m.interactive.action.sections[0].rows.map((r) => [r.description || r.title, r.id]) : [];
const byId = async (p, id) => { for (let i = msgs(p).length - 1; i >= 0; i--) { const o = opts(msgs(p)[i]).find(([, x]) => x === id || x.startsWith(id)); if (o) return bot.handle(p, 'X', o[1], true); } throw new Error(`no button ${id} for ${p}`); };
const say = (p, t) => bot.handle(p, 'User', t, false);
const loc = (p, lat, lng) => bot.handle(p, 'X', `loc:${lat},${lng}|`, true);
const ok = (n) => console.log('✔', n);
// lines that are typed by people (ad text, names) – not expected to be translated
const CONTENT = /2 BHK|₹|Kumar|Rentals|near bus|ground floor|\+91|https?:|ED\d|EDP\d|edeal@|\d{1,2} (Nov|Dec|Jan)|Gandhi Nagar|km\b.*\d|^\s*$/i;
function englishLeft(p) {
  const out = new Set();
  for (const m of msgs(p)) {
    for (const l of [txt(m), ...opts(m).map(([x]) => x)].join('\n').split('\n')) {
      if (CONTENT.test(l)) continue;
      if (/[A-Za-z]{4,}(\s+[A-Za-z]{3,}){2,}/.test(l.replace(/\*|_/g, ''))) out.add(l);
    }
  }
  return [...out];
}

(async () => {
  await db.q('drop table if exists localities, advertisers, media, ads, customers, coupons, leads, payments, settings, broadcasts, sessions, menus, otps, categories cascade');
  await db.init();
  // admin adds a locality
  await say(ADMIN, 'hi'); await byId(ADMIN, 'aadd'); await say(ADMIN, 'Gandhi Nagar'); await byId(ADMIN, 'lw:me'); await loc(ADMIN, 13.04, 80.2);

  // ---- new user is asked for a language first; "vanakkam" picks Tamil by itself
  await say(EN, 'hi'); assert(txt(last(EN)).includes('மொழியைத்') && opts(last(EN)).length === 3, 'picker for new users');
  await byId(EN, 'lang:en'); assert(msgs(EN).some((m) => txt(m).includes('Welcome to EDeal')), 'continues in English after picking');
  await say(TA, 'வணக்கம்'); assert(msgs(TA).some((m) => txt(m).includes('வரவேற்கிறோம்')), 'Tamil detected from script');
  ok('language picker + auto-detect');

  // ---- Hindi advertiser: "business" → picker → Hindi → registration continues in Hindi
  await say(HI, 'business'); assert(txt(last(HI)).includes('भाषा चुनें'));
  await byId(HI, 'lang:hi'); assert(txt(last(HI)).includes('आप क्या करना चाहेंगे?'), 'choices in Hindi: ' + txt(last(HI)));
  await byId(HI, 'biz'); assert(txt(last(HI)).includes('दुकान / बिज़नेस का नाम'), 'registration in Hindi: ' + txt(last(HI)));
  await say(HI, 'Sharma Rentals'); assert(txt(last(HI)).includes('किसका विज्ञापन'));
  await byId(HI, 'rcat:Property'); await loc(HI, 13.041, 80.201);
  await byId(HI, 'plan:trial'); assert(msgs(HI).some((m) => txt(m).includes('फ्री ट्रायल शुरू')));
  await byId(HI, 'post:property'); assert(txt(last(HI)).includes('आप क्या डाल रहे हैं'));
  assert(opts(last(HI)).some(([l]) => l.includes('किराए के मकान')), 'property types in Hindi');
  await byId(HI, 'dsub:Houses for rent'); await say(HI, '2 BHK near bus stand'); assert(txt(last(HI)).includes('मासिक किराया'));
  await say(HI, '₹9,000/month'); await say(HI, 'Ground floor, 800 sq ft'); await byId(HI, 'dskip'); await byId(HI, 'dval:7');
  assert(txt(last(HI)).includes('प्रीव्यू')); await byId(HI, 'dsubmit'); assert(txt(last(HI)).includes('सबमिट हो गया'));
  await byId(ADMIN, 'ap:'); assert(msgs(HI).some((m) => txt(m).includes('लाइव')), 'approval message in Hindi');
  ok('Hindi advertiser: register, trial, post property, approval');

  // ---- Tamil customer: location, menu, property, enquiry (lead goes to the Hindi advertiser in Hindi)
  await loc(TA, 13.0405, 80.2005); assert(txt(last(TA)).includes('எவ்வளவு தூரம்'));
  await byId(TA, 'rad:2'); const menu = last(TA);
  assert(txt(menu).includes('சலுகைகள்') && opts(menu).some(([l]) => l.includes('இன்றைய சலுகைகள்')) && opts(menu).some(([l]) => l.includes('அமைப்புகள்')));
  await byId(TA, 'props'); assert(txt(last(TA)).includes('வாடகை & சொத்து') && opts(last(TA)).some(([l]) => l.includes('வாடகைக்கு வீடுகள் (1)')));
  await byId(TA, 'psub:Houses for rent'); assert(msgs(TA).some((m) => txt(m).includes('2 BHK near bus stand')), 'ad text stays as written');
  await byId(TA, 'enq:'); assert(msgs(TA).some((m) => txt(m).includes('விசாரணையையும்')));
  assert(msgs(HI).some((m) => txt(m).includes('नई पूछताछ')), 'lead alert in Hindi');
  await byId(TA, 'menu'); await byId(TA, 'settings'); assert(txt(last(TA)).includes('மொழி: தமிழ்'));
  await byId(TA, 'lang'); await byId(TA, 'lang:hi'); assert(msgs(TA).some((m) => txt(m).includes('भाषा: हिंदी')));
  await say(TA, 'tamil'); assert(msgs(TA).some((m) => txt(m).includes('மொழி: தமிழ்')), 'typing "tamil" switches back');
  await say(TA, 'மெனு'); assert(txt(last(TA)).includes('சலுகைகள்'), 'Tamil word for menu');
  ok('Tamil customer: menu, property, enquiry, settings, switch language');

  // ---- daily message + plan reminder in the person's language
  await byId(TA, 'alerts'); assert(txt(last(TA)).includes('தினமும் காலை'));
  await require('../src/jobs').runDigest(true); assert(msgs(TA).some((m) => txt(m).includes('காலை வணக்கம்')));
  await db.q(`update advertisers set plan_until=now()+interval '1 day' where phone=$1`, [HI]);
  await require('../src/jobs').planJobs(); assert(txt(last(HI)).includes('खत्म हो रहा है'));
  ok('daily offers + reminders translated');

  for (const [p, n] of [[TA, 'Tamil customer'], [HI, 'Hindi advertiser']]) {
    const left = englishLeft(p);
    console.log(`\n${n}: ${left.length} line(s) still in English`); left.forEach((l) => console.log('   ·', l));
  }
  console.log('\nLanguage tests passed ✅');
  await db.pool.end();
})().catch(async (e) => { console.error('❌', e); await db.pool.end(); process.exit(1); });
