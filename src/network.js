// Admin network: district → taluk (1 supervisor) → zone (1 admin, 2–5 km).
// Money is split only when it has actually been received:
//   zone admin NET_ADMIN_PCT (40%) · taluk supervisor NET_SUP_PCT (10%) · company the rest (50%).
// The same file is used by EMart and EDeal; only AREA (the zones table) differs.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const AREA = 'areas'; // EMart zones table (EDeal: 'localities')
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const ADMIN_PCT = num(process.env.NET_ADMIN_PCT, 40);
const SUP_PCT = num(process.env.NET_SUP_PCT, 10);

// 38 districts and their taluk counts (Wikipedia, revenue divisions of Tamil Nadu)
const DISTRICTS = [['Ariyalur', 4], ['Chengalpattu', 8], ['Chennai', 16], ['Coimbatore', 11], ['Cuddalore', 10], ['Dharmapuri', 7], ['Dindigul', 10], ['Erode', 10],
  ['Kallakurichi', 7], ['Kancheepuram', 5], ['Kanniyakumari', 6], ['Karur', 7], ['Krishnagiri', 8], ['Madurai', 11], ['Mayiladuthurai', 4], ['Nagapattinam', 4],
  ['Namakkal', 8], ['Perambalur', 4], ['Pudukkottai', 12], ['Ramanathapuram', 9], ['Ranipet', 6], ['Salem', 14], ['Sivagangai', 9], ['Thanjavur', 9],
  ['The Nilgiris', 6], ['Tenkasi', 8], ['Theni', 5], ['Tiruchirappalli', 11], ['Tirunelveli', 8], ['Tirupathur', 4], ['Tiruppur', 9], ['Tiruvallur', 9],
  ['Tiruvannamalai', 12], ['Tiruvarur', 8], ['Thoothukudi', 10], ['Vellore', 6], ['Viluppuram', 9], ['Virudhunagar', 10]];

const monthKey = (d = new Date()) => new Date(new Date(d).getTime() + 5.5 * 36e5).toISOString().slice(0, 7);
const round2 = (n) => Math.round(n * 100) / 100;

async function init() {
  await db.q(`
  create table if not exists districts(id serial primary key, name text unique not null, taluks_planned int default 0);
  create table if not exists taluks(id serial primary key, district_id int references districts(id), name text not null,
    supervisor_phone text, created_at timestamptz default now(), unique(district_id, name));
  alter table ${AREA} add column if not exists taluk_id int references taluks(id);
  alter table ${AREA} add column if not exists ref_code text unique;
  create table if not exists earnings(
    id serial primary key, payment_id int not null, source text not null, kind text not null default 'earn',
    area_id int, taluk_id int, role text not null, phone text not null, base numeric, pct numeric, amount numeric not null,
    month text not null, status text not null default 'due', payout_ref text, note text,
    created_at timestamptz default now(), paid_at timestamptz, unique(payment_id, source, role, kind));
  create index if not exists earnings_phone on earnings(phone, status);
  create table if not exists referrals(phone text primary key, area_id int, code text, created_at timestamptz default now());
  create table if not exists kv(key text primary key, value text, updated_at timestamptz default now());
  alter table ${AREA} add column if not exists admin_since timestamptz;
  alter table ${AREA} add column if not exists level text default 'Bronze';
  alter table ${AREA} add column if not exists review_note text;
  alter table ${AREA} add column if not exists reviewed_at timestamptz;
  update ${AREA} set admin_since=coalesce(admin_since, created_at) where admin_phone is not null and admin_since is null;
  -- people who want to become zone admins (WhatsApp "ADMIN")
  create table if not exists applications(id serial primary key, phone text not null, name text, place text, district_id int, taluk_id int,
    lat double precision, lng double precision, pan text, upi text, status text default 'pending', area_id int, note text,
    created_at timestamptz default now(), decided_at timestamptz, agreed_at timestamptz);
  -- where to send each person's payout
  create table if not exists payees(phone text primary key, name text, upi text, pan text, updated_at timestamptz default now());
  create table if not exists payouts(id serial primary key, phone text not null, gross numeric, tds numeric, net numeric, ref text, fy text, created_at timestamptz default now());
  alter table earnings add column if not exists payout_id int;
  -- who changed what (panel and admin actions)
  create table if not exists audit(id serial primary key, phone text, action text, detail text, created_at timestamptz default now());
  -- WhatsApp messages started by us (templates), per day and locality, for cost and limits
  create table if not exists msg_log(day date not null, area_id int not null default 0, kind text not null, n int default 0, primary key(day, area_id, kind));
  `);
  for (const [n, t] of DISTRICTS) await db.q('insert into districts(name,taluks_planned) values($1,$2) on conflict(name) do update set taluks_planned=$2', [n, t]);
  for (const a of await db.all(`select id from ${AREA} where ref_code is null`)) await ensureRef(a.id);
}

// ---------------------------------------------------------------- referral codes
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function ensureRef(areaId) {
  const a = await db.one(`select * from ${AREA} where id=$1`, [areaId]);
  if (!a || a.ref_code) return a;
  for (;;) {
    const code = Array.from({ length: 5 }, () => ALPHA[crypto.randomInt(ALPHA.length)]).join('');
    const r = await db.one(`update ${AREA} set ref_code=$2 where id=$1 and ref_code is null and not exists (select 1 from ${AREA} where ref_code=$2) returning *`, [areaId, code]);
    if (r) return r;
    const again = await db.one(`select * from ${AREA} where id=$1`, [areaId]);
    if (again.ref_code) return again;
  }
}
// wa.me link that opens the bot with "Hi ref:CODE" typed in
function refLink(a, word = 'Hi') {
  if (!a || !a.ref_code) return '';
  const text = encodeURIComponent(`${word} ref:${a.ref_code}`);
  const bot = cfg.norm(process.env.BOT_PHONE || '');
  return bot ? `https://wa.me/${bot}?text=${text}` : `${cfg.PUBLIC_URL}/r/${a.ref_code}`;
}
const qrUrl = (link) => `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(link)}`;
const REF_RE = /\bref[:\s#-]*([A-Z2-9]{5})\b/i;
// Takes "ref:CODE" out of a message. Saves who referred this person (first referral wins).
async function applyRef(phone, text) {
  const m = String(text || '').match(REF_RE);
  if (!m) return null;
  const a = await db.one(`select * from ${AREA} where upper(ref_code)=$1`, [m[1].toUpperCase()]);
  const rest = String(text).replace(REF_RE, '').replace(/\s+/g, ' ').trim();
  if (!a) return { area: null, rest, isNew: false };
  const r = await db.one('insert into referrals(phone,area_id,code) values($1,$2,$3) on conflict(phone) do nothing returning *', [phone, a.id, a.ref_code]);
  return { area: a, rest, isNew: !!r };
}
async function referralArea(phone) {
  const r = await db.one(`select a.* from referrals r join ${AREA} a on a.id=r.area_id where r.phone=$1 and a.active`, [phone]);
  return r || null;
}

// ---------------------------------------------------------------- scopes
const supervisorOf = (phone) => db.all('select t.*, d.name district from taluks t join districts d on d.id=t.district_id where t.supervisor_phone=$1 order by d.name, t.name', [phone]);
// Zones a person may see: the ones they run, plus every zone in the taluks they supervise
const scopeAreas = (phone) => db.all(`select * from ${AREA} where admin_phone=$1 or taluk_id in (select id from taluks where supervisor_phone=$1) order by name`, [phone]);

// ---------------------------------------------------------------- ledger
// Call once a payment has really been received. Safe to call twice.
async function record({ paymentId, source, areaId, amount, paidAt }) {
  const a = areaId ? await db.one(`select * from ${AREA} where id=$1`, [areaId]) : null;
  const t = a && a.taluk_id ? await db.one('select * from taluks where id=$1', [a.taluk_id]) : null;
  const month = monthKey(paidAt || new Date());
  const out = [];
  const add = async (role, phone, pct) => {
    if (!phone || cfg.ADMINS.includes(phone) || !pct) return;
    const r = await db.one(`insert into earnings(payment_id,source,area_id,taluk_id,role,phone,base,pct,amount,month) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict(payment_id,source,role,kind) do nothing returning *`, [paymentId, source, a ? a.id : null, t ? t.id : null, role, phone, amount, pct, round2((amount * pct) / 100), month]);
    if (r) out.push(r);
  };
  await add('admin', a && a.admin_phone, ADMIN_PCT);
  await add('supervisor', t && t.supervisor_phone, SUP_PCT);
  return out;
}
// Refund: commission not yet paid out is cancelled; commission already paid out is taken from the next payout.
async function reverse(paymentId, source, note = 'refund') {
  const rows = await db.all(`select * from earnings where payment_id=$1 and source=$2 and kind='earn' and status<>'reversed'`, [paymentId, source]);
  for (const e of rows) {
    if (e.status === 'due') await db.q(`update earnings set status='reversed', note=$2 where id=$1`, [e.id, note]);
    else await db.q(`insert into earnings(payment_id,source,kind,area_id,taluk_id,role,phone,base,pct,amount,month,note) values($1,$2,'reverse',$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict do nothing`, [e.payment_id, e.source, e.area_id, e.taluk_id, e.role, e.phone, e.base, e.pct, -e.amount, monthKey(), note]);
  }
  return rows.length;
}
async function summary(phone) {
  const r = await db.one(`select
    coalesce(sum(amount) filter (where month=$2 and status<>'reversed'),0) as "month",
    coalesce(sum(amount) filter (where status='due'),0) due,
    coalesce(sum(amount) filter (where status='paid'),0) paid
    from earnings where phone=$1`, [phone, monthKey()]);
  return r;
}
async function payouts() {
  return db.all(`select phone, string_agg(distinct role, ', ') roles, sum(amount) due, count(*)::int n from earnings where status='due' group by phone order by sum(amount) desc`);
}
async function companyMonth() {
  return db.one(`select coalesce(sum(amount) filter (where role='admin'),0) admins, coalesce(sum(amount) filter (where role='supervisor'),0) sups
    from earnings where month=$1 and status<>'reversed'`, [monthKey()]);
}

// ---------------------------------------------------------------- taluks
const taluks = {
  all: () => db.all(`select t.*, d.name district from taluks t join districts d on d.id=t.district_id order by d.name, t.name`),
  get: (id) => db.one('select t.*, d.name district from taluks t join districts d on d.id=t.district_id where t.id=$1', [id]),
  add: (districtId, name, sup) => db.one(`insert into taluks(district_id,name,supervisor_phone) values($1,$2,$3)
    on conflict(district_id,name) do update set supervisor_phone=coalesce($3,taluks.supervisor_phone) returning *`, [districtId, name, sup || null]),
  setSupervisor: (id, sup) => db.one('update taluks set supervisor_phone=$2 where id=$1 returning *', [id, sup || null]),
};
const districts = () => db.all('select * from districts order by name');

// Rows for the main admin's network page
async function districtStats() {
  return db.all(`select d.id, d.name, d.taluks_planned,
    (select count(*)::int from taluks t where t.district_id=d.id) taluks,
    (select count(*)::int from taluks t where t.district_id=d.id and t.supervisor_phone is not null) sups,
    (select count(*)::int from ${AREA} a join taluks t on t.id=a.taluk_id where t.district_id=d.id) zones,
    (select count(*)::int from ${AREA} a join taluks t on t.id=a.taluk_id where t.district_id=d.id and a.admin_phone is not null) admins,
    (select coalesce(sum(e.base),0) from earnings e join taluks t on t.id=e.taluk_id where t.district_id=d.id and e.role='admin' and e.kind='earn' and e.status<>'reversed' and e.month=$1) revenue
    from districts d order by d.name`, [monthKey()]);
}
// Each zone admin under a supervisor, with this month's numbers
async function team(supPhone) {
  return db.all(`select a.*, t.name taluk,
    (select coalesce(sum(amount),0) from earnings e where e.area_id=a.id and e.role='admin' and e.month=$2 and e.status<>'reversed') earned
    from ${AREA} a join taluks t on t.id=a.taluk_id where t.supervisor_phone=$1 order by t.name, a.name`, [supPhone, monthKey()]);
}

// ================================================================ 6. recruiting
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const UPI_RE = /^[\w.\-]{2,}@[a-zA-Z][\w.\-]{1,}$/;
const istNow = () => new Date(Date.now() + 5.5 * 36e5);
// Seats in a taluk: 10 zone admins
const SEATS = num(process.env.NET_SEATS_PER_TALUK, 10);
async function findTaluk(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z\s,]/g, ' ');
  const all = await taluks.all();
  return all.find((x) => t.includes(x.name.toLowerCase())) || null;
}
async function findDistrict(text) {
  const t = String(text || '').toLowerCase();
  return (await districts()).find((d) => t.includes(d.name.toLowerCase().replace('the ', ''))) || null;
}
async function seatsTaken(talukId) {
  return (await db.one(`select count(*)::int n from ${AREA} where taluk_id=$1 and admin_phone is not null`, [talukId])).n;
}
// One WhatsApp conversation step. Returns { text, btns, ask: 'location' } or null when this message is not part of an application.
async function recruitStep(phone, sess, v, loc) {
  const S = sess, D = (S.data.rc = S.data.rc || {});
  const low = String(v || '').trim().toLowerCase();
  const start = ['admin', 'join admin', 'become admin', 'admin job', 'நிர்வாகி'].includes(low) || /^admin\b/i.test(String(v || '').trim()) && low.length < 30;
  if (start && !S.state?.startsWith('rc_')) {
    const open = await db.one(`select * from applications where phone=$1 and status in ('pending','waitlist','approved') order by id desc limit 1`, [phone]);
    if (open) return { text: open.status === 'approved' ? 'Your application is approved. Tap *I agree* on the agreement message to start.' : `Your application #${open.id} is ${open.status === 'waitlist' ? 'on the waiting list (your taluk is full)' : 'being reviewed'}. We'll message you here.` };
    S.state = 'rc_name'; S.data.rc = {};
    return { text: `🙌 *Become a ${cfg.BRAND} zone admin*\nYou earn *${ADMIN_PCT}%* of every payment from shops and businesses in your 2–5 km zone. Free to join.\n\nStep 1 of 5 — send your *full name*.` };
  }
  if (!S.state || !S.state.startsWith('rc_')) return null;
  if (low === 'cancel') { S.state = null; S.data.rc = null; return { text: 'Application cancelled. Send *ADMIN* any time to start again.' }; }
  if (S.state === 'rc_name') {
    if (String(v).trim().length < 3) return { text: 'Please send your full name.' };
    D.name = String(v).trim().slice(0, 80); S.state = 'rc_place';
    return { text: 'Step 2 of 5 — send your *town, taluk and district*.\nExample: _Ambattur, Ambattur taluk, Chennai_' };
  }
  if (S.state === 'rc_place') {
    D.place = String(v).trim().slice(0, 160);
    const t = await findTaluk(D.place), d = t ? null : await findDistrict(D.place);
    D.taluk_id = t ? t.id : null; D.district_id = t ? t.district_id : d ? d.id : null;
    S.state = 'rc_loc';
    return { text: 'Step 3 of 5 — share the *centre of your zone*: tap 📎 → *Location* and drop the pin in the middle of the area you will cover.', ask: 'location' };
  }
  if (S.state === 'rc_loc') {
    if (!loc) return { text: 'Please share a location: tap 📎 → *Location*.', ask: 'location' };
    D.lat = loc.lat; D.lng = loc.lng; S.state = 'rc_pan';
    return { text: 'Step 4 of 5 — send your *PAN number* (needed for TDS on your commission).\nExample: ABCDE1234F' };
  }
  if (S.state === 'rc_pan') {
    const pan = String(v).trim().toUpperCase().replace(/\s/g, '');
    if (!PAN_RE.test(pan)) return { text: 'That does not look like a PAN. It has 10 characters, like *ABCDE1234F*. Please send it again.' };
    D.pan = pan; S.state = 'rc_upi';
    return { text: 'Step 5 of 5 — send the *UPI ID* where we should pay your commission.\nExample: name@okaxis' };
  }
  if (S.state === 'rc_upi') {
    const upi = String(v).trim();
    if (!UPI_RE.test(upi)) return { text: 'Please send a UPI ID like *name@okaxis*.' };
    D.upi = upi;
    let status = 'pending', note = '';
    if (D.taluk_id && (await seatsTaken(D.taluk_id)) >= SEATS) { status = 'waitlist'; note = 'taluk full'; }
    const a = await db.one(`insert into applications(phone,name,place,district_id,taluk_id,lat,lng,pan,upi,status,note) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [phone, D.name, D.place, D.district_id, D.taluk_id, D.lat, D.lng, D.pan, D.upi, status, note]);
    S.state = null; S.data.rc = null;
    return { done: a, text: status === 'waitlist' ? `✅ Thank you, ${a.name}! Your taluk already has ${SEATS} admins, so you are on the *waiting list* (#${a.id}). We'll message you when a place opens.` : `✅ Thank you, ${a.name}! Application *#${a.id}* is sent. You'll get a reply here after review.` };
  }
  return null;
}
const appLine = async (a) => {
  const t = a.taluk_id ? await taluks.get(a.taluk_id) : null;
  return `📝 *Admin application #${a.id}*${a.status === 'waitlist' ? ' (waiting list)' : ''}\n👤 ${a.name} · +${a.phone}\n📍 ${a.place}${t ? `\n🗺 Taluk: ${t.name} (${t.district})` : '\n🗺 Taluk: not matched — set it in the panel'}\n📌 https://maps.google.com/?q=${a.lat},${a.lng}\n💳 UPI ${a.upi} · PAN ${a.pan.slice(0, 2)}••••${a.pan.slice(-2)}`;
};
// Agreement summary in Tamil and English (the full handbook is shared separately)
const agreementText = () => `📄 *${cfg.BRAND} zone admin agreement*\n\n• நீங்கள் சுயாதீன கமிஷன் பங்குதாரர்; ஊழியர் அல்ல. சேர கட்டணம் இல்லை.\n• உங்கள் மண்டல வருவாயில் ${ADMIN_PCT}% கமிஷன் — பணம் நிறுவனத்துக்கு வந்த பிறகே.\n• ரொக்கம் / சொந்த கணக்கில் பணம் வாங்கக் கூடாது; நிறுவன UPI / இணைப்பு மட்டும்.\n• 3 மாத மதிப்பாய்வு; 60 நாள் செயல்பாடு இல்லையெனில் மண்டலம் மாற்றப்படும்.\n• 15 நாள் முன்னறிவிப்புடன் விலகலாம்.\n\n• You are an independent commission partner, not an employee. Free to join.\n• ${ADMIN_PCT}% of your zone's revenue, paid only after the money reaches the company.\n• No cash or personal-account collection; company UPI or payment link only.\n• 3-month review; a zone with no activity for 60 days is reassigned.\n• Either side can end this with 15 days' notice.\n\nTap *I agree* to start.`;
async function decide(appId, approve, byPhone) {
  const a = await db.one(`update applications set status=$2, decided_at=now() where id=$1 and status in ('pending','waitlist') returning *`, [appId, approve ? 'approved' : 'rejected']);
  if (a) await log(byPhone, approve ? 'approve application' : 'reject application', `#${a.id} ${a.name} +${a.phone}`);
  return a;
}
// After "I agree": create the zone and save the payout details. Returns the new zone.
async function agree(phone) {
  const a = await db.one(`update applications set status='active', agreed_at=now() where id=(select id from applications where phone=$1 and status='approved' order by id desc limit 1) returning *`, [phone]);
  if (!a) return null;
  await db.q(`insert into payees(phone,name,upi,pan) values($1,$2,$3,$4) on conflict(phone) do update set name=$2, upi=$3, pan=$4, updated_at=now()`, [a.phone, a.name, a.upi, a.pan]);
  const zone = await createZone({ name: zoneName(a), admin_phone: a.phone, lat: a.lat, lng: a.lng, taluk_id: a.taluk_id });
  await db.q('update applications set area_id=$2 where id=$1', [a.id, zone.id]);
  return { app: a, zone };
}
const zoneName = (a) => String(a.place || a.name).split(',')[0].trim().slice(0, 60) || 'Zone ' + a.id;
async function createZone({ name, admin_phone, lat, lng, taluk_id }) {
  const ex = await db.one(`select * from ${AREA} where admin_phone=$1 and lat=$2 and lng=$3`, [admin_phone, lat, lng]);
  if (ex) return ex;
  const cols = AREA === 'areas' ? 'name,admin_phone,lat,lng,taluk_id,admin_since,radius_km' : 'name,admin_phone,lat,lng,taluk_id,admin_since';
  const vals = AREA === 'areas' ? [name, admin_phone, lat, lng, taluk_id || null, new Date(), 3] : [name, admin_phone, lat, lng, taluk_id || null, new Date()];
  const z = await db.one(`insert into ${AREA}(${cols}) values(${vals.map((_, i) => '$' + (i + 1)).join(',')}) returning *`, vals);
  return ensureRef(z.id);
}
// Admin changed on a zone: restart the review clock
const adminChanged = (id) => db.q(`update ${AREA} set admin_since=now(), level='Bronze', reviewed_at=null, review_note=null where id=$1`, [id]);

// ================================================================ 7. payouts with TDS (Section 194H)
const TDS_PCT = num(process.env.TDS_PCT, 2);
const TDS_LIMIT = num(process.env.TDS_THRESHOLD, 20000); // per financial year, per person
const fyOf = (d = istNow()) => { const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1; const s = m >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };
async function payoutPreview(phone) {
  const due = Number((await db.one(`select coalesce(sum(amount),0) s from earnings where phone=$1 and status='due'`, [phone])).s);
  const fy = fyOf();
  const prev = await db.one(`select coalesce(sum(gross),0) g, coalesce(sum(tds),0) t from payouts where phone=$1 and fy=$2`, [phone, fy]);
  const fyGross = Number(prev.g) + Math.max(0, due);
  // Once a person's commission in the year crosses the limit, TDS applies to the whole year's amount
  const tds = fyGross > TDS_LIMIT && due > 0 ? Math.max(0, round2((fyGross * TDS_PCT) / 100 - Number(prev.t))) : 0;
  return { due: round2(due), tds, net: round2(due - tds), fy };
}
async function markPaid(phone, ref) {
  const pv = await payoutPreview(phone);
  if (pv.due <= 0) return { s: 0, n: 0, ...pv };
  const po = await db.one(`insert into payouts(phone,gross,tds,net,ref,fy) values($1,$2,$3,$4,$5,$6) returning *`, [phone, pv.due, pv.tds, pv.net, ref || null, pv.fy]);
  const r = await db.one(`with u as (update earnings set status='paid', paid_at=now(), payout_ref=$2, payout_id=$3 where phone=$1 and status='due' returning amount) select coalesce(sum(amount),0) s, count(*)::int n from u`, [phone, ref || null, po.id]);
  return { ...r, ...pv, payout: po };
}
async function payoutRows() {
  const rows = await payouts();
  for (const p of rows) { Object.assign(p, await payoutPreview(p.phone)); p.payee = await db.one('select * from payees where phone=$1', [p.phone]); }
  return rows.filter((p) => p.due > 0);
}
// CSV for a bulk UPI payout (Razorpay / Cashfree / bank upload)
async function payoutCsv() {
  const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines = [['name', 'upi_id', 'phone', 'amount_inr', 'tds_inr', 'gross_inr', 'narration'].join(',')];
  for (const p of await payoutRows()) lines.push([q(p.payee && p.payee.name), q(p.payee && p.payee.upi), q('+' + p.phone), p.net.toFixed(2), p.tds.toFixed(2), p.due.toFixed(2), q(`${cfg.BRAND} commission ${monthKey()}`)].join(','));
  return lines.join('\n') + '\n';
}
// Monthly statement text for one person (last month)
async function statementText(phone, mk) {
  const r = await db.one(`select coalesce(sum(amount) filter (where kind='earn' and status<>'reversed'),0) earned, coalesce(sum(amount) filter (where kind='reverse'),0) back, count(*) filter (where kind='earn')::int n from earnings where phone=$1 and month=$2`, [phone, mk]);
  const pv = await payoutPreview(phone);
  return `📊 *${cfg.BRAND} statement — ${mk}*\nPayments with commission: ${r.n}\nEarned: *₹${round2(r.earned)}*${Number(r.back) ? `\nRefunds taken back: ₹${round2(-r.back)}` : ''}\n\nNext payout: ₹${pv.due}${pv.tds ? ` − TDS ₹${pv.tds} (${TDS_PCT}%) = *₹${pv.net}*` : ` = *₹${pv.net}*`}`;
}
async function statementPhones(mk) { return (await db.all(`select distinct phone from earnings where month=$1 or status='due'`, [mk])).map((x) => x.phone); }

// ================================================================ 10. performance
const REVIEW_DAYS = 90, GRACE_DAYS = 30, IDLE_DAYS = 60;
// metric(area) → { ok: bool, line: text } — each bot passes its own rule (EMart: shops; EDeal: paying advertisers)
async function reviewZones(metric, notify, notifyAdmins) {
  const out = [];
  const zones = await db.all(`select * from ${AREA} where admin_phone is not null and active and admin_since is not null`);
  for (const a of zones) {
    const days = Math.floor((Date.now() - new Date(a.admin_since).getTime()) / 864e5);
    // 3-month review (and one extra month if it fails)
    if (days >= REVIEW_DAYS && (a.level || 'Bronze') === 'Bronze') {
      const due = !a.reviewed_at || (a.review_note === 'extended' && days >= REVIEW_DAYS + GRACE_DAYS);
      if (due) {
        const m = await metric(a);
        if (m.ok) {
          await db.q(`update ${AREA} set level='Silver', reviewed_at=now(), review_note='passed' where id=$1`, [a.id]);
          await notify(a.admin_phone, `🥈 Congratulations! *${a.name}* passed the 3-month review (${m.line}). You are now a *Silver* admin.`);
          out.push([a.name, 'Silver']);
        } else if (a.review_note !== 'extended') {
          await db.q(`update ${AREA} set reviewed_at=now(), review_note='extended' where id=$1`, [a.id]);
          await notify(a.admin_phone, `⏳ 3-month review for *${a.name}*: ${m.line}. You have *one more month* to reach the target.`);
          await notifyAdmins(`⏳ ${a.name} (+${a.admin_phone}) missed the 3-month review: ${m.line}. Given one more month.`);
          out.push([a.name, 'extended']);
        } else {
          await db.q(`update ${AREA} set reviewed_at=now(), review_note='failed' where id=$1`, [a.id]);
          await notifyAdmins(`⚠️ ${a.name} (+${a.admin_phone}) missed the target again: ${m.line}. You can give this zone to a new admin on the panel.`);
          out.push([a.name, 'failed']);
        }
      }
    }
    // No activity for 60 days (no new shop/advertiser and no payment): warn once a month
    if (days >= IDLE_DAYS && (await idle(a))) {
      const k = `idle:${a.id}:${monthKey()}`;
      if (await db.one(`insert into kv(key,value) values($1,'1') on conflict do nothing returning key`, [k])) {
        await notify(a.admin_phone, `⚠️ No new business or payment in *${a.name}* for ${IDLE_DAYS} days. Please restart visits — inactive zones are given to new admins.`);
        await notifyAdmins(`⚠️ ${a.name} (+${a.admin_phone}) has had no activity for ${IDLE_DAYS} days. You can reassign it on the panel.`);
        out.push([a.name, 'idle']);
      }
    }
  }
  return out;
}
let idleCheck = async () => false; // set by each bot: (area) => bool
const setIdleCheck = (fn) => { idleCheck = fn; };
const idle = (a) => idleCheck(a);
// Gold: zone admin earned at least GOLD_MONTHLY in each of the last 3 months
const GOLD = num(process.env.NET_GOLD_MONTHLY, 10000);
async function goldCheck(notify) {
  const ms = [1, 2, 3].map((k) => { const d = istNow(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return d.toISOString().slice(0, 7); });
  const rows = await db.all(`select a.* from ${AREA} a where a.level='Silver' and (select count(*) from (select month from earnings e where e.area_id=a.id and e.role='admin' and e.status<>'reversed' and e.month = any($1) group by month having sum(amount) >= $2) x) = 3`, [ms, GOLD]);
  for (const a of rows) { await db.q(`update ${AREA} set level='Gold' where id=$1`, [a.id]); await notify(a.admin_phone, `🥇 *${a.name}* is now a *Gold* zone! ₹${GOLD}+ for 3 months in a row. You get the quarterly bonus and first chance at supervisor roles.`); }
  return rows.length;
}

// ================================================================ 11–12. message cost, limits, audit
const MSG_COST = num(process.env.WA_COST_MARKETING, 0.8); // ₹ per marketing template (estimate; set from your Meta invoice)
const DAILY_LIMIT = num(process.env.WA_DAILY_LIMIT, 1000); // business-initiated chats per day (Meta tier)
const today = () => istNow().toISOString().slice(0, 10);
async function countMsg(kind, areaId = 0, n = 1) {
  await db.q(`insert into msg_log(day,area_id,kind,n) values($1,$2,$3,$4) on conflict(day,area_id,kind) do update set n=msg_log.n+$4`, [today(), areaId || 0, kind, n]);
}
async function sentToday() { return Number((await db.one(`select coalesce(sum(n),0) n from msg_log where day=$1 and kind in ('template','marketing')`, [today()])).n); }
const canStart = async () => (await sentToday()) < DAILY_LIMIT;
async function msgStats() {
  return db.all(`select l.area_id, a.name, sum(l.n) filter (where l.kind='marketing')::int marketing, sum(l.n) filter (where l.kind='template')::int utility
    from msg_log l left join ${AREA} a on a.id=l.area_id where to_char(l.day,'YYYY-MM')=$1 group by l.area_id, a.name order by 3 desc nulls last`, [monthKey()]);
}
async function log(phone, action, detail) {
  try { await db.q('insert into audit(phone,action,detail) values($1,$2,$3)', [phone || null, String(action).slice(0, 120), String(detail || '').slice(0, 500)]); } catch (e) { console.error('audit', e.message); }
}
// Express middleware: record every change made on the panel (passwords and codes left out)
const auditMiddleware = (req, _res, next) => {
  if (req.method === 'POST' && req.u) {
    const b = { ...(req.body || {}) }; for (const k of ['key', 'code', 'pan']) if (k in b) b[k] = '•••';
    log(req.u.phone, 'panel ' + req.path, JSON.stringify(b).slice(0, 400));
  }
  next();
};
const auditRows = (n = 200) => db.all('select * from audit order by id desc limit $1', [n]);

// ================================================================ the other bot (EMart ↔ EDeal)
// PEER_URL = the other bot's address, PEER_KEY = the same secret on both
async function peer(path, body) {
  const url = process.env.PEER_URL, key = process.env.PEER_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(url.replace(/\/$/, '') + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-peer-key': key }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.error('peer', path, r.status, j);
    return j;
  } catch (e) { console.error('peer', path, e.message); return null; }
}
const peerAuth = (req) => !!process.env.PEER_KEY && req.get('x-peer-key') === process.env.PEER_KEY;
// Same taluk on the other bot (taluks are matched by district + name)
async function talukByName(district, name, supervisor) {
  if (!district || !name) return null;
  const d = await db.one('select * from districts where name=$1', [district]);
  return d ? taluks.add(d.id, name, supervisor ? cfg.norm(supervisor) : null) : null;
}
// What the other bot needs to open the same zone
async function zonePayload(z, quiet = false) {
  const t = z.taluk_id ? await taluks.get(z.taluk_id) : null;
  const payee = await db.one('select name, upi, pan from payees where phone=$1', [z.admin_phone]);
  return { name: z.name, admin_phone: z.admin_phone, lat: z.lat, lng: z.lng, district: t && t.district, taluk: t && t.name, supervisor: t && t.supervisor_phone, payee, quiet };
}

module.exports = { zonePayload, peer, peerAuth, talukByName, recruitStep, appLine, agreementText, decide, agree, createZone, adminChanged, findTaluk, seatsTaken, SEATS,
  TDS_PCT, TDS_LIMIT, payoutPreview, payoutRows, payoutCsv, statementText, statementPhones, fyOf,
  reviewZones, setIdleCheck, goldCheck, GOLD,
  MSG_COST, DAILY_LIMIT, countMsg, sentToday, canStart, msgStats, log, auditMiddleware, auditRows,
  AREA, ADMIN_PCT, SUP_PCT, DISTRICTS, monthKey, init, ensureRef, refLink, qrUrl, applyRef, referralArea, supervisorOf, scopeAreas,
  record, reverse, summary, payouts, markPaid, companyMonth, taluks, districts, districtStats, team };
