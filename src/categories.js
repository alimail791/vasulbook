/* Business categories shown at sign-up. Seven are built in (translated in public/i18n);
   the admin can add more, rename them per language and hide any of them. */
const { q } = require("./db");

const NOUNS = ["customer", "student", "household", "shop", "tenant", "client"];
const BUILTIN = [
  { key: "retail", name_en: "Retail shop (kirana, medical, hardware)", noun: "customer" },
  { key: "tuition", name_en: "Tuition or coaching centre", noun: "student" },
  { key: "delivery", name_en: "Daily delivery (milk, water, paper)", noun: "household" },
  { key: "services", name_en: "Services (tailor, repair, salon)", noun: "customer" },
  { key: "wholesale", name_en: "Wholesale or distribution", noun: "shop" },
  { key: "rental", name_en: "Rent, hostel or membership", noun: "tenant" },
  { key: "clinic", name_en: "Clinic or professional", noun: "client" },
];

let cache = null;

async function seed() {
  let i = 0;
  for (const b of BUILTIN) {
    await q(`INSERT INTO business_categories (key, name_en, noun, builtin, sort) VALUES ($1,$2,$3,TRUE,$4)
             ON CONFLICT (key) DO NOTHING`, [b.key, b.name_en, b.noun, (i += 10)]);
  }
}

async function load() {
  const { rows } = await q("SELECT key, name_en, names, noun, builtin, active, sort FROM business_categories ORDER BY sort, id");
  cache = rows.map((r) => ({ ...r, names: typeof r.names === "string" ? JSON.parse(r.names || "{}") : (r.names || {}) }));
  return cache;
}
async function all() { return cache || load(); }
async function active() { return (await all()).filter((c) => c.active); }
async function isActive(key) { return (await active()).some((c) => c.key === key); }
async function exists(key) { return (await all()).some((c) => c.key === key); }
function labelSync(key) { const c = (cache || []).find((x) => x.key === key); return c ? c.name_en : key; }

// What the app needs: key, names, which word to use for "customers", built-in or not.
async function publicList() {
  return (await active()).map((c) => ({ key: c.key, name: c.name_en, names: c.names, noun: c.noun, builtin: c.builtin }));
}

const slug = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);

module.exports = { NOUNS, BUILTIN, seed, load, all, active, isActive, exists, labelSync, publicList, slug };
