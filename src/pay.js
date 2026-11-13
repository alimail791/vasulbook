// Razorpay payment links for the ₹2,000 setup fee and the monthly 2% bill.
// If Razorpay is not configured, falls back to the admin's UPI ID.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const enabled = () => !!(cfg.RZP_KEY && cfg.RZP_SECRET);

async function createLink({ kind, ref, month, amount, description, phone, name }) {
  const p = await db.one('insert into payments(kind,ref,month,amount) values($1,$2,$3,$4) returning *', [kind, ref, month || null, amount]);
  if (!enabled()) return { ...p, link_url: null };
  const r = await fetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(cfg.RZP_KEY + ':' + cfg.RZP_SECRET).toString('base64') },
    body: JSON.stringify({
      amount: Math.round(amount * 100), currency: 'INR', description: description.slice(0, 2048),
      customer: { name: name || undefined, contact: phone ? '+' + phone : undefined },
      notify: { sms: false, email: false }, reminder_enable: true,
      notes: { kind, ref: String(ref), payment_id: String(p.id) },
    }),
  });
  const j = await r.json();
  if (!r.ok) { console.error('Razorpay error', j); return { ...p, link_url: null }; }
  return db.one('update payments set link_id=$2, link_url=$3 where id=$1 returning *', [p.id, j.id, j.short_url]);
}

// Text to send with a payment request
function payText(p) {
  if (p.link_url) return `💳 Pay securely here:\n${p.link_url}`;
  if (cfg.ADMIN_UPI) return `💳 Pay via any UPI app to:\n*${cfg.ADMIN_UPI}*\nThen send the screenshot here. Admin will confirm.`;
  return '💳 Admin will share payment details with you shortly.';
}

function verifyWebhook(raw, sig) {
  if (!cfg.RZP_WEBHOOK_SECRET) return false;
  const exp = crypto.createHmac('sha256', cfg.RZP_WEBHOOK_SECRET).update(raw).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(String(sig || ''))); } catch (_) { return false; }
}

module.exports = { enabled, createLink, payText, verifyWebhook };
