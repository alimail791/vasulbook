// Shop types and their item categories, plus one item-import routine used by
// WhatsApp, the panel's paste box and the Excel upload.
const db = require('./db');

const DEFAULTS = [
  ['Grocery', ['Rice & Grains', 'Atta & Flours', 'Pulses & Dals', 'Oil & Ghee', 'Spices & Masala', 'Sugar, Salt & Jaggery', 'Tea & Coffee', 'Snacks & Biscuits', 'Personal Care', 'Household & Cleaning', 'Others']],
  ['Vegetables & Fruits', ['Vegetables', 'Leafy Greens', 'Fruits', 'Others']],
  ['Dairy & Bakery', ['Milk', 'Curd & Paneer', 'Butter & Cheese', 'Bread & Buns', 'Cakes & Biscuits', 'Eggs', 'Others']],
  ['Meat & Fish', ['Chicken', 'Mutton', 'Fish & Seafood', 'Eggs', 'Others']],
  ['Stationery', ['Notebooks', 'Pens & Pencils', 'Art & Craft', 'Office Supplies', 'Others']],
];

async function init() {
  await db.q(`
  create table if not exists shop_types(id serial primary key, name text unique not null, sort int default 0, active boolean default true);
  create table if not exists categories(id serial primary key, type_id int references shop_types(id) on delete cascade, name text not null, sort int default 0, unique(type_id, name));
  alter table shops add column if not exists type_id int references shop_types(id);`);
  const n = (await db.one('select count(*)::int c from shop_types')).c;
  if (n === 0) {
    for (const [i, [name, cats]] of DEFAULTS.entries()) {
      const t = await db.one('insert into shop_types(name, sort) values($1,$2) returning id', [name, i]);
      await setCategories(t.id, cats);
    }
  }
}

const types = (all) => db.all(`select t.*, (select count(*)::int from shops s where s.type_id=t.id) shops from shop_types t ${all ? '' : 'where t.active'} order by t.sort, t.name`);
const type = (id) => db.one('select * from shop_types where id=$1', [id]);
const categories = (typeId) => (typeId ? db.all('select * from categories where type_id=$1 order by sort, name', [typeId]) : Promise.resolve([]));

// Replace a type's category list with the given names, in order.
async function setCategories(typeId, names) {
  const seen = new Map();
  for (const x of names.map((n) => String(n).trim().replace(/\s+/g, ' ')).filter(Boolean)) if (!seen.has(x.toLowerCase())) seen.set(x.toLowerCase(), x.slice(0, 40));
  const clean = [...seen.values()];
  await db.q('delete from categories where type_id=$1 and not (lower(name) = any($2))', [typeId, clean.map((x) => x.toLowerCase())]);
  for (const [i, name] of clean.entries()) {
    await db.q(`insert into categories(type_id,name,sort) values($1,$2,$3) on conflict(type_id,name) do update set sort=$3`, [typeId, name, i]);
  }
  return clean;
}

const key = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

// Map a typed category onto the shop type's list. No list for the type = any category is fine.
function matchCategory(cats, typed) {
  const t = String(typed || '').trim();
  if (!cats.length) return { cat: t };
  const k = key(t);
  const hit = cats.find((c) => key(c.name) === k) || cats.find((c) => key(c.name).startsWith(k) && k.length >= 3) || cats.find((c) => k.length >= 4 && key(c.name).includes(k));
  return hit ? { cat: hit.name } : { err: `unknown category "${t}"` };
}

// Order a shop's categories: the type's order first, the rest alphabetically.
async function sortCats(shop, names) {
  const cats = await categories(shop.type_id);
  const pos = new Map(cats.map((c, i) => [c.name, i]));
  return [...names].sort((a, b) => (pos.has(a) ? pos.get(a) : 999) - (pos.has(b) ? pos.get(b) : 999) || a.localeCompare(b));
}

// rows: [{ name, cat, price, stock, row? }] → adds new items, updates existing ones by name.
// replace=true also removes the shop's items that are not in rows.
async function importItems(shop, rows, { replace = false } = {}) {
  const cats = await categories(shop.type_id);
  const list = await db.items.byShop(shop.id);
  const byName = new Map(list.map((i) => [i.name.toLowerCase(), i]));
  const res = { added: [], updated: [], removed: 0, errors: [], allowed: cats.map((c) => c.name) };
  const seen = new Set();
  for (const r of rows) {
    const where = r.row ? `Row ${r.row}` : `"${r.name || ''}"`;
    const name = String(r.name || '').trim().replace(/\s+/g, ' ');
    const price = Number(String(r.price ?? '').replace(/[₹,\s]/g, ''));
    const stockRaw = String(r.stock ?? '').replace(/[,\s]/g, '');
    const stock = stockRaw === '' ? null : parseInt(stockRaw, 10);
    if (!name) { res.errors.push(`${where}: item name is empty`); continue; }
    if (name.length > 80) { res.errors.push(`${where}: name longer than 80 characters`); continue; }
    if (!(price >= 0) || String(r.price ?? '').trim() === '') { res.errors.push(`${where} (${name}): price missing or not a number`); continue; }
    if (stock != null && !(stock >= 0)) { res.errors.push(`${where} (${name}): stock must be 0 or more`); continue; }
    const m = matchCategory(cats, r.cat);
    if (m.err || !m.cat) { res.errors.push(`${where} (${name}): ${m.err || 'category is empty'}`); continue; }
    if (seen.has(name.toLowerCase())) { res.errors.push(`${where} (${name}): appears twice — kept the first`); continue; }
    seen.add(name.toLowerCase());
    const ex = byName.get(name.toLowerCase());
    if (ex) {
      await db.q('update items set name=$2, cat=$3, price=$4, stock=$5 where id=$1', [ex.id, name, m.cat, price, stock == null ? ex.stock : stock]);
      res.updated.push(name);
    } else {
      await db.q('insert into items(shop_id,name,cat,price,stock) values($1,$2,$3,$4,$5)', [shop.id, name, m.cat, price, stock == null ? 0 : stock]);
      res.added.push(name);
    }
  }
  if (replace && !res.errors.length) {
    const gone = list.filter((i) => !seen.has(i.name.toLowerCase()));
    for (const g of gone) await db.q('delete from items where id=$1', [g.id]);
    res.removed = gone.length;
  }
  return res;
}

// "Name | Category | Price | Stock" lines (WhatsApp and the panel's paste box)
function parseLines(text) {
  return String(text || '').split(/\n|;/).map((x) => x.trim()).filter(Boolean).map((line) => {
    const p = line.split('|').map((x) => x.trim());
    return { name: p[0], cat: p[1], price: p[2], stock: p[3], row: null, raw: line };
  });
}

module.exports = { init, types, type, categories, setCategories, matchCategory, sortCats, importItems, parseLines, key };
