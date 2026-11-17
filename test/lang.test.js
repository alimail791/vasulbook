// Languages: Tamil customer and Hindi shop owner go through a full order.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/bazaar';
process.env.PUBLIC_URL = 'https://example.test';
process.env.ADMIN_PHONES = '9003264537';
const assert = require('assert');
const db = require('../src/db'); const wa = require('../src/wa'); const bot = require('../src/bot');
const ADMIN = '919003264537', OWNER = '919700000001', CUST = '919700000002';
const box = {};
wa.setSink((b) => { (box[b.to] = box[b.to] || []).push(b); return {}; });
const all = (p) => box[p] || [];
const last = (p) => all(p)[all(p).length - 1];
const txt = (m) => m.type === 'text' ? m.text.body : m.type === 'document' ? m.document.caption : m.interactive.body.text;
const opts = (m) => m.type !== 'interactive' ? [] : m.interactive.type === 'button' ? m.interactive.action.buttons.map((b) => [b.reply.title, b.reply.id]) : m.interactive.action.sections[0].rows.map((r) => [r.description || r.title, r.id]);
const find = (p, label) => { for (let i = all(p).length - 1; i >= 0; i--) { const o = opts(all(p)[i]).find(([l, id]) => l.includes(label) || id === label || (label.endsWith(':') && id.startsWith(label))); if (o) return o[1]; } throw new Error(`no button "${label}" for ${p}`); };
const say = (p, t) => bot.handle(p, 'X', t, false);
const tap = (p, label) => bot.handle(p, 'X', find(p, label), true);
const ok = (name) => console.log('✔', name);
// Lines still in English (ignoring names, prices, commands, links)
const KEEP = /Sri Murugan|Ponni Rice|Toor Dal|Rice & Grains|Pulses|Name \| Category|price Sugar|stock Sugar|remove Sugar|delfee|minorder|upi |UPI|https?:|INV-|WhatsApp|EMart|Location|Send your current location|#customer|#shop|menu|Order \d|Add items|Item qty|Pay now/;
function english(p, from) {
  const bad = [];
  for (const m of all(p).slice(from)) for (const l of [txt(m), ...opts(m).map(([x]) => x)].join('\n').split('\n')) {
    const s = l.replace(KEEP, '').replace(/\*|_/g, '');
    if (/[A-Za-z]{4,}/.test(s.replace(/[஀-௿ऀ-ॿ]/g, '')) && !/[஀-௿ऀ-ॿ]/.test(l) && !/^(English|தமிழ்|हिंदी)$/.test(l.trim())) bad.push(l);
  }
  return bad;
}
(async () => {
  await db.q('drop table if exists shops, items, orders, sessions, menus, payments, areas, otps, cust_links, web_orders, categories, shop_types, cust_lang cascade'); await db.init();
  await say(ADMIN, 'hi'); assert(/admin/i.test(txt(last(ADMIN))), 'admin gets English without a picker');
  await tap(ADMIN, 'Add new shop'); await say(ADMIN, 'Sri Murugan Stores'); await say(ADMIN, '97000 00001'); await say(ADMIN, 'Anna Nagar'); await tap(ADMIN, 'Yes, opt in'); await tap(ADMIN, 'Other / not listed');
  await tap(ADMIN, 'received');

  // Hindi owner: greets with "namaste" -> Hindi detected
  await say(OWNER, 'namaste');
  assert(txt(last(OWNER)).includes('दुकान पैनल'), txt(last(OWNER)));
  const o0 = all(OWNER).length;
  await tap(OWNER, 'additem');
  await say(OWNER, 'Ponni Rice 5kg | Rice & Grains | 320 | 25; Toor Dal 1kg | Pulses | 165 | 3');
  assert(txt(last(OWNER)).includes('सामान सेव हुआ'));
  await tap(OWNER, 'stock'); await tap(OWNER, 'settings'); await say(OWNER, 'upi sri@okaxis');
  ok('Hindi owner: detect, add items, stock, settings');

  // Tamil customer: picker first, then the pending "hi" runs in Tamil
  await say(CUST, 'hi');
  assert(txt(last(CUST)).includes('Choose your language'));
  await tap(CUST, 'lang:ta');
  assert(all(CUST).some((m) => txt(m).includes('மொழி தமிழாக')));
  assert(txt(last(CUST)).includes('வரவேற்கிறோம்'), txt(last(CUST)));
  const c0 = all(CUST).length;
  await tap(CUST, 'Sri Murugan'); await tap(CUST, 'Pulses'); await tap(CUST, 'Toor Dal'); await tap(CUST, 'add:');
  await tap(CUST, 'cart'); await tap(CUST, 'checkout'); await tap(CUST, 'mode:pickup'); await tap(CUST, 'pay:UPI');
  assert(all(CUST).some((m) => txt(m).includes('ஆர்டர் #')));
  ok('Tamil customer: picker, shop, cart, checkout, order');

  // Owner gets the order in Hindi, low stock alert, then works the order
  assert(all(OWNER).some((m) => txt(m).includes('नया ऑर्डर')));
  assert(all(OWNER).some((m) => txt(m).includes('कम स्टॉक अलर्ट')));
  await tap(OWNER, 'acc:'); await tap(OWNER, 'rdy:'); await tap(OWNER, 'done:');
  assert(all(CUST).some((m) => txt(m).includes('ஏற்றுக்கொண்டது')));
  assert(all(CUST).some((m) => txt(m).includes('வாங்கத் தயார்')));
  assert(all(CUST).some((m) => txt(m).includes('நன்றி')));
  await tap(CUST, 'rate'); await tap(CUST, 'my');
  ok('order updates in each person\'s language');

  // Switch language anytime
  await say(CUST, 'english'); assert(txt(last(CUST)).includes('Welcome'), txt(last(CUST)));
  await say(CUST, 'மொழி'); assert(txt(last(CUST)).includes('Choose your language'));
  await tap(CUST, 'lang:hi'); assert(all(CUST).some((m) => txt(m).includes('भाषा हिंदी')));
  ok('switch language');

  // Website in Tamil
  const app = require('../src/index').app; const srv = app.listen(0); const base = 'http://localhost:' + srv.address().port;
  const s = await db.one('select id from shops limit 1');
  const h = await (await fetch(`${base}/s/${s.id}?lang=ta`)).text();
  assert(h.includes('lang="ta"') && h.includes('கார்ட்') && h.includes('பொருட்களைத் தேடுங்கள்'));
  const h2 = await (await fetch(`${base}/shops?lang=hi`)).text(); assert(h2.includes('मेरी लोकेशन'));
  srv.close();
  ok('website in Tamil / Hindi');

  for (const [who, p, from] of [['Tamil customer', CUST, c0], ['Hindi owner', OWNER, o0]]) {
    const b = english(p, from).filter((l) => !/Welcome|Choose your language|Language set to English/.test(l));
    console.log(`${who}: ${b.length} line(s) still in English`); b.forEach((l) => console.log('   ·', l));
  }
  console.log('\n--- Tamil customer (sample) ---'); all(CUST).slice(c0, c0 + 12).forEach((m) => console.log(txt(m), opts(m).map(([l]) => `[${l}]`).join(' ')));
  console.log('\n--- Hindi owner (sample) ---'); all(OWNER).slice(o0).filter((m) => /नया|कम स्टॉक|सेटिंग्स/.test(txt(m))).forEach((m) => console.log(txt(m), opts(m).map(([l]) => `[${l}]`).join(' ')));
  console.log('\nLanguage tests passed ✅'); process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
