const { Pool, types } = require('pg');
const cfg = require('./config');

types.setTypeParser(1700, parseFloat); // numeric -> number
types.setTypeParser(20, parseInt); // bigint -> number

const ssl = /localhost|127\.0\.0\.1|\.railway\.internal/.test(cfg.DATABASE_URL || '') ? false : { rejectUnauthorized: false };
const pool = new Pool({ connectionString: cfg.DATABASE_URL, ssl });

const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0];
const all = async (text, params) => (await pool.query(text, params)).rows;

async function init() {
  await q(`
  create table if not exists shops(
    id serial primary key, code text unique, name text not null, owner_phone text not null, area text,
    upi text, paid boolean default false, active boolean default false, delivery boolean default false,
    del_fee numeric default ${cfg.DEFAULT_DEL_FEE}, min_order numeric default 0, inv_seq int default 0,
    paid_at timestamptz, created_at timestamptz default now());
  create table if not exists items(
    id serial primary key, shop_id int references shops(id) on delete cascade, name text not null, cat text not null,
    price numeric not null, stock int default 0, created_at timestamptz default now());
  create table if not exists orders(
    id serial primary key, shop_id int references shops(id), cust_phone text, cust_name text, lines jsonb,
    subtotal numeric, del_fee numeric default 0, total numeric, mode text, addr text, pay text, paid boolean default false,
    status text default 'New', inv text, token text, created_at timestamptz default now(), updated_at timestamptz default now());
  create table if not exists sessions(phone text primary key, state text, data jsonb default '{}', updated_at timestamptz default now());
  create table if not exists menus(phone text primary key, text text, items jsonb);
  create table if not exists payments(
    id serial primary key, kind text, ref int, month text, amount numeric, link_id text, link_url text,
    status text default 'created', created_at timestamptz default now(), paid_at timestamptz);
  create index if not exists items_shop on items(shop_id);
  create index if not exists orders_shop on orders(shop_id, created_at);
  create index if not exists orders_cust on orders(cust_phone, created_at);
  `);
  const c = await one('select count(*)::int c from orders');
  if (c.c === 0) await q("select setval('orders_id_seq', 1000, true)");
}

// ---- domain helpers
const shops = {
  all: () => all('select * from shops order by id'),
  live: () => all('select * from shops where paid and active order by name'),
  get: (id) => one('select * from shops where id=$1', [id]),
  byOwner: (phone) => all('select * from shops where owner_phone=$1 order by id', [phone]),
  set: (id, f) => {
    const k = Object.keys(f);
    return one(`update shops set ${k.map((x, i) => `${x}=$${i + 2}`).join(',')} where id=$1 returning *`, [id, ...k.map((x) => f[x])]);
  },
  monthSales: async (id) =>
    (await one(`select coalesce(sum(subtotal),0) s from orders where shop_id=$1 and status<>'Cancelled'
      and created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`, [id])).s,
  todaySales: async (id) =>
    one(`select count(*)::int n, coalesce(sum(subtotal),0) s from orders where shop_id=$1 and status<>'Cancelled'
      and created_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`, [id]),
};
const items = {
  byShop: (sid) => all('select * from items where shop_id=$1 order by cat, name', [sid]),
  get: (id) => one('select * from items where id=$1', [id]),
  find: async (sid, qq) => {
    const list = await items.byShop(sid);
    const s = qq.toLowerCase().trim();
    return list.find((i) => i.name.toLowerCase() === s) || list.find((i) => i.name.toLowerCase().startsWith(s)) || list.find((i) => i.name.toLowerCase().includes(s));
  },
};
const orders = {
  get: (id) => one('select * from orders where id=$1', [id]),
  set: (id, f) => {
    const k = Object.keys(f);
    return one(`update orders set ${k.map((x, i) => `${x}=$${i + 2}`).join(',')}, updated_at=now() where id=$1 returning *`, [id, ...k.map((x) => f[x])]);
  },
  openByShop: (sid) => all(`select * from orders where shop_id=$1 and status not in ('Completed','Cancelled') order by id`, [sid]),
  recentByShop: (sid, n = 4) => all(`select * from orders where shop_id=$1 and status<>'Cancelled' order by id desc limit $2`, [sid, n]),
  byCustomer: (p, n = 5) => all('select * from orders where cust_phone=$1 order by id desc limit $2', [p, n]),
  activeDeliveries: () => all(`select o.*, s.name shop_name, s.area shop_area from orders o join shops s on s.id=o.shop_id
    where o.mode='delivery' and o.status not in ('Completed','Cancelled') order by o.id`),
};
const sessions = {
  get: async (phone) => (await one('select state, data from sessions where phone=$1', [phone])) || { state: null, data: {} },
  save: (phone, s) => q(`insert into sessions(phone,state,data,updated_at) values($1,$2,$3,now())
    on conflict(phone) do update set state=$2, data=$3, updated_at=now()`, [phone, s.state || null, JSON.stringify(s.data || {})]),
};

module.exports = { pool, q, one, all, init, shops, items, orders, sessions };
