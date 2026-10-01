const crypto = require("crypto");

// ---------- secret encryption for per-shop keys (AES-256-GCM) ----------
function key() {
  return crypto.createHash("sha256").update(String(process.env.SESSION_SECRET || "")).digest();
}
function encrypt(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
function decrypt(blob) {
  if (!blob) return "";
  try {
    const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch { return ""; }
}

// ---------- Razorpay payment links (each shop uses its own Razorpay account) ----------
async function createPaymentLink({ keyId, keySecret, amount, customer, shopName, userId, customerId }) {
  const res = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      currency: "INR",
      description: `Balance due at ${shopName}`.slice(0, 2048),
      customer: { name: customer.name, ...(customer.phone ? { contact: "+91" + customer.phone.slice(-10) } : {}) },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { vb_user: String(userId), vb_customer: String(customerId) },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && body.error && body.error.description) || `Razorpay error ${res.status}`;
    const err = new Error(msg); err.status = 400; throw err;
  }
  return { id: body.id, shortUrl: body.short_url };
}
function verifyRazorpaySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- WhatsApp Cloud API (one platform number sends for every shop) ----------
function whatsappConfigured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_TEMPLATE);
}
// The approved template must have 4 body variables: {{1}} customer name, {{2}} amount, {{3}} shop name, {{4}} how to pay.
async function sendWhatsAppReminder({ to, customerName, amount, shopName, payText }) {
  const phone = String(to).replace(/\D/g, "");
  const intl = phone.length === 10 ? "91" + phone : phone;
  const res = await fetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: intl,
      type: "template",
      template: {
        name: process.env.WHATSAPP_TEMPLATE,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "en" },
        components: [{
          type: "body",
          parameters: [customerName, amount, shopName, payText || "Please pay at the shop."].map((t) => ({ type: "text", text: String(t).slice(0, 900) })),
        }],
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body && body.error && body.error.message) || `WhatsApp error ${res.status}`;
    const err = new Error(msg); err.status = 502; throw err;
  }
  return body;
}

module.exports = { encrypt, decrypt, createPaymentLink, verifyRazorpaySignature, whatsappConfigured, sendWhatsAppReminder };
