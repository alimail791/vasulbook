// One-time 6-digit email codes for verifying an email address and resetting a password.
const crypto = require("crypto");
const { q } = require("./db");

const TTL_MIN = 10;          // a code works for 10 minutes
const MAX_ATTEMPTS = 5;      // then a new code is needed
const RESEND_AFTER_S = 60;   // wait between codes

const hash = (userId, purpose, code) =>
  crypto.createHmac("sha256", String(process.env.SESSION_SECRET)).update(`${userId}:${purpose}:${code}`).digest("hex");

function fail(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

async function create(userId, purpose) {
  const { rows } = await q(
    "SELECT created_at FROM email_codes WHERE user_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1", [userId, purpose]);
  if (rows[0]) {
    const wait = RESEND_AFTER_S - Math.floor((Date.now() - new Date(rows[0].created_at).getTime()) / 1000);
    if (wait > 0) throw fail(`Please wait ${wait} seconds before asking for a new code.`, 429);
  }
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  await q("UPDATE email_codes SET used=TRUE WHERE user_id=$1 AND purpose=$2 AND NOT used", [userId, purpose]);
  await q(
    `INSERT INTO email_codes (user_id, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
    [userId, purpose, hash(userId, purpose, code), TTL_MIN]);
  return code;
}

async function check(userId, purpose, code) {
  const clean = String(code || "").replace(/\D/g, "");
  const { rows } = await q(
    `SELECT * FROM email_codes WHERE user_id=$1 AND purpose=$2 AND NOT used AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose]);
  const row = rows[0];
  if (!row) throw fail("This code has expired. Tap \"Send a new code\".");
  if (row.attempts >= MAX_ATTEMPTS) throw fail("Too many wrong tries. Tap \"Send a new code\".");
  const a = Buffer.from(hash(userId, purpose, clean)), b = Buffer.from(row.code_hash);
  if (clean.length !== 6 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await q("UPDATE email_codes SET attempts = attempts + 1 WHERE id=$1", [row.id]);
    const left = MAX_ATTEMPTS - row.attempts - 1;
    throw fail(left > 0 ? `That code is wrong. ${left} tr${left === 1 ? "y" : "ies"} left.` : "Too many wrong tries. Tap \"Send a new code\".");
  }
  await q("UPDATE email_codes SET used=TRUE WHERE id=$1", [row.id]);
  return true;
}

module.exports = { create, check, TTL_MIN };
