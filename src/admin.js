// VasulBook admin dashboard API. Separate login: ADMIN_EMAIL (one of the listed addresses) + ADMIN_PASSWORD.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const email = require("./email");
const categories = require("./categories");
const VBLang = require("../public/i18n/meta");
const { q } = require("./db");
const billing = require("./billing");

const COOKIE = "vb_admin";
const STATUS_SQL = {
  trial: "u.trial_ends_at > now() AND (u.paid_until IS NULL OR u.paid_until <= now())",
  paid: "u.paid_until > now()",
  expired: "GREATEST(COALESCE(u.trial_ends_at,'epoch'), COALESCE(u.paid_until,'epoch')) <= now()",
  unverified: "NOT u.email_verified",
  inactive: "u.last_active_at < now() - interval '5 days'",
};

module.exports = function mountAdmin(app, { wrap, bad, limit, PROD, secret }) {
  const admins = () => String(process.env.ADMIN_EMAIL || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let password = process.env.ADMIN_PASSWORD || "";
  if (!password && !PROD) {
    password = "admin12345";
    console.log("[local] admin login: any ADMIN_EMAIL address (or admin@localhost) / admin12345 at /admin");
  }
  // A password set through "Forgot password" is stored (hashed) in the database and replaces ADMIN_PASSWORD.
  let stored = null; // { hash, changedAt }
  async function loadStored() {
    try {
      const { rows } = await q("SELECT value, updated_at FROM admin_settings WHERE key='password_hash'");
      stored = rows[0] ? { hash: rows[0].value, changedAt: new Date(rows[0].updated_at).getTime() } : null;
    } catch { /* table appears after first migration */ }
    return stored;
  }
  setTimeout(loadStored, 1500);
  const enabled = () => Boolean(stored || (password && password.length >= 10));
  const allowedEmails = () => (admins().length ? admins() : (!PROD ? ["admin@localhost"] : []));

  const safeEq = (a, b) => {
    const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };
  async function passwordOk(pw) {
    await loadStored();
    if (stored) return bcrypt.compare(String(pw), stored.hash);
    return safeEq(String(pw), password);
  }
  function signIn(res, e) {
    const token = jwt.sign({ admin: true, email: e }, secret, { expiresIn: "12h" });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: PROD, maxAge: 12 * 3600e3, path: "/" });
  }

  function adminAuth(req, res, next) {
    try {
      const t = jwt.verify(req.cookies[COOKIE] || "", secret);
      if (!t.admin) throw new Error();
      // Sessions started before a password reset stop working.
      if (stored && t.iat * 1000 < stored.changedAt - 1000) throw new Error();
      req.admin = t.email; next();
    } catch { return bad(res, "Please log in as admin.", 401); }
  }

  app.post("/api/admin/login", limit(6, 15 * 60e3), wrap(async (req, res) => {
    if (!enabled()) await loadStored();
    if (!enabled()) return bad(res, "Admin login is not set up. Set ADMIN_PASSWORD (10+ characters) on the server.", 503);
    const e = String(req.body.email || "").trim().toLowerCase();
    const ok = allowedEmails().includes(e) && (await passwordOk(req.body.password || ""));
    if (!ok) return bad(res, "Email or password is wrong.", 401);
    signIn(res, e);
    console.log(`[admin] login ${e}`);
    res.json({ ok: true, email: e });
  }));

  // Forgot password: a 6-digit code goes to the admin email; it sets a new password.
  const codeHash = (e, code) => crypto.createHmac("sha256", String(secret)).update(`admin:${e}:${code}`).digest("hex");
  app.post("/api/admin/forgot", limit(5, 15 * 60e3), wrap(async (req, res) => {
    const e = String(req.body.email || "").trim().toLowerCase();
    if (!email.configured()) return bad(res, "Email sending is not set up on the server yet (RESEND_API_KEY), so a code can't be sent. Change ADMIN_PASSWORD in Railway instead.", 503);
    if (allowedEmails().includes(e)) {
      const { rows } = await q("SELECT created_at FROM admin_codes WHERE email=$1 ORDER BY created_at DESC LIMIT 1", [e]);
      if (rows[0] && Date.now() - new Date(rows[0].created_at).getTime() < 60e3) return bad(res, "Please wait a minute before asking for a new code.", 429);
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
      await q("UPDATE admin_codes SET used=TRUE WHERE email=$1 AND NOT used", [e]);
      await q("INSERT INTO admin_codes (email, code_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')", [e, codeHash(e, code)]);
      await email.send({
        to: e, subject: `${code} is your VasulBook admin reset code`,
        html: email.layout("Reset your admin password", `
          <p>Someone asked to reset the VasulBook <b>admin</b> password. If it was you, enter this code on the admin login page:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:8px;font-family:Consolas,Menlo,monospace;margin:16px 0">${code}</p>
          <p style="font-size:13px;color:#56665F">The code works for 10 minutes. If you didn't ask for this, ignore this email; the password stays the same.</p>`),
        text: `VasulBook admin reset code: ${code} (valid 10 minutes).`,
      });
      console.log(`[admin] reset code sent to ${e}`);
    }
    // Same answer either way, so the page doesn't reveal which emails are admins.
    res.json({ ok: true });
  }));

  app.post("/api/admin/reset", limit(8, 15 * 60e3), wrap(async (req, res) => {
    const e = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").replace(/\D/g, "");
    const pw = String(req.body.password || "");
    if (pw.length < 10) return bad(res, "Use at least 10 characters for the admin password.");
    const { rows } = await q("SELECT * FROM admin_codes WHERE email=$1 AND NOT used AND expires_at > now() ORDER BY created_at DESC LIMIT 1", [e]);
    const row = rows[0];
    if (!row || !allowedEmails().includes(e)) return bad(res, "This code has expired. Ask for a new code.");
    if (row.attempts >= 5) return bad(res, "Too many wrong tries. Ask for a new code.");
    const a = Buffer.from(codeHash(e, code)), b = Buffer.from(row.code_hash);
    if (code.length !== 6 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await q("UPDATE admin_codes SET attempts = attempts + 1 WHERE id=$1", [row.id]);
      return bad(res, "That code is wrong.");
    }
    await q("UPDATE admin_codes SET used=TRUE WHERE email=$1", [e]);
    const hash = await bcrypt.hash(pw, 10);
    await q(`INSERT INTO admin_settings (key, value, updated_at) VALUES ('password_hash', $1, now())
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [hash]);
    await loadStored();
    await logAction(e, null, "admin_password_reset", "via email code").catch(() => {});
    await new Promise((r) => setTimeout(r, 1100)); // new session must be issued after the change time
    signIn(res, e);
    console.log(`[admin] password reset by ${e}`);
    res.json({ ok: true, email: e });
  }));

  app.post("/api/admin/logout", (req, res) => { res.clearCookie(COOKIE, { path: "/" }); res.json({ ok: true }); });
  app.get("/api/admin/me", adminAuth, (req, res) => res.json({ email: req.admin }));

  app.get("/api/admin/stats", adminAuth, wrap(async (req, res) => {
    const IST = "Asia/Kolkata";
    const [k, rev, days, types, states, langs, refs] = await Promise.all([
      q(`SELECT count(*)::int AS total,
           count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS new1,
           count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new7,
           count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new30,
           count(*) FILTER (WHERE email_verified)::int AS verified,
           count(*) FILTER (WHERE ${STATUS_SQL.trial.replace(/u\./g, "")})::int AS trial,
           count(*) FILTER (WHERE ${STATUS_SQL.paid.replace(/u\./g, "")})::int AS paid,
           count(*) FILTER (WHERE ${STATUS_SQL.expired.replace(/u\./g, "")})::int AS expired,
           count(*) FILTER (WHERE last_active_at > now() - interval '7 days')::int AS active7,
           count(*) FILTER (WHERE trial_ends_at BETWEEN now() AND now() + interval '7 days' AND (paid_until IS NULL OR paid_until <= now()))::int AS trial_ending
         FROM users`),
      q(`SELECT COALESCE(sum(amount),0)::float AS total, count(*)::int AS orders,
           COALESCE(sum(amount) FILTER (WHERE paid_at >= date_trunc('month', now() AT TIME ZONE '${IST}') AT TIME ZONE '${IST}'),0)::float AS month,
           count(*) FILTER (WHERE paid_at >= date_trunc('month', now() AT TIME ZONE '${IST}') AT TIME ZONE '${IST}')::int AS month_orders
         FROM subscription_payments WHERE status='paid'`),
      q(`SELECT to_char(created_at AT TIME ZONE '${IST}', 'YYYY-MM-DD') AS d, count(*)::int AS n
         FROM users WHERE created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`),
      q("SELECT business_type AS k, count(*)::int AS n FROM users GROUP BY 1 ORDER BY 2 DESC"),
      q("SELECT COALESCE(NULLIF(state,''),'Not given') AS k, count(*)::int AS n FROM users GROUP BY 1 ORDER BY 2 DESC LIMIT 15"),
      q("SELECT ui_lang AS k, count(*)::int AS n FROM users GROUP BY 1 ORDER BY 2 DESC"),
      q("SELECT count(*)::int AS referred, (SELECT count(*)::int FROM referral_rewards) AS rewarded FROM users WHERE referred_by IS NOT NULL"),
    ]);
    // fill missing days with 0 so the chart has 30 even bars
    const map = new Map(days.rows.map((r) => [r.d, r.n]));
    const series = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() + 5.5 * 3600e3 - i * 864e5).toISOString().slice(0, 10);
      series.push({ d, n: map.get(d) || 0 });
    }
    res.json({ kpi: k.rows[0], revenue: rev.rows[0], signups: series, byType: types.rows, byState: states.rows, byLang: langs.rows, referrals: refs.rows[0], plan: billing.PLAN });
  }));

  function listQuery(query, { limitRows = 50, offset = 0 } = {}) {
    const where = [], params = [];
    const s = String(query.q || "").trim();
    if (s) {
      params.push(`%${s.toLowerCase()}%`);
      where.push(`(lower(u.email) LIKE $${params.length} OR lower(u.shop_name) LIKE $${params.length} OR lower(u.owner_name) LIKE $${params.length} OR u.phone LIKE $${params.length} OR lower(u.referral_code) LIKE $${params.length})`);
    }
    if (STATUS_SQL[query.status]) where.push(STATUS_SQL[query.status]);
    const sql = `SELECT u.id, u.email, u.owner_name, u.shop_name, u.phone, u.business_type, u.state, u.ui_lang, u.email_verified,
        u.created_at, u.last_active_at, u.trial_ends_at, u.paid_until, u.referral_code,
        ref.shop_name AS referrer_shop,
        (SELECT count(*) FROM customers c WHERE c.user_id=u.id)::int AS customers,
        (SELECT count(*) FROM entries e WHERE e.user_id=u.id)::int AS entries,
        (SELECT count(*) FROM users r WHERE r.referred_by=u.id)::int AS referrals,
        (SELECT COALESCE(sum(amount),0) FROM subscription_payments p WHERE p.user_id=u.id AND p.status='paid')::float AS paid_total,
        count(*) OVER()::int AS total_count
      FROM users u LEFT JOIN users ref ON ref.id = u.referred_by
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY u.created_at DESC LIMIT ${Number(limitRows)} OFFSET ${Number(offset)}`;
    return q(sql, params);
  }
  const shape = (r) => ({ ...r, plan: billing.status(r) });

  app.get("/api/admin/users", adminAuth, wrap(async (req, res) => {
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const { rows } = await listQuery(req.query, { limitRows: 50, offset: page * 50 });
    res.json({ users: rows.map(shape), total: rows[0] ? rows[0].total_count : 0, page });
  }));

  app.get("/api/admin/users.csv", adminAuth, wrap(async (req, res) => {
    const { rows } = await listQuery(req.query, { limitRows: 10000 });
    const cols = ["id", "shop_name", "owner_name", "email", "phone", "business_type", "state", "ui_lang", "email_verified", "created_at", "last_active_at", "plan_state", "access_until", "customers", "entries", "referrals", "paid_total", "referrer_shop"];
    const cell = (v) => { const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
    const lines = [cols.join(",")].concat(rows.map((r) => { const p = billing.status(r); return cols.map((c) => cell(c === "plan_state" ? p.state : c === "access_until" ? p.accessUntil : r[c])).join(","); }));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="vasulbook-users-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + lines.join("\n"));
  }));

  app.get("/api/admin/users/:id", adminAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const [u, pays, refs, acts] = await Promise.all([
      q(`SELECT u.*, ref.shop_name AS referrer_shop FROM users u LEFT JOIN users ref ON ref.id=u.referred_by WHERE u.id=$1`, [id]),
      q("SELECT order_id, payment_id, amount, months, status, created_at, paid_at FROM subscription_payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [id]),
      q(`SELECT r.shop_name, r.created_at, rr.months FROM users r LEFT JOIN referral_rewards rr ON rr.referee_id=r.id WHERE r.referred_by=$1 ORDER BY r.created_at DESC`, [id]),
      q("SELECT action, detail, admin_email, created_at FROM admin_actions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20", [id]),
    ]);
    const x = u.rows[0];
    if (!x) return bad(res, "Not found.", 404);
    const counts = await q(`SELECT (SELECT count(*) FROM customers WHERE user_id=$1)::int AS customers, (SELECT count(*) FROM entries WHERE user_id=$1)::int AS entries`, [id]);
    const safe = { id: x.id, email: x.email, owner_name: x.owner_name, shop_name: x.shop_name, phone: x.phone, business_type: x.business_type, state: x.state, ui_lang: x.ui_lang,
      email_verified: x.email_verified, created_at: x.created_at, last_active_at: x.last_active_at, referral_code: x.referral_code, referrer_shop: x.referrer_shop,
      upi_set: Boolean(x.upi_id), razorpay_connected: Boolean(x.rzp_key_id), ...counts.rows[0], plan: billing.status(x) };
    res.json({ user: safe, payments: pays.rows, referrals: refs.rows, actions: acts.rows });
  }));

  // ---------- business categories ----------
  function cleanNames(obj) {
    const out = {};
    for (const c of VBLang.CODES) {
      const v = String((obj || {})[c] || "").trim().replace(/\s+/g, " ").slice(0, 80);
      if (v) out[c] = v;
    }
    return out;
  }
  app.get("/api/admin/categories", adminAuth, wrap(async (req, res) => {
    const { rows } = await q(`SELECT c.key, c.name_en, c.names, c.noun, c.builtin, c.active, c.sort,
        (SELECT count(*)::int FROM users u WHERE u.business_type = c.key) AS users
      FROM business_categories c ORDER BY c.sort, c.id`);
    res.json({ categories: rows.map((r) => ({ ...r, names: typeof r.names === "string" ? JSON.parse(r.names) : r.names })), nouns: categories.NOUNS, langs: VBLang.LANGS });
  }));
  app.post("/api/admin/categories", adminAuth, wrap(async (req, res) => {
    const name = String(req.body.name_en || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (name.length < 2) return bad(res, "Enter the category name in English.");
    const noun = categories.NOUNS.includes(req.body.noun) ? req.body.noun : "customer";
    let key = categories.slug(name) || "category";
    if (await categories.exists(key)) {
      const { rows } = await q("SELECT 1 FROM business_categories WHERE lower(name_en)=lower($1)", [name]);
      if (rows[0]) return bad(res, "A category with this name already exists.");
      key = `${key.slice(0, 24)}_${Date.now().toString(36).slice(-5)}`;
    }
    const { rows: m } = await q("SELECT COALESCE(max(sort),0)+10 AS s FROM business_categories");
    await q("INSERT INTO business_categories (key, name_en, names, noun, sort) VALUES ($1,$2,$3::jsonb,$4,$5)",
      [key, name, JSON.stringify(cleanNames(req.body.names)), noun, m[0].s]);
    await categories.load();
    await logAction(req.admin, null, "category_add", `${key}: ${name}`);
    res.json({ ok: true, key });
  }));
  app.put("/api/admin/categories/:key", adminAuth, wrap(async (req, res) => {
    const key = String(req.params.key);
    const { rows } = await q("SELECT * FROM business_categories WHERE key=$1", [key]);
    const c = rows[0];
    if (!c) return bad(res, "Category not found.", 404);
    const b = req.body || {};
    const name = b.name_en !== undefined ? String(b.name_en).trim().replace(/\s+/g, " ").slice(0, 80) : c.name_en;
    if (name.length < 2) return bad(res, "Enter the category name in English.");
    const noun = categories.NOUNS.includes(b.noun) ? b.noun : c.noun;
    const active = typeof b.active === "boolean" ? b.active : c.active;
    const names = b.names !== undefined ? JSON.stringify(cleanNames(b.names)) : JSON.stringify(typeof c.names === "string" ? JSON.parse(c.names) : c.names);
    if (!active) {
      const left = (await categories.active()).filter((x) => x.key !== key).length;
      if (left < 1) return bad(res, "Keep at least one category visible.");
    }
    await q("UPDATE business_categories SET name_en=$2, names=$3::jsonb, noun=$4, active=$5 WHERE key=$1", [key, name, names, noun, active]);
    await categories.load();
    await logAction(req.admin, null, "category_edit", `${key}: ${name}${active ? "" : " (hidden)"}`);
    res.json({ ok: true });
  }));
  app.post("/api/admin/categories/order", adminAuth, wrap(async (req, res) => {
    const keys = Array.isArray(req.body.keys) ? req.body.keys.map(String).slice(0, 200) : [];
    let i = 0;
    for (const k of keys) await q("UPDATE business_categories SET sort=$2 WHERE key=$1", [k, (i += 10)]);
    await categories.load();
    res.json({ ok: true });
  }));

  async function logAction(adminEmail, userId, action, detail) {
    await q("INSERT INTO admin_actions (admin_email, user_id, action, detail) VALUES ($1,$2,$3,$4)", [adminEmail, userId, action, detail]);
  }

  app.post("/api/admin/users/:id/extend", adminAuth, wrap(async (req, res) => {
    const months = parseInt(req.body.months, 10);
    if (!(months >= 1 && months <= 36)) return bad(res, "Choose 1 to 36 months.");
    const { rows } = await q(
      `UPDATE users SET paid_until = GREATEST(now(), COALESCE(trial_ends_at, now()), COALESCE(paid_until, now())) + make_interval(months => $2)
       WHERE id=$1 RETURNING *`, [Number(req.params.id), months]);
    if (!rows[0]) return bad(res, "Not found.", 404);
    await logAction(req.admin, rows[0].id, "gift_months", `${months} months${req.body.note ? ": " + String(req.body.note).slice(0, 200) : ""}`);
    res.json({ plan: billing.status(rows[0]) });
  }));

  app.post("/api/admin/users/:id/verify", adminAuth, wrap(async (req, res) => {
    const { rows } = await q("UPDATE users SET email_verified=TRUE WHERE id=$1 RETURNING id", [Number(req.params.id)]);
    if (!rows[0]) return bad(res, "Not found.", 404);
    await logAction(req.admin, rows[0].id, "verify_email", "");
    res.json({ ok: true });
  }));

  app.get("/api/admin/payments", adminAuth, wrap(async (req, res) => {
    const { rows } = await q(`SELECT p.order_id, p.payment_id, p.amount, p.months, p.status, p.created_at, p.paid_at, u.shop_name, u.email, u.id AS user_id
      FROM subscription_payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 100`);
    res.json({ payments: rows });
  }));
};
