// VasulBook subscription: free trial, then a paid plan bought through the platform's own Razorpay account.
const crypto = require("crypto");
const { q } = require("./db");

const PLAN = {
  trialMonths: Number(process.env.TRIAL_MONTHS || 3),
  priceInr: Number(process.env.PLAN_PRICE_INR || 1000),
  months: Number(process.env.PLAN_MONTHS || 10),
};
// Refer & earn: the referrer gets free months for each friend who joins (confirms their email) or, if set, pays.
const REFERRAL = {
  rewardMonths: Number(process.env.REFERRAL_REWARD_MONTHS || 5),
  friendBonusMonths: Number(process.env.REFERRAL_FRIEND_BONUS_MONTHS || 1),
  trigger: process.env.REFERRAL_TRIGGER === "payment" ? "payment" : "signup",
};

// Adds free months for the person who referred this user. Runs at most once per referred user.
async function grantReferralReward(refereeId) {
  if (!(REFERRAL.rewardMonths > 0)) return null;
  const { rows: rr } = await q("SELECT id, referred_by, shop_name FROM users WHERE id=$1", [refereeId]);
  const friend = rr[0];
  if (!friend || !friend.referred_by) return null;
  const ins = await q(
    "INSERT INTO referral_rewards (referee_id, referrer_id, months) VALUES ($1,$2,$3) ON CONFLICT (referee_id) DO NOTHING RETURNING *",
    [friend.id, friend.referred_by, REFERRAL.rewardMonths]);
  if (!ins.rows[0]) return null;
  const { rows: ur } = await q(
    `UPDATE users SET paid_until = GREATEST(now(), COALESCE(trial_ends_at, now()), COALESCE(paid_until, now())) + make_interval(months => $2)
     WHERE id=$1 RETURNING *`, [friend.referred_by, REFERRAL.rewardMonths]);
  return ur[0] ? { referrer: ur[0], friend, months: REFERRAL.rewardMonths } : null;
}
const API = "https://api.razorpay.com/v1";

function ready() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}
function authHeader() {
  return "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
}

// What the account can do right now.
function status(u) {
  const now = Date.now();
  const trialEnd = u.trial_ends_at ? new Date(u.trial_ends_at).getTime() : 0;
  const paidUntil = u.paid_until ? new Date(u.paid_until).getTime() : 0;
  const accessUntil = Math.max(trialEnd, paidUntil);
  const active = accessUntil > now;
  const state = !active ? "expired" : paidUntil > now ? "paid" : "trial";
  return {
    state, active,
    trialEndsAt: trialEnd ? new Date(trialEnd).toISOString() : null,
    paidUntil: paidUntil ? new Date(paidUntil).toISOString() : null,
    accessUntil: accessUntil ? new Date(accessUntil).toISOString() : null,
    daysLeft: active ? Math.ceil((accessUntil - now) / 864e5) : 0,
    priceInr: PLAN.priceInr, months: PLAN.months, trialMonths: PLAN.trialMonths,
  };
}

async function createOrder(user) {
  const amount = Math.round(PLAN.priceInr * 100);
  const res = await fetch(`${API}/orders`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      amount, currency: "INR",
      receipt: `vb-${user.id}-${Date.now()}`.slice(0, 40),
      notes: { vb_user: String(user.id), plan: `${PLAN.months} months`, email: user.email },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[billing] order failed", res.status, body && body.error);
    const err = new Error("Couldn't start the payment. Please try again in a minute."); err.status = 502; throw err;
  }
  await q(`INSERT INTO subscription_payments (order_id, user_id, amount, months) VALUES ($1,$2,$3,$4)`,
    [body.id, user.id, PLAN.priceInr, PLAN.months]);
  return { orderId: body.id, amount, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID };
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function checkoutSignatureOk(orderId, paymentId, signature) {
  if (!ready()) return false;
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEq(expected, signature || "");
}
function webhookSignatureOk(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  return safeEq(crypto.createHmac("sha256", secret).update(rawBody).digest("hex"), signature);
}

// Marks an order paid and extends the plan. Safe to call twice (checkout + webhook): only the first call extends.
// The paid months start when the current trial or plan ends, so nobody loses days by paying early.
async function applyPayment(orderId, paymentId) {
  const { rows } = await q(
    `UPDATE subscription_payments SET status='paid', payment_id=$2, paid_at=now()
     WHERE order_id=$1 AND status <> 'paid' RETURNING *`, [orderId, paymentId]);
  const p = rows[0];
  if (!p) return null;
  const { rows: ur } = await q(
    `UPDATE users SET paid_until = GREATEST(now(), COALESCE(trial_ends_at, now()), COALESCE(paid_until, now())) + make_interval(months => $2)
     WHERE id=$1 RETURNING *`, [p.user_id, p.months]);
  const reward = REFERRAL.trigger === "payment" ? await grantReferralReward(p.user_id) : null;
  return { payment: p, user: ur[0], reward };
}

async function history(userId) {
  const { rows } = await q(
    `SELECT order_id, payment_id, amount, months, paid_at FROM subscription_payments WHERE user_id=$1 AND status='paid' ORDER BY paid_at DESC`, [userId]);
  return rows.map((r) => ({ orderId: r.order_id, paymentId: r.payment_id, amount: r.amount, months: r.months, paidAt: r.paid_at }));
}

module.exports = { PLAN, REFERRAL, grantReferralReward, ready, status, createOrder, checkoutSignatureOk, webhookSignatureOk, applyPayment, history };
