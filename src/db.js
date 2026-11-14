const { Pool, types } = require('pg');
const cfg = require('./config');

types.setTypeParser(1700, parseFloat); // numeric -> number
types.setTypeParser(20, parseInt); // bigint -> number

const ssl = /localhost|127\.0\.0\.1|\.railway\.internal/.test(cfg.DATABASE_URL || '') ? false : { rejectUnauthorized: false };
const pool = new Pool({ connectionString: cfg.DATABASE_URL, ssl });

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0];
const all = async (text, params) => (await pool.query(text, params)).rows;
const setter = (table) => (id, f) => {
  const k = Object.keys(f);
  return one(`update ${table} set ${k.map((x, i) => `${x}=$${i + 2}`).join(',')} where id=$1 returning *`, [id, ...k.map((x) => f[x])]);
};

async function init() {
  await q(`
  create table if not exists localities(
    id serial primary key, name text not null, admin_phone text, lat double precision, lng double precision,
    share numeric default ${cfg.AREA_SHARE}, active boolean default true, created_at timestamptz default now());
  create table if not exists advertisers(
    id serial primary key, phone text unique not null, name text not null, cat text, locality_id int references localities(id),
    lat double precision, lng double precision, address text, plan text, plan_until timestamptz, trial_used boolean default false,
    reminded_for timestamptz, ended_for timestamptz, active boolean default true, created_at timestamptz default now());
  create table if not exists media(id serial primary key, mime text, data bytea, created_at timestamptz default now());
  create table if not exists ads(
    id serial primary key, adv_id int references advertisers(id) on delete cascade, type text not null, cat text, sub text,
    title text not null, offer text, details text, media_id int references media(id), valid_until timestamptz, radius_km numeric default 2,
    featured boolean default false, status text default 'pending', reject_reason text, views int default 0, leads int default 0,
    redeemed int default 0, plan text, created_at timestamptz default now(), approved_at timestamptz);
  create table if not exists customers(
    phone text primary key, name text, lat double precision, lng double precision, locality_id int references localities(id),
    radius_km numeric default 2, subscribed boolean default false, last_digest date, last_seen timestamptz default now(), created_at timestamptz default now());
  create table if not exists coupons(code text primary key, ad_id int references ads(id) on delete cascade, phone text, created_at timestamptz default now(), redeemed_at timestamptz);
  create table if not exists leads(id serial primary key, ad_id int references ads(id) on delete cascade, phone text, kind text, note text, created_at timestamptz default now());
  create table if not exists payments(
    id serial primary key, adv_id int references advertisers(id) on delete cascade, plan text, amount numeric, method text,
    link_id text, link_url text, utr text, status text default 'created', locality_id int, created_at timestamptz default now(), paid_at timestamptz);
  create table if not exists settings(key text primary key, value jsonb);
  create table if not exists broadcasts(id serial primary key, scope text, sent int, created_at timestamptz default now());
  create table if not exists sessions(phone text primary key, state text, data jsonb default '{}', updated_at timestamptz default now());
  create table if not exists menus(phone text primary key, text text, items jsonb);
  create table if not exists otps(phone text primary key, code_hash text, tries int default 0, expires_at timestamptz, created_at timestamptz default now());
  create index if not exists ads_status on ads(status);
  create index if not exists ads_adv on ads(adv_id);
  create index if not exists leads_ad on leads(ad_id);
  `);
}

// ---- plans (defaults from config, prices overridable in settings)
async function plans() {
  const row = await one(`select value from settings where key='prices'`);
  const prices = (row && row.value) || {};
  const out = {};
  for (const [k, p] of Object.entries(cfg.PLANS)) out[k] = { ...p, key: k, price: prices[k] != null ? Number(prices[k]) : p.price };
  return out;
}
async function setPrice(key, price) {
  const row = await one(`select value from settings where key='prices'`);
  const v = { ...((row && row.value) || {}), [key]: Number(price) };
  await q(`insert into settings(key,value) values('prices',$1) on conflict(key) do update set value=$1`, [JSON.stringify(v)]);
}

const localities = {
  all: () => all('select * from localities order by name'),
  active: () => all('select * from localities where active order by name'),
  get: (id) => one('select * from localities where id=$1', [id]),
  byAdmin: (phone) => all('select * from localities where admin_phone=$1 order by name', [phone]),
  set: setter('localities'),
};
const advertisers = {
  get: (id) => one('select * from advertisers where id=$1', [id]),
  byPhone: (p) => one('select * from advertisers where phone=$1', [p]),
  set: setter('advertisers'),
};
const ads = {
  get: (id) => one('select a.*, v.name shop, v.phone adv_phone, v.lat, v.lng, v.address, v.locality_id from ads a join advertisers v on v.id=a.adv_id where a.id=$1', [id]),
  set: setter('ads'),
  byAdv: (advId) => all(`select * from ads where adv_id=$1 order by id desc`, [advId]),
  live: () => all(`select a.*, v.name shop, v.phone adv_phone, v.lat, v.lng, v.address, v.locality_id from ads a join advertisers v on v.id=a.adv_id
    where a.status='live' and v.active and v.lat is not null and (a.valid_until is null or a.valid_until > now())`),
  pending: () => all(`select a.*, v.name shop, v.phone adv_phone, v.lat, v.lng, v.address, v.locality_id from ads a join advertisers v on v.id=a.adv_id where a.status='pending' order by a.id`),
};
const customers = {
  get: (p) => one('select * from customers where phone=$1', [p]),
  touch: (p, name) => one(`insert into customers(phone,name) values($1,$2) on conflict(phone) do update set last_seen=now(), name=coalesce(nullif($2,''),customers.name) returning *`, [p, name || '']),
  set: (p, f) => { const k = Object.keys(f); return one(`update customers set ${k.map((x, i) => `${x}=$${i + 2}`).join(',')} where phone=$1 returning *`, [p, ...k.map((x) => f[x])]); },
};
const sessions = {
  get: async (phone) => (await one('select state, data from sessions where phone=$1', [phone])) || { state: null, data: {} },
  save: (phone, s) => q(`insert into sessions(phone,state,data,updated_at) values($1,$2,$3,now())
    on conflict(phone) do update set state=$2, data=$3, updated_at=now()`, [phone, s.state || null, JSON.stringify(s.data || {})]),
};

module.exports = { pool, q, one, all, init, plans, setPrice, localities, advertisers, ads, customers, sessions };
