require("./src/env");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { q, migrate } = require("./src/db");
const email = require("./src/email");
const ix = require("./src/integrations");
const Ledger = require("./public/ledger");
const jobs = require("./src/jobs");
const billing = require("./src/billing");
const otp = require("./src/otp");

const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === "production";
if (!PROD && !process.env.SESSION_SECRET) {
  // Local testing: make and keep a random secret so logins survive restarts.
  const fs = require("fs");
  const f = path.join(__dirname, "local-data", "session-secret.txt");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"));
  process.env.SESSION_SECRET = fs.readFileSync(f, "utf8").trim();
}
const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  process.exit(1);
}
const COOKIE = "vb_session";
const BTYPES = ["retail", "tuition", "delivery", "services", "wholesale", "rental", "clinic"];
const LANGS = ["en", "ta", "hi"];

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=()");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https://*.razorpay.com; connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com; " +
    "frame-src https://api.razorpay.com https://checkout.razorpay.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://api.razorpay.com");
  if (PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});

// Razorpay webhooks need the raw body for signature checks, so mount before express.json().
app.post("/api/webhooks/razorpay/:userId", express.raw({ type: "*/*", limit: "1mb" }), wrap(async (req, res) => {
  const userId = Number(req.params.userId);
  const { rows } = await q("SELECT id, rzp_webhook_secret FROM users WHERE id=$1", [userId]);
  const u = rows[0];
  const secret = u && ix.decrypt(u.rzp_webhook_secret);
  if (!u || !ix.verifyRazorpaySignature(req.body, req.get("x-razorpay-signature"), secret)) return res.status(400).json({ error: "Invalid signature" });
  const evt = JSON.parse(req.body.toString("utf8"));
  if (evt.event === "payment_link.paid") {
    const link = evt.payload.payment_link.entity;
    const pay = evt.payload.payment && evt.payload.payment.entity;
    const { rows: lr } = await q("SELECT * FROM payment_links WHERE id=$1 AND user_id=$2", [link.id, userId]);
    if (lr[0]) {
      const amount = (pay ? pay.amount : link.amount_paid) / 100;
      await q(`INSERT INTO entries (user_id, customer_id, kind, amount, entry_date, mode, note, external_ref)
               VALUES ($1,$2,'payment',$3,$4,'UPI (Razorpay)','Paid online',$5) ON CONFLICT (external_ref) DO NOTHING`,
        [userId, lr[0].customer_id, amount, Ledger.todayIST(), pay ? pay.id : link.id]);
      await q("UPDATE payment_links SET status='paid' WHERE id=$1", [link.id]);
    }
  }
  res.json({ ok: true });
}));

// Razorpay webhook for VasulBook plan purchases (the platform's own Razorpay account).
// Backup for the in-app confirmation: if the phone closes mid-payment, this still activates the plan.
app.post("/api/webhooks/razorpay-billing", express.raw({ type: "*/*", limit: "1mb" }), wrap(async (req, res) => {
  if (!billing.webhookSignatureOk(req.body, req.get("x-razorpay-signature"))) return res.status(400).json({ error: "Invalid signature" });
  const evt = JSON.parse(req.body.toString("utf8"));
  const pay = evt.payload && evt.payload.payment && evt.payload.payment.entity;
  const orderId = (evt.payload && evt.payload.order && evt.payload.order.entity.id) || (pay && pay.order_id);
  if ((evt.event === "order.paid" || evt.event === "payment.captured") && orderId && pay) {
    const done = await billing.applyPayment(orderId, pay.id);
    if (done) {
      console.log(`[billing] webhook activated plan for user #${done.user.id}`);
      email.planPurchaseEmails(done.user, done.payment, process.env.APP_URL || "").catch((e) => console.error("[plan email]", e));
      notifyReward(done.reward, process.env.APP_URL || "");
    }
  }
  res.json({ ok: true });
}));

app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

// Reject cross-site form posts: POST/PUT/PATCH must be JSON (HTML forms can't send JSON or DELETE).
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ error: "Send JSON." });
  }
  next();
});

// ---------- helpers ----------
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function bad(res, msg, code = 400) { return res.status(code).json({ error: msg }); }
const clean = (s, max = 200) => String(s ?? "").trim().slice(0, max);
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
function appUrl(req) {
  return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}
function setSession(res, userId) {
  const token = jwt.sign({ uid: userId }, SECRET, { expiresIn: "60d" });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 60 * 864e5, path: "/" });
}

// Simple in-memory rate limit for login/register/reset
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.path + "|" + req.ip, now = Date.now();
    const h = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) return bad(res, "Too many attempts. Wait a few minutes and try again.", 429);
    h.push(now); hits.set(k, h); next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (!h.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// Email codes are required when real email works (Resend set up), and always on your own computer.
// Without Resend in production, new accounts are confirmed automatically so sign-ups don't get stuck.
const verificationOn = () => email.resendReady() || !PROD;

// Logged in, email confirmed or not (used by /api/me and the verification screen).
async function authAny(req, res, next) {
  let uid;
  try { ({ uid } = jwt.verify(req.cookies[COOKIE] || "", SECRET)); } catch { return bad(res, "Please log in.", 401); }
  const { rows } = await q("SELECT * FROM users WHERE id=$1", [uid]).catch(() => ({ rows: [] }));
  if (!rows[0]) return bad(res, "Please log in.", 401);
  req.user = rows[0];
  // Remember when the owner was last here (at most once an hour), for "we miss you" emails.
  const last = rows[0].last_active_at ? new Date(rows[0].last_active_at).getTime() : 0;
  if (Date.now() - last > 3600e3) q("UPDATE users SET last_active_at=now() WHERE id=$1", [uid]).catch(() => {});
  next();
}
// Logged in with a confirmed email: everything else.
function auth(req, res, next) {
  authAny(req, res, () => {
    if (!req.user.email_verified) return res.status(403).json({ error: "Please confirm your email first.", code: "email_unverified" });
    next();
  });
}
const newReferralCode = () => "VB" + crypto.randomBytes(3).toString("hex").toUpperCase();
async function sendCode(user, purpose) {
  const code = await otp.create(user.id, purpose);
  if (!PROD) console.log(`[local] ${purpose} code for ${user.email}: ${code}`);
  const r = await email.otpEmail(user, code, purpose, otp.TTL_MIN);
  if (r && r.ok === false) { const e = new Error("We couldn't send the email. Please try again in a minute."); e.status = 502; throw e; }
}
function notifyReward(r, url) {
  if (!r) return;
  console.log(`[referral] user #${r.referrer.id} earned ${r.months} months for #${r.friend.id}`);
  email.referralRewardEmail(r.referrer, r.friend, r.months, url).catch((e) => console.error("[referral email]", e));
}
function publicUser(u) {
  return {
    id: u.id, email: u.email, ownerName: u.owner_name, shopName: u.shop_name, phone: u.phone,
    businessType: u.business_type, upiId: u.upi_id, defaultDays: u.default_days, reminderLang: u.reminder_lang,
    summaryEmail: u.summary_email, autoRemind: u.auto_remind,
    razorpay: { keyId: u.rzp_key_id, connected: Boolean(u.rzp_key_id && u.rzp_key_secret), webhookSet: Boolean(u.rzp_webhook_secret) },
    createdAt: u.created_at,
    plan: billing.status(u),
    emailVerified: u.email_verified,
    referralCode: u.referral_code,
    referralPopupDue: u.referral_popup_on !== Ledger.todayIST(),
  };
}

// Blocks changes once the trial or plan has ended. Viewing, settings and paying still work.
function requireActive(req, res, next) {
  if (billing.status(req.user).active) return next();
  return res.status(402).json({ error: "Your plan has ended. Subscribe to keep adding entries and sending reminders. Your data is safe.", code: "plan_expired" });
}
const toEntry = (r) => ({
  id: r.id, customerId: r.customer_id, kind: r.kind, amount: r.amount, date: r.entry_date, due: r.due_date,
  note: r.note, mode: r.mode, createdAt: new Date(r.created_at).getTime(),
});
const toCustomer = (r) => ({ id: r.id, name: r.name, phone: r.phone, lastReminderAt: r.last_reminder_at ? new Date(r.last_reminder_at).getTime() : null, createdAt: new Date(r.created_at).getTime() });

// ---------- health & config ----------
app.get("/healthz", wrap(async (req, res) => { await q("SELECT 1"); res.json({ ok: true }); }));
app.get("/api/config", (req, res) => res.json({
  whatsappApi: ix.whatsappConfigured(), email: email.configured(),
  billing: { ready: billing.ready(), testMode: !PROD && !billing.ready(), ...billing.PLAN },
  verification: verificationOn(),
  referral: billing.REFERRAL,
}));

// ---------- auth ----------
app.post("/api/auth/register", limit(10, 15 * 60e3), wrap(async (req, res) => {
  const b = req.body || {};
  const e = clean(b.email, 200).toLowerCase(), pw = String(b.password || "");
  const ownerName = clean(b.ownerName, 100), shopName = clean(b.shopName, 120), phone = digits(b.phone).slice(-10);
  const type = BTYPES.includes(b.businessType) ? b.businessType : "retail";
  if (!ownerName) return bad(res, "Enter your name.");
  if (!shopName) return bad(res, "Enter your business name.");
  if (!isEmail(e)) return bad(res, "Enter a valid email address.");
  if (phone && phone.length !== 10) return bad(res, "Enter a 10-digit mobile number.");
  if (pw.length < 8) return bad(res, "Use a password of at least 8 characters.");
  const exists = await q("SELECT 1 FROM users WHERE email=$1", [e]);
  if (exists.rowCount) return bad(res, "An account with this email already exists. Try logging in.", 409);
  let referrerId = null;
  const refCode = clean(b.referralCode, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (refCode) {
    const r = await q("SELECT id FROM users WHERE referral_code=$1", [refCode]);
    if (!r.rows[0]) return bad(res, "That referral code isn't valid. Check it, or leave it empty.");
    referrerId = r.rows[0].id;
  }
  const trialMonths = billing.PLAN.trialMonths + (referrerId ? billing.REFERRAL.friendBonusMonths : 0);
  const hash = await bcrypt.hash(pw, 10);
  const verified = !verificationOn();
  let user;
  for (let i = 0; i < 4 && !user; i++) {
    try {
      const { rows } = await q(
        `INSERT INTO users (email, password_hash, owner_name, shop_name, phone, business_type, trial_ends_at, email_verified, referral_code, referred_by, last_active_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(months => $7), $8, $9, $10, now()) RETURNING *`,
        [e, hash, ownerName, shopName, phone, type, trialMonths, verified, newReferralCode(), referrerId]);
      user = rows[0];
    } catch (err) {
      if (err.code === "23505" && String(err.message).includes("email")) return bad(res, "An account with this email already exists. Try logging in.", 409);
      if (err.code !== "23505" || i === 3) throw err; // referral code clash: try another
    }
  }
  setSession(res, user.id);
  console.log(`[register] user #${user.id} ${shopName}${referrerId ? ` (referred by #${referrerId})` : ""}`);
  email.adminRegistrationAlert(user).catch((err) => console.error("[admin alert]", err));
  if (verified) {
    email.welcomeEmail(user, appUrl(req)).catch((err) => console.error("[welcome email]", err));
    if (billing.REFERRAL.trigger === "signup") notifyReward(await billing.grantReferralReward(user.id), appUrl(req));
  } else {
    await sendCode(user, "verify").catch((err) => console.error("[verify code]", err.message));
  }
  res.status(201).json({ user: publicUser(user) });
}));

app.post("/api/auth/verify-email", authAny, limit(20, 15 * 60e3), wrap(async (req, res) => {
  if (req.user.email_verified) return res.json({ user: publicUser(req.user) });
  await otp.check(req.user.id, "verify", req.body.code);
  const { rows } = await q("UPDATE users SET email_verified=TRUE WHERE id=$1 RETURNING *", [req.user.id]);
  const user = rows[0];
  email.welcomeEmail(user, appUrl(req)).catch((err) => console.error("[welcome email]", err));
  if (billing.REFERRAL.trigger === "signup") notifyReward(await billing.grantReferralReward(user.id), appUrl(req));
  res.json({ user: publicUser(user) });
}));

app.post("/api/auth/resend-code", authAny, limit(8, 15 * 60e3), wrap(async (req, res) => {
  if (req.user.email_verified) return bad(res, "Your email is already confirmed.");
  await sendCode(req.user, "verify");
  res.json({ ok: true });
}));

// Change the email on an unconfirmed account (typo at sign-up), then send a fresh code.
app.post("/api/auth/change-email", authAny, limit(5, 15 * 60e3), wrap(async (req, res) => {
  if (req.user.email_verified) return bad(res, "Your email is already confirmed.");
  const e = clean(req.body.email, 200).toLowerCase();
  if (!isEmail(e)) return bad(res, "Enter a valid email address.");
  const taken = await q("SELECT 1 FROM users WHERE email=$1 AND id<>$2", [e, req.user.id]);
  if (taken.rowCount) return bad(res, "An account with this email already exists.", 409);
  const { rows } = await q("UPDATE users SET email=$1 WHERE id=$2 RETURNING *", [e, req.user.id]);
  await q("DELETE FROM email_codes WHERE user_id=$1 AND purpose='verify'", [req.user.id]);
  await sendCode(rows[0], "verify");
  res.json({ user: publicUser(rows[0]) });
}));

app.post("/api/auth/login", limit(20, 15 * 60e3), wrap(async (req, res) => {
  const e = clean(req.body.email, 200).toLowerCase(), pw = String(req.body.password || "");
  const { rows } = await q("SELECT * FROM users WHERE email=$1", [e]);
  const ok = rows[0] && (await bcrypt.compare(pw, rows[0].password_hash));
  if (!ok) return bad(res, "Email or password is wrong.", 401);
  setSession(res, rows[0].id);
  q("UPDATE users SET last_active_at=now() WHERE id=$1", [rows[0].id]).catch(() => {});
  res.json({ user: publicUser(rows[0]) });
}));

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

// Password reset step 1: email a 6-digit code.
app.post("/api/auth/forgot", limit(5, 15 * 60e3), wrap(async (req, res) => {
  if (PROD && !email.resendReady()) return bad(res, "Password reset by email isn't available yet. Please contact support.", 503);
  const e = clean(req.body.email, 200).toLowerCase();
  if (!isEmail(e)) return bad(res, "Enter a valid email address.");
  const { rows } = await q("SELECT * FROM users WHERE email=$1", [e]);
  if (rows[0]) {
    try { await sendCode(rows[0], "reset"); }
    catch (err) { if (err.status !== 429) throw err; } // a code was sent moments ago; it still works
  }
  // Same answer either way, so nobody can check which emails have accounts.
  res.json({ ok: true, minutes: otp.TTL_MIN });
}));

// Password reset step 2: code + new password.
app.post("/api/auth/reset", limit(10, 15 * 60e3), wrap(async (req, res) => {
  const e = clean(req.body.email, 200).toLowerCase(), pw = String(req.body.password || "");
  if (pw.length < 8) return bad(res, "Use a password of at least 8 characters.");
  const { rows } = await q("SELECT * FROM users WHERE email=$1", [e]);
  if (!rows[0]) return bad(res, "That code is wrong or has expired.");
  await otp.check(rows[0].id, "reset", req.body.code);
  // The code proves they own the email, so this also confirms it.
  const { rows: ur } = await q("UPDATE users SET password_hash=$1, email_verified=TRUE WHERE id=$2 RETURNING *", [await bcrypt.hash(pw, 10), rows[0].id]);
  setSession(res, rows[0].id);
  res.json({ user: publicUser(ur[0]) });
}));

// ---------- account ----------
app.get("/api/me", authAny, (req, res) => res.json({ user: publicUser(req.user) }));

app.put("/api/settings", auth, wrap(async (req, res) => {
  const b = req.body || {}, u = req.user;
  const shopName = b.shopName !== undefined ? clean(b.shopName, 120) : u.shop_name;
  const ownerName = b.ownerName !== undefined ? clean(b.ownerName, 100) : u.owner_name;
  if (!shopName || !ownerName) return bad(res, "Business name and your name can't be empty.");
  const phone = b.phone !== undefined ? digits(b.phone).slice(-10) : u.phone;
  if (phone && phone.length !== 10) return bad(res, "Enter a 10-digit mobile number.");
  const upi = b.upiId !== undefined ? clean(b.upiId, 100) : u.upi_id;
  if (upi && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi)) return bad(res, "That UPI ID doesn't look right. It should look like name@okaxis.");
  const type = BTYPES.includes(b.businessType) ? b.businessType : u.business_type;
  const days = b.defaultDays !== undefined ? Math.max(0, Math.min(120, parseInt(b.defaultDays, 10) || 0)) : u.default_days;
  const lang = LANGS.includes(b.reminderLang) ? b.reminderLang : u.reminder_lang;
  const summary = typeof b.summaryEmail === "boolean" ? b.summaryEmail : u.summary_email;
  const autoRemind = typeof b.autoRemind === "boolean" ? b.autoRemind : u.auto_remind;
  let rzpId = u.rzp_key_id, rzpSecret = u.rzp_key_secret, rzpHook = u.rzp_webhook_secret;
  if (b.razorpay) {
    if (b.razorpay.disconnect) { rzpId = ""; rzpSecret = ""; rzpHook = ""; }
    else {
      if (b.razorpay.keyId !== undefined) rzpId = clean(b.razorpay.keyId, 100);
      if (b.razorpay.keySecret) rzpSecret = ix.encrypt(clean(b.razorpay.keySecret, 200));
      if (b.razorpay.webhookSecret) rzpHook = ix.encrypt(clean(b.razorpay.webhookSecret, 200));
    }
  }
  const { rows } = await q(
    `UPDATE users SET shop_name=$1, owner_name=$2, phone=$3, upi_id=$4, business_type=$5, default_days=$6, reminder_lang=$7,
       summary_email=$8, auto_remind=$9, rzp_key_id=$10, rzp_key_secret=$11, rzp_webhook_secret=$12 WHERE id=$13 RETURNING *`,
    [shopName, ownerName, phone, upi, type, days, lang, summary, autoRemind, rzpId, rzpSecret, rzpHook, u.id]);
  res.json({ user: publicUser(rows[0]) });
}));

app.post("/api/account/delete", auth, wrap(async (req, res) => {
  const ok = await bcrypt.compare(String(req.body.password || ""), req.user.password_hash);
  if (!ok) return bad(res, "Password is wrong.", 401);
  await q("DELETE FROM users WHERE id=$1", [req.user.id]);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
}));

// ---------- ledger data ----------
app.get("/api/data", auth, wrap(async (req, res) => {
  const [c, e] = await Promise.all([
    q("SELECT * FROM customers WHERE user_id=$1 ORDER BY name", [req.user.id]),
    q("SELECT * FROM entries WHERE user_id=$1 ORDER BY entry_date, created_at", [req.user.id]),
  ]);
  res.json({ customers: c.rows.map(toCustomer), entries: e.rows.map(toEntry), today: Ledger.todayIST() });
}));

async function ownCustomer(userId, id) {
  const { rows } = await q("SELECT * FROM customers WHERE id=$1 AND user_id=$2", [Number(id), userId]);
  return rows[0];
}

app.post("/api/customers", auth, requireActive, wrap(async (req, res) => {
  const name = clean(req.body.name, 120), phone = digits(req.body.phone).slice(-10);
  if (!name) return bad(res, "Enter a name.");
  if (phone && phone.length !== 10) return bad(res, "Enter a 10-digit mobile number.");
  const count = await q("SELECT count(*)::int AS n FROM customers WHERE user_id=$1", [req.user.id]);
  if (count.rows[0].n >= 5000) return bad(res, "You've reached 5,000 customers on this account.");
  const { rows } = await q("INSERT INTO customers (user_id, name, phone) VALUES ($1,$2,$3) RETURNING *", [req.user.id, name, phone]);
  res.status(201).json({ customer: toCustomer(rows[0]) });
}));

app.put("/api/customers/:id", auth, requireActive, wrap(async (req, res) => {
  const c = await ownCustomer(req.user.id, req.params.id);
  if (!c) return bad(res, "Customer not found.", 404);
  const name = req.body.name !== undefined ? clean(req.body.name, 120) : c.name;
  const phone = req.body.phone !== undefined ? digits(req.body.phone).slice(-10) : c.phone;
  if (!name) return bad(res, "Enter a name.");
  if (phone && phone.length !== 10) return bad(res, "Enter a 10-digit mobile number.");
  const { rows } = await q("UPDATE customers SET name=$1, phone=$2 WHERE id=$3 RETURNING *", [name, phone, c.id]);
  res.json({ customer: toCustomer(rows[0]) });
}));

app.delete("/api/customers/:id", auth, requireActive, wrap(async (req, res) => {
  const r = await q("DELETE FROM customers WHERE id=$1 AND user_id=$2", [Number(req.params.id), req.user.id]);
  if (!r.rowCount) return bad(res, "Customer not found.", 404);
  res.json({ ok: true });
}));

app.post("/api/customers/:id/reminded", auth, requireActive, wrap(async (req, res) => {
  const { rows } = await q("UPDATE customers SET last_reminder_at=now() WHERE id=$1 AND user_id=$2 RETURNING *", [Number(req.params.id), req.user.id]);
  if (!rows[0]) return bad(res, "Customer not found.", 404);
  res.json({ customer: toCustomer(rows[0]) });
}));

app.post("/api/entries", auth, requireActive, wrap(async (req, res) => {
  const b = req.body || {};
  const c = await ownCustomer(req.user.id, b.customerId);
  if (!c) return bad(res, "Customer not found.", 404);
  const kind = b.kind === "payment" ? "payment" : "credit";
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!(amount > 0) || amount > 1e9) return bad(res, "Enter an amount above zero.");
  const today = Ledger.todayIST();
  const date = isDate(b.date) ? b.date : today;
  let due = null;
  if (kind === "credit") due = isDate(b.due) ? b.due : Ledger.addDays(date, req.user.default_days);
  const { rows } = await q(
    `INSERT INTO entries (user_id, customer_id, kind, amount, entry_date, due_date, note, mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.id, c.id, kind, amount, date, due, clean(b.note, 300), kind === "payment" ? clean(b.mode, 40) || "Cash" : ""]);
  res.status(201).json({ entry: toEntry(rows[0]) });
}));

app.delete("/api/entries/:id", auth, requireActive, wrap(async (req, res) => {
  const r = await q("DELETE FROM entries WHERE id=$1 AND user_id=$2", [Number(req.params.id), req.user.id]);
  if (!r.rowCount) return bad(res, "Entry not found.", 404);
  res.json({ ok: true });
}));

async function customerLedger(userId, customerId) {
  const { rows } = await q("SELECT * FROM entries WHERE user_id=$1 AND customer_id=$2", [userId, customerId]);
  return Ledger.compute(rows.map(toEntry));
}

// Razorpay payment link for the customer's current balance
app.post("/api/customers/:id/paylink", auth, requireActive, wrap(async (req, res) => {
  const u = req.user;
  if (!u.rzp_key_id || !u.rzp_key_secret) return bad(res, "Connect Razorpay in Settings first.");
  const c = await ownCustomer(u.id, req.params.id);
  if (!c) return bad(res, "Customer not found.", 404);
  const L = await customerLedger(u.id, c.id);
  if (!(L.bal >= 1)) return bad(res, "Nothing is due from this customer.");
  const link = await ix.createPaymentLink({
    keyId: u.rzp_key_id, keySecret: ix.decrypt(u.rzp_key_secret), amount: L.bal,
    customer: c, shopName: u.shop_name, userId: u.id, customerId: c.id,
  });
  await q("INSERT INTO payment_links (id, user_id, customer_id, amount, short_url) VALUES ($1,$2,$3,$4,$5)", [link.id, u.id, c.id, L.bal, link.shortUrl]);
  res.json({ url: link.shortUrl, amount: L.bal });
}));

// Send a reminder through the WhatsApp Business API (when the platform has it configured)
app.post("/api/customers/:id/send-reminder", auth, requireActive, wrap(async (req, res) => {
  if (!ix.whatsappConfigured()) return bad(res, "Automatic WhatsApp sending isn't set up on this server.");
  const u = req.user;
  const c = await ownCustomer(u.id, req.params.id);
  if (!c) return bad(res, "Customer not found.", 404);
  if (!c.phone) return bad(res, "Add this customer's WhatsApp number first.");
  const L = await customerLedger(u.id, c.id);
  if (!(L.bal >= 1)) return bad(res, "Nothing is due from this customer.");
  await ix.sendWhatsAppReminder({
    to: c.phone, customerName: c.name.split(" ")[0], amount: Ledger.inr(L.bal), shopName: u.shop_name,
    payText: req.body.link ? `Pay here: ${clean(req.body.link, 300)}` : u.upi_id ? `Pay by UPI to ${u.upi_id}` : "",
  });
  const { rows } = await q("UPDATE customers SET last_reminder_at=now() WHERE id=$1 RETURNING *", [c.id]);
  res.json({ customer: toCustomer(rows[0]) });
}));

// ---------- refer & earn ----------
app.get("/api/referrals", auth, wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT u.shop_name, u.created_at, u.email_verified, rr.months
     FROM users u LEFT JOIN referral_rewards rr ON rr.referee_id = u.id
     WHERE u.referred_by=$1 ORDER BY u.created_at DESC LIMIT 200`, [req.user.id]);
  const friends = rows.map((r) => ({ shop: r.shop_name, joinedAt: r.created_at, rewardMonths: r.months || 0, confirmed: r.email_verified }));
  res.json({
    code: req.user.referral_code,
    rewardMonths: billing.REFERRAL.rewardMonths, friendBonusMonths: billing.REFERRAL.friendBonusMonths, trigger: billing.REFERRAL.trigger,
    joined: friends.length, rewarded: friends.filter((f) => f.rewardMonths).length,
    monthsEarned: friends.reduce((s, f) => s + f.rewardMonths, 0), friends,
  });
}));
// The dashboard popup shows once a day; this records that today's was seen.
app.post("/api/referrals/popup-seen", auth, wrap(async (req, res) => {
  await q("UPDATE users SET referral_popup_on=$1 WHERE id=$2", [Ledger.todayIST(), req.user.id]);
  res.json({ ok: true });
}));

// ---------- subscription ----------
app.get("/api/subscription", auth, wrap(async (req, res) => {
  res.json({ plan: billing.status(req.user), payments: await billing.history(req.user.id) });
}));

app.post("/api/subscription/order", auth, limit(10, 15 * 60e3), wrap(async (req, res) => {
  if (!billing.ready()) return bad(res, "Online payment isn't set up yet. Please try again later.", 503);
  const order = await billing.createOrder(req.user);
  res.json({ ...order, name: req.user.owner_name, email: req.user.email, phone: req.user.phone, shop: req.user.shop_name, months: billing.PLAN.months });
}));

app.post("/api/subscription/verify", auth, wrap(async (req, res) => {
  const b = req.body || {};
  const orderId = String(b.razorpay_order_id || ""), paymentId = String(b.razorpay_payment_id || "");
  const { rows } = await q("SELECT * FROM subscription_payments WHERE order_id=$1 AND user_id=$2", [orderId, req.user.id]);
  if (!rows[0]) return bad(res, "Payment not found.", 404);
  if (!billing.checkoutSignatureOk(orderId, paymentId, b.razorpay_signature)) return bad(res, "We couldn't confirm this payment. If money was taken, it will be confirmed automatically within a few minutes.");
  const done = await billing.applyPayment(orderId, paymentId);
  let user = req.user;
  if (done) {
    user = done.user;
    console.log(`[billing] user #${user.id} paid order ${orderId}`);
    email.planPurchaseEmails(user, done.payment, appUrl(req)).catch((e) => console.error("[plan email]", e));
    notifyReward(done.reward, appUrl(req));
  } else {
    user = (await q("SELECT * FROM users WHERE id=$1", [req.user.id])).rows[0];
  }
  res.json({ user: publicUser(user) });
}));

// ---------- local testing helpers (never active in production) ----------
if (!PROD) {
  const fs = require("fs");
  app.get("/dev/emails", (req, res) => {
    const files = email.listOutbox();
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local emails</title>
      <body style="font:15px system-ui;max-width:760px;margin:0 auto;padding:16px">
      <h1 style="font-size:20px">Emails saved on this computer</h1>
      <p style="color:#56665F">In local mode nothing is sent. Every email the app would send appears here, newest first.
      Add RESEND_API_KEY and EMAIL_FROM to send real emails.</p>
      <p><a href="/">Back to VasulBook</a> · <a href="/dev/emails">Refresh</a></p>
      ${files.length ? "<ul>" + files.map((f) => `<li style="margin:6px 0"><a href="/dev/emails/${encodeURIComponent(f)}">${f.replace(/\.html$/, "")}</a></li>`).join("") + "</ul>" : "<p>No emails yet. Create an account to see the welcome email and the admin alert.</p>"}
      </body>`);
  });
  app.get("/dev/emails/:file", (req, res) => {
    const name = path.basename(req.params.file);
    const file = path.join(email.OUTBOX, name);
    if (!name.endsWith(".html") || !fs.existsSync(file)) return res.status(404).send("Not found");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.send(fs.readFileSync(file, "utf8"));
  });
  // Local only, when no Razorpay keys are set: pretend a plan payment went through.
  app.post("/api/subscription/test-pay", auth, wrap(async (req, res) => {
    if (billing.ready()) return bad(res, "Razorpay keys are set, so use the real checkout.");
    const orderId = "order_test_" + Date.now();
    await q("INSERT INTO subscription_payments (order_id, user_id, amount, months) VALUES ($1,$2,$3,$4)", [orderId, req.user.id, billing.PLAN.priceInr, billing.PLAN.months]);
    const done = await billing.applyPayment(orderId, "pay_test_" + Date.now());
    email.planPurchaseEmails(done.user, done.payment, appUrl(req)).catch(() => {});
    res.json({ user: publicUser(done.user) });
  }));
  // Local only: jump this account's trial to "ended" to see the locked state.
  app.post("/api/subscription/test-expire", auth, wrap(async (req, res) => {
    const { rows } = await q("UPDATE users SET trial_ends_at = now() - interval '1 day', paid_until = NULL, plan_notice='' WHERE id=$1 RETURNING *", [req.user.id]);
    res.json({ user: publicUser(rows[0]) });
  }));
  app.get("/dev/run-inactive", wrap(async (req, res) => { await jobs.inactiveNudges({ days: Number(req.query.days ?? 5) }); res.redirect("/dev/emails"); }));
  app.get("/dev/run-plan-notices", wrap(async (req, res) => { await jobs.planNotices(); res.redirect("/dev/emails"); }));
  app.get("/dev/run-summary", wrap(async (req, res) => {
    await q("UPDATE users SET last_summary_on = NULL");
    await jobs.eveningSummaries();
    res.redirect("/dev/emails");
  }));
}

// ---------- static PWA ----------
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) {
    if (file.endsWith("sw.js") || file.endsWith(".html") || file.endsWith(".webmanifest")) res.setHeader("Cache-Control", "no-cache");
    else res.setHeader("Cache-Control", "public, max-age=3600");
    if (file.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
  },
}));
app.use("/api", (req, res) => bad(res, "Not found.", 404));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------- errors ----------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === "entity.parse.failed") return bad(res, "Invalid request.");
  if (err.status && err.status < 500) return bad(res, err.message, err.status);
  console.error("[error]", req.method, req.path, err);
  bad(res, "Something went wrong on our side. Please try again.", 500);
});

(async () => {
  await migrate();
  jobs.start();
  app.listen(PORT, () => {
    console.log(`VasulBook running on port ${PORT} (database: ${require("./src/db").mode})`);
    if (!PROD) {
      const nets = require("os").networkInterfaces();
      const lan = Object.values(nets).flat().filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => `http://${n.address}:${PORT}`);
      console.log("");
      console.log(`  Open on this computer:   http://localhost:${PORT}`);
      if (lan.length) console.log(`  Open on your phone:      ${lan[0]}   (same Wi-Fi)`);
      console.log(`  See emails it would send: http://localhost:${PORT}/dev/emails`);
      console.log("");
    }
  });
})().catch((err) => { console.error("Startup failed:", err); process.exit(1); });
