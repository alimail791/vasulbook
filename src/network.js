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
async function markPaid(phone, ref) {
  const r = await db.one(`with u as (update earnings set status='paid', paid_at=now(), payout_ref=$2 where phone=$1 and status='due' returning amount) select coalesce(sum(amount),0) s, count(*)::int n from u`, [phone, ref || null]);
  return r;
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

module.exports = { AREA, ADMIN_PCT, SUP_PCT, DISTRICTS, monthKey, init, ensureRef, refLink, qrUrl, applyRef, referralArea, supervisorOf, scopeAreas,
  record, reverse, summary, payouts, markPaid, companyMonth, taluks, districts, districtStats, team };
