// VasulBook admin dashboard API. Separate login: ADMIN_EMAIL (one of the listed addresses) + ADMIN_PASSWORD.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
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
  const enabled = () => Boolean(password && password.length >= 10);

  const safeEq = (a, b) => {
    const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  };

  function adminAuth(req, res, next) {
    try {
      const t = jwt.verify(req.cookies[COOKIE] || "", secret);
      if (!t.admin) throw new Error();
      req.admin = t.email; next();
    } catch { return bad(res, "Please log in as admin.", 401); }
  }

  app.post("/api/admin/login", limit(6, 15 * 60e3), (req, res) => {
    if (!enabled()) return bad(res, "Admin login is not set up. Set ADMIN_PASSWORD (10+ characters) on the server.", 503);
    const e = String(req.body.email || "").trim().toLowerCase();
    const allowed = admins().length ? admins() : (!PROD ? ["admin@localhost"] : []);
    const ok = allowed.includes(e) && safeEq(String(req.body.password || ""), password);
    if (!ok) return bad(res, "Email or password is wrong.", 401);
    const token = jwt.sign({ admin: true, email: e }, secret, { expiresIn: "12h" });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: PROD, maxAge: 12 * 3600e3, path: "/" });
    console.log(`[admin] login ${e}`);
    res.json({ ok: true, email: e });
  });
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
