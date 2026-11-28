/* Raise network link: lets ClassCoach (classcoach.in) — and later TestMandi — use VasulBook for fee
   collection without the teacher signing up twice.

   What a partner app can do (server-to-server only, header X-Network-Key = NETWORK_API_KEY, 24+ chars):
     POST /api/partner/account     find or create the VasulBook account for a verified email
     POST /api/partner/customers   add/update students (as customers) by the partner's own id ("ref")
     POST /api/partner/charges     add a fee due for many students at once (safe to repeat: same key = no duplicate)
     GET  /api/partner/balances    each linked student's balance, status and oldest due date
     POST /api/partner/login-link  one-time link that logs the teacher into vasulbook.com/app (valid 2 minutes)
   Browser:
     GET  /sso?t=...               uses that link, sets the normal login cookie, opens the app

   Only emails the partner has already verified are accepted, so a VasulBook account is never
   opened or entered on someone else's behalf. Without NETWORK_API_KEY all of this is switched off. */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { q } = require("./db");
const Ledger = require("../public/ledger");
const billing = require("./billing");
const email = require("./email");

const SOURCES = new Set(["classcoach", "testmandi", "yneet"]);
const clean = (s, max = 200) => String(s ?? "").trim().slice(0, max);
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const refOk = (s) => /^[\w:.-]{1,80}$/.test(s);

module.exports = function mountPartnerApi(app, { wrap, bad, setSession, secret, appUrl, newReferralCode }) {
  const key = () => process.env.NETWORK_API_KEY || "";
  function networkAuth(req, res, next) {
    const k = key(), got = String(req.get("x-network-key") || "");
    if (k.length < 24) return bad(res, "Partner link is not set up.", 503);
    const a = crypto.createHash("sha256").update(got).digest(), b = crypto.createHash("sha256").update(k).digest();
    if (!crypto.timingSafeEqual(a, b)) return bad(res, "Not allowed.", 401);
    const src = clean(req.get("x-network-source"), 20).toLowerCase();
    req.partner = SOURCES.has(src) ? src : "partner";
    next();
  }

  async function userByEmail(e) {
    const { rows } = await q("SELECT * FROM users WHERE email=$1", [clean(e, 200).toLowerCase()]);
    return rows[0] || null;
  }
  async function needUser(req, res) {
    const u = await userByEmail(req.body?.email ?? req.query.email);
    if (!u) { bad(res, "No VasulBook account for this email yet. Link it first.", 404); return null; }
    return u;
  }
  const extRef = (src, userId, ref) => `${src}:${userId}:${ref}`;

  // ---- account ----
  app.post("/api/partner/account", networkAuth, wrap(async (req, res) => {
    const b = req.body || {};
    const e = clean(b.email, 200).toLowerCase();
    if (!isEmail(e)) return bad(res, "Valid email needed.");
    if (b.emailVerified !== true) return bad(res, "Verify this email on your site first.", 403);
    let u = await userByEmail(e);
    let created = false;
    if (!u) {
      const ownerName = clean(b.name, 100) || e.split("@")[0];
      const shopName = clean(b.business, 120) || `${ownerName} Tuition`;
      const phone = digits(b.phone).slice(-10);
      const type = clean(b.businessType, 40) || "tuition";
      const hash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10); // they log in via the partner link, or "Forgot password"
      for (let i = 0; i < 4 && !u; i++) {
        try {
          const { rows } = await q(
            `INSERT INTO users (email, password_hash, owner_name, shop_name, phone, business_type, trial_ends_at, email_verified, referral_code, last_active_at, signup_source)
             VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(months => $7), TRUE, $8, now(), $9) RETURNING *`,
            [e, hash, ownerName, shopName, phone.length === 10 ? phone : "", type, billing.PLAN.trialMonths, newReferralCode(), req.partner]);
          u = rows[0];
          created = true;
        } catch (err) {
          if (err.code === "23505" && String(err.message).includes("email")) { u = await userByEmail(e); break; }
          if (err.code !== "23505" || i === 3) throw err;
        }
      }
      if (created) {
        console.log(`[partner] ${req.partner} opened VasulBook account #${u.id} for ${e}`);
        email.registrationEmails(u, appUrl(req)).catch((err) => console.error("[partner welcome]", err.message));
      }
    }
    const plan = billing.status(u);
    res.json({ created, user: { id: u.id, name: u.owner_name, shop: u.shop_name, plan: { state: plan.state, active: plan.active } } });
  }));

  // ---- students as customers ----
  app.post("/api/partner/customers", networkAuth, wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    const list = Array.isArray(req.body.customers) ? req.body.customers.slice(0, 2000) : [];
    if (!list.length) return bad(res, "No customers sent.");
    let added = 0, updated = 0;
    for (const c of list) {
      const ref = clean(c.ref, 80), name = clean(c.name, 120), phone = digits(c.phone).slice(-10);
      if (!refOk(ref) || !name) continue;
      const er = extRef(req.partner, u.id, ref);
      const r = await q("UPDATE customers SET name=$1, phone=$2 WHERE user_id=$3 AND external_ref=$4 RETURNING id", [name, phone.length === 10 ? phone : "", u.id, er]);
      if (r.rowCount) { updated++; continue; }
      await q("INSERT INTO customers (user_id, name, phone, external_ref) VALUES ($1,$2,$3,$4)", [u.id, name, phone.length === 10 ? phone : "", er]);
      added++;
    }
    res.json({ ok: true, added, updated });
  }));

  // ---- fee dues ----
  // charges: [{ ref (student), amount }], key: unique per fee run (e.g. "fee-2026-12-batch5"); repeating the same key adds nothing twice.
  app.post("/api/partner/charges", networkAuth, wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    if (!billing.status(u).active) return bad(res, "This VasulBook plan has ended. Renew on vasulbook.com to add new dues.", 402);
    const b = req.body || {};
    const runKey = clean(b.key, 60);
    if (!refOk(runKey)) return bad(res, "A key for this fee run is needed.");
    const note = clean(b.note, 300) || "Fees";
    const today = Ledger.todayIST();
    const due = isDate(b.due) ? b.due : Ledger.addDays(today, u.default_days);
    const list = Array.isArray(b.charges) ? b.charges.slice(0, 2000) : [];
    let added = 0, skipped = 0, missing = 0;
    for (const ch of list) {
      const ref = clean(ch.ref, 80);
      const amount = Math.round(Number(ch.amount) * 100) / 100;
      if (!refOk(ref) || !(amount > 0) || amount > 1e7) { skipped++; continue; }
      const { rows } = await q("SELECT id FROM customers WHERE user_id=$1 AND external_ref=$2", [u.id, extRef(req.partner, u.id, ref)]);
      if (!rows[0]) { missing++; continue; }
      const r = await q(
        `INSERT INTO entries (user_id, customer_id, kind, amount, entry_date, due_date, note, external_ref)
         VALUES ($1,$2,'credit',$3,$4,$5,$6,$7) ON CONFLICT (external_ref) DO NOTHING`,
        [u.id, rows[0].id, amount, today, due, note, `${extRef(req.partner, u.id, ref)}:${runKey}`]);
      if (r.rowCount) added++; else skipped++;
    }
    res.json({ ok: true, added, skipped, missing });
  }));

  // ---- balances ----
  app.get("/api/partner/balances", networkAuth, wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    const prefix = `${req.partner}:${u.id}:`;
    const [c, e] = await Promise.all([
      q("SELECT id, name, phone, external_ref FROM customers WHERE user_id=$1 AND external_ref LIKE $2", [u.id, prefix + "%"]),
      q(`SELECT e.* FROM entries e JOIN customers c ON c.id=e.customer_id WHERE e.user_id=$1 AND c.external_ref LIKE $2`, [u.id, prefix + "%"]),
    ]);
    const byCust = new Map();
    for (const r of e.rows) {
      const list = byCust.get(r.customer_id) || [];
      list.push({ kind: r.kind, amount: r.amount, date: r.entry_date, due: r.due_date, createdAt: new Date(r.created_at).getTime() });
      byCust.set(r.customer_id, list);
    }
    let due = 0, overdue = 0, collected = 0;
    const students = c.rows.map((row) => {
      const entries = byCust.get(row.id) || [];
      const L = Ledger.compute(entries);
      due += Math.max(0, L.bal);
      overdue += L.overdueAmt || 0;
      collected += entries.filter((x) => x.kind === "payment").reduce((s, x) => s + Number(x.amount), 0);
      return { ref: row.external_ref.slice(prefix.length), name: row.name, balance: L.bal, status: L.status, overdue: L.overdueAmt || 0, oldestDue: L.oldestDue || null };
    });
    const plan = billing.status(u);
    res.json({ students, totals: { due, overdue, collected }, plan: { state: plan.state, active: plan.active } });
  }));

  // ---- one-time login link ----
  const used = new Map(); // jti -> expiry (ms); links live 2 minutes, so memory is enough
  setInterval(() => { const now = Date.now(); for (const [k, t] of used) if (t < now) used.delete(k); }, 60e3).unref();

  app.post("/api/partner/login-link", networkAuth, wrap(async (req, res) => {
    const u = await needUser(req, res); if (!u) return;
    const next = /^\/app(\/[\w\-/]*)?$/.test(String(req.body.next || "")) ? req.body.next : "/app";
    const t = jwt.sign({ sso: u.id, next, src: req.partner }, secret, { expiresIn: "2m", jwtid: crypto.randomBytes(12).toString("hex") });
    res.json({ url: `${appUrl(req).replace(/\/+$/, "")}/sso?t=${encodeURIComponent(t)}` });
  }));

  app.get("/sso", wrap(async (req, res) => {
    let p;
    try { p = jwt.verify(String(req.query.t || ""), secret); } catch { return res.redirect("/app"); }
    if (!p.sso || !p.jti || used.has(p.jti)) return res.redirect("/app");
    used.set(p.jti, (p.exp || 0) * 1000 + 1000);
    const { rows } = await q("SELECT id FROM users WHERE id=$1", [p.sso]);
    if (!rows[0]) return res.redirect("/app");
    setSession(res, rows[0].id);
    res.redirect(p.next || "/app");
  }));
};
