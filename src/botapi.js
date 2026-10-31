/* Private link for the shared WhatsApp bot (WA-bot, Raise Academy's number).
   The bot reads which owners are due a welcome / verify / refer & earn / we-miss-you message,
   and reports back when an owner confirms their WhatsApp number or replies STOP.
   Protected by BOT_API_KEY (the same value is set as VASULBOOK_BOT_KEY on the bot). */
const crypto = require("crypto");
const { q } = require("./db");
const billing = require("./billing");

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

module.exports = function mountBotApi(app, { wrap, bad }) {
  const key = () => process.env.BOT_API_KEY || "";
  function botAuth(req, res, next) {
    const k = key(), got = String(req.get("x-bot-key") || "");
    if (k.length < 24) return bad(res, "Bot link is not set up.", 503);
    const a = crypto.createHash("sha256").update(got).digest(), b = crypto.createHash("sha256").update(k).digest();
    if (!crypto.timingSafeEqual(a, b)) return bad(res, "Not allowed.", 401);
    next();
  }
  const owner = (u) => ({
    id: u.id, name: u.owner_name, shop: u.shop_name, phone: u.phone, lang: u.ui_lang || "en",
    createdAt: u.created_at, lastActive: u.last_active_at,
    emailVerified: u.email_verified, phoneVerified: u.phone_verified,
    referralCode: u.referral_code, customers: u.customers, entries: u.entries, referred: u.referred,
    plan: billing.status(u).state, optedOut: u.wa_opt_out,
  });
  const SELECT = `SELECT u.*,
      (SELECT count(*) FROM customers c WHERE c.user_id=u.id)::int AS customers,
      (SELECT count(*) FROM entries e WHERE e.user_id=u.id)::int AS entries,
      (SELECT count(*) FROM users r WHERE r.referred_by=u.id)::int AS referred
    FROM users u WHERE length(regexp_replace(coalesce(u.phone,''), '\\D', '', 'g')) >= 10`;

  // Quick health check for the bot's start-up log
  app.get("/api/bot/check", botAuth, wrap(async (req, res) => {
    const { rows } = await q("SELECT count(*)::int AS owners, count(*) FILTER (WHERE phone <> '')::int AS with_phone FROM users");
    res.json({ ok: true, ...rows[0] });
  }));
  // Owners who signed up in the last N hours (for the welcome message)
  app.get("/api/bot/new-owners", botAuth, wrap(async (req, res) => {
    const hours = Math.min(96, Math.max(1, Number(req.query.hours) || 36));
    const { rows } = await q(`${SELECT} AND u.created_at > now() - make_interval(hours => $1) ORDER BY u.created_at`, [hours]);
    res.json({ owners: rows.map(owner) });
  }));
  // Owners who may be due a verify / refer / miss-you message
  app.get("/api/bot/lifecycle-owners", botAuth, wrap(async (req, res) => {
    const { rows } = await q(`${SELECT} AND NOT u.wa_opt_out AND u.created_at < now() - interval '12 hours'
      AND (u.last_active_at > now() - interval '50 days' OR u.created_at > now() - interval '50 days') ORDER BY u.id LIMIT 20000`);
    res.json({ owners: rows.map(owner) });
  }));
  // The owner tapped "Yes, it's my number" in WhatsApp
  app.post("/api/bot/phone-verified", botAuth, wrap(async (req, res) => {
    const p = last10(req.body.phone);
    if (p.length !== 10) return bad(res, "Phone missing.");
    const { rows } = await q(`UPDATE users SET phone_verified=TRUE, phone_verified_at=now()
      WHERE right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1 RETURNING id, shop_name, ui_lang`, [p]);
    res.json({ ok: true, owners: rows.map((r) => ({ id: r.id, shop: r.shop_name, lang: r.ui_lang })) });
  }));
  // STOP / START from WhatsApp
  app.post("/api/bot/opt-out", botAuth, wrap(async (req, res) => {
    const p = last10(req.body.phone);
    if (p.length !== 10) return bad(res, "Phone missing.");
    const out = req.body.out !== false;
    const { rows } = await q(`UPDATE users SET wa_opt_out=$2
      WHERE right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1 RETURNING id, shop_name, ui_lang`, [p, out]);
    res.json({ ok: true, owners: rows.map((r) => ({ id: r.id, shop: r.shop_name, lang: r.ui_lang })) });
  }));
  // Who is this number? (when an owner replies to a VasulBook message)
  app.get("/api/bot/owner", botAuth, wrap(async (req, res) => {
    const p = last10(req.query.phone);
    const { rows } = await q(`${SELECT} AND right(regexp_replace(coalesce(u.phone,''), '\\D', '', 'g'), 10) = $1 ORDER BY u.last_active_at DESC NULLS LAST LIMIT 1`, [p]);
    res.json({ owner: rows[0] ? owner(rows[0]) : null });
  }));
};
