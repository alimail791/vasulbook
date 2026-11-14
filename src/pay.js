// Plan payments. Two ways, both offered when set up:
// 1) Razorpay payment link (UPI, cards, net banking) – confirms itself via webhook.
// 2) Direct UPI to ADMIN_UPI (no fees) – advertiser taps "I've paid", admin confirms with one tap.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const rzpEnabled = () => !!(cfg.RZP_KEY && cfg.RZP_SECRET);
const upiEnabled = () => !!cfg.ADMIN_UPI;
const ref = (p) => 'EDP' + p.id;

function upiUri(p) {
  const q = new URLSearchParams({ pa: cfg.ADMIN_UPI, pn: cfg.UPI_NAME, am: Number(p.amount).toFixed(2), cu: 'INR', tn: `${cfg.BRAND} ${ref(p)}` });
  return 'upi://pay?' + q.toString().replace(/\+/g, '%20');
}

async function create(adv, plan) {
  const p = await db.one('insert into payments(adv_id,plan,amount,locality_id) values($1,$2,$3,$4) returning *', [adv.id, plan.key, plan.price, adv.locality_id]);
  if (!rzpEnabled()) return p;
  try {
    const r = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(cfg.RZP_KEY + ':' + cfg.RZP_SECRET).toString('base64') },
      body: JSON.stringify({
        amount: Math.round(plan.price * 100), currency: 'INR', description: `${cfg.BRAND} ${plan.name} plan – ${adv.name}`.slice(0, 2048),
        reference_id: ref(p), customer: { name: adv.name, contact: '+' + adv.phone },
        notify: { sms: false, email: false }, reminder_enable: false, upi_link: false,
        notes: { payment_id: String(p.id), adv_id: String(adv.id), plan: plan.key },
      }),
    });
    const j = await r.json();
    if (!r.ok) { console.error('Razorpay error', j); return p; }
    return db.one('update payments set link_id=$2, link_url=$3 where id=$1 returning *', [p.id, j.id, j.short_url]);
  } catch (e) { console.error('Razorpay error', e.message); return p; }
}

function text(p) {
  const lines = [`Amount: *₹${p.amount}*  ·  Ref: ${ref(p)}`];
  if (p.link_url) lines.push(`\n💳 *Pay by UPI / card* (confirms automatically):\n${p.link_url}`);
  if (upiEnabled()) {
    lines.push(`\n📲 *${p.link_url ? 'Or pay' : 'Pay'} directly by UPI* to *${cfg.ADMIN_UPI}*${cfg.PUBLIC_URL ? `\nOpen GPay / PhonePe / Paytm: ${cfg.PUBLIC_URL}/pay/${p.id}` : ''}\nThen tap *I've paid* and send the UPI reference number (or a screenshot).`);
  }
  if (!p.link_url && !upiEnabled()) lines.push('\nThe admin will share payment details with you shortly.');
  return lines.join('\n');
}

function verifyWebhook(raw, sig) {
  if (!cfg.RZP_WEBHOOK_SECRET) return false;
  const exp = crypto.createHmac('sha256', cfg.RZP_WEBHOOK_SECRET).update(raw).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(String(sig || ''))); } catch (_) { return false; }
}

module.exports = { rzpEnabled, upiEnabled, upiUri, create, text, ref, verifyWebhook };
