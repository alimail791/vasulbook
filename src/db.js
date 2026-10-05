const path = require("path");

// Two modes:
//  - DATABASE_URL set  -> real PostgreSQL server (Railway, production)
//  - DATABASE_URL empty -> built-in PostgreSQL (PGlite) stored in ./local-data, for testing on your computer
const url = process.env.DATABASE_URL;
let q;
let mode;

if (url) {
  const { Pool, types } = require("pg");
  // Return DATE columns as plain 'YYYY-MM-DD' strings and NUMERIC as numbers.
  types.setTypeParser(1082, (v) => v);
  types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
  const needsSsl = process.env.PGSSL === "true" || /sslmode=require/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 10),
  });
  q = (text, params) => pool.query(text, params);
  mode = "postgres";
} else {
  if (process.env.NODE_ENV === "production") {
    console.error("DATABASE_URL is not set. Add a PostgreSQL database and set DATABASE_URL.");
    process.exit(1);
  }
  const { PGlite, types } = require("@electric-sql/pglite");
  const dir = path.join(__dirname, "..", "local-data", "db");
  require("fs").mkdirSync(path.dirname(dir), { recursive: true });
  const db = new PGlite(dir, { parsers: { [types.DATE]: (v) => v, [types.NUMERIC]: (v) => (v === null ? null : Number(v)) } });
  // Run queries one at a time and return the same shape as node-postgres.
  let chain = Promise.resolve();
  q = (text, params) => {
    const run = chain.then(() => db.query(text, params || [])).then((r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }));
    chain = run.catch(() => {});
    return run;
  };
  mode = "local";
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     owner_name TEXT NOT NULL,
     shop_name TEXT NOT NULL,
     phone TEXT NOT NULL DEFAULT '',
     business_type TEXT NOT NULL DEFAULT 'retail',
     upi_id TEXT NOT NULL DEFAULT '',
     default_days INT NOT NULL DEFAULT 7,
     reminder_lang TEXT NOT NULL DEFAULT 'en',
     summary_email BOOLEAN NOT NULL DEFAULT TRUE,
     auto_remind BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS customers (
     id SERIAL PRIMARY KEY,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     phone TEXT NOT NULL DEFAULT '',
     last_reminder_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS customers_user_idx ON customers(user_id)`,
  `CREATE TABLE IF NOT EXISTS entries (
     id SERIAL PRIMARY KEY,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('credit','payment')),
     amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
     entry_date DATE NOT NULL,
     due_date DATE,
     note TEXT NOT NULL DEFAULT '',
     mode TEXT NOT NULL DEFAULT '',
     external_ref TEXT UNIQUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS entries_user_idx ON entries(user_id)`,
  `CREATE INDEX IF NOT EXISTS entries_customer_idx ON entries(customer_id)`,
  `CREATE TABLE IF NOT EXISTS password_resets (
     token_hash TEXT PRIMARY KEY,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     used BOOLEAN NOT NULL DEFAULT FALSE
   )`,
  `CREATE TABLE IF NOT EXISTS payment_links (
     id TEXT PRIMARY KEY,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
     amount NUMERIC(12,2) NOT NULL,
     short_url TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'created',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS rzp_key_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS rzp_key_secret TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS rzp_webhook_secret TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_summary_on DATE`,
  // Subscription: everyone starts with a free trial; existing accounts get theirs counted from sign-up.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_until TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_notice TEXT NOT NULL DEFAULT ''`,
  `UPDATE users SET trial_ends_at = created_at + interval '3 months' WHERE trial_ends_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS subscription_payments (
     order_id TEXT PRIMARY KEY,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     amount NUMERIC(12,2) NOT NULL,
     months INT NOT NULL,
     status TEXT NOT NULL DEFAULT 'created',
     payment_id TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     paid_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS subscription_payments_user_idx ON subscription_payments(user_id)`,
  // Email verification: accounts that existed before this feature count as verified; new ones start unverified.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS email_codes (
     id SERIAL PRIMARY KEY,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
     code_hash TEXT NOT NULL,
     attempts INT NOT NULL DEFAULT 0,
     used BOOLEAN NOT NULL DEFAULT FALSE,
     expires_at TIMESTAMPTZ NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS email_codes_user_idx ON email_codes(user_id, purpose)`,
  // Refer & earn
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INT REFERENCES users(id) ON DELETE SET NULL`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_popup_on DATE`,
  `UPDATE users SET referral_code = 'VB' || upper(substr(md5(id::text || random()::text), 1, 6)) WHERE referral_code IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_idx ON users(referral_code)`,
  `CREATE TABLE IF NOT EXISTS referral_rewards (
     referee_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     referrer_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     months INT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Activity, for "we miss you" emails
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS inactive_notice_at TIMESTAMPTZ`,
  `UPDATE users SET last_active_at = created_at WHERE last_active_at IS NULL`,
  // Languages and states
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_lang TEXT NOT NULL DEFAULT 'en'`,
  // Admin audit log
  `CREATE TABLE IF NOT EXISTS admin_actions (
     id SERIAL PRIMARY KEY,
     admin_email TEXT NOT NULL,
     user_id INT REFERENCES users(id) ON DELETE SET NULL,
     action TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

async function migrate() {
  for (const sql of MIGRATIONS) await q(sql);
}

module.exports = { q, migrate, mode };
