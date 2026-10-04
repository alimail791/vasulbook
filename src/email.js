// Email through Resend's HTTPS API (works on hosts that block SMTP ports, such as Railway Hobby).
const APP_NAME = "VasulBook";

const fs = require("fs");
const path = require("path");
const OUTBOX = path.join(__dirname, "..", "local-data", "mail-outbox");
const LOCAL = process.env.NODE_ENV !== "production";

// Real sending through Resend
function resendReady() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}
// Emails "work" if Resend is set up, or (on your own computer) they are saved to the local outbox.
function configured() {
  return resendReady() || LOCAL;
}

function saveToOutbox({ to, subject, html }) {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  const file = path.join(OUTBOX, `${stamp}_${slug}.html`);
  const head = `<p style="font:13px system-ui;background:#FAEFD9;padding:8px 12px;margin:0">Saved locally, not sent. To: ${esc([].concat(to).join(", "))} · Subject: ${esc(subject)}</p>`;
  fs.writeFileSync(file, head + html);
  console.log(`[email saved locally] to=${[].concat(to).join(",")} subject="${subject}" -> open http://localhost:${process.env.PORT || 3000}/dev/emails`);
  return { ok: true, local: true };
}
function listOutbox() {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs.readdirSync(OUTBOX).filter((f) => f.endsWith(".html")).sort().reverse();
}

async function send({ to, subject, html, text, replyTo }) {
  if (!resendReady()) {
    if (LOCAL) return saveToOutbox({ to, subject, html });
    console.log(`[email skipped: RESEND_API_KEY/EMAIL_FROM not set] to=${to} subject="${subject}"`);
    return { skipped: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: Array.isArray(to) ? to : [to], subject, html, text, reply_to: replyTo }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[email failed] ${res.status} to=${to} subject="${subject}"`, body && body.message);
    return { ok: false, error: body && body.message };
  }
  return { ok: true, id: body.id };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#F2F5F4;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#14211D">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="font-size:22px;font-weight:700;margin-bottom:16px">Vasul<span style="color:#2445B5">Book</span></div>
    <div style="background:#fff;border:1px solid #D7E0DC;border-radius:12px;padding:20px">
      <h1 style="font-size:19px;margin:0 0 12px">${esc(title)}</h1>
      ${bodyHtml}
    </div>
    <p style="font-size:12px;color:#56665F;margin-top:16px">You are receiving this because of your ${APP_NAME} account.</p>
  </div></body></html>`;
}

const BTYPE = {
  retail: "Retail shop", tuition: "Tuition or coaching", delivery: "Daily delivery", services: "Services",
  wholesale: "Wholesale", rental: "Rent or membership", clinic: "Clinic or professional",
};

function adminList() {
  const list = String(process.env.ADMIN_EMAIL || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : LOCAL ? ["admin@localhost (set ADMIN_EMAIL)"] : [];
}
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" }) : "");
const button = (href, label) => `<p><a href="${esc(href)}" style="display:inline-block;background:#2445B5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`;

// Sent when a new business registers: a welcome to the owner, and an alert to the admin.
async function registrationEmails(user, appUrl) {
  const jobs = [];
  jobs.push(send({
    to: user.email,
    subject: `Welcome to ${APP_NAME}, ${user.owner_name}`,
    html: layout(`Welcome, ${user.owner_name}`, `
      <p>Your ${APP_NAME} account for <b>${esc(user.shop_name)}</b> is ready.</p>
      <p>Your <b>free trial runs until ${esc(fmtDay(user.trial_ends_at))}</b>. No card or payment needed until then.</p>
      <p>Three things to do first:</p>
      <ol style="padding-left:20px;line-height:1.6">
        <li>Add your UPI ID in Settings so every reminder carries it.</li>
        <li>Add the customers who owe you money, with their WhatsApp numbers.</li>
        <li>Send your first reminder and watch the payments come in.</li>
      </ol>
      <p><a href="${esc(appUrl)}" style="display:inline-block;background:#2445B5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open ${APP_NAME}</a></p>
      <p style="font-size:13px;color:#56665F">Tip: on your phone, open the app and choose "Add to Home screen" to install it.</p>`),
    text: `Welcome to ${APP_NAME}! Your account for ${user.shop_name} is ready. Open: ${appUrl}`,
  }));

  const admins = adminList();
  if (admins.length) {
    const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    jobs.push(send({
      to: admins,
      subject: `New ${APP_NAME} registration: ${user.shop_name}`,
      html: layout("New business registered", `
        <table style="border-collapse:collapse;font-size:14px;width:100%">
          ${[["Business", user.shop_name], ["Owner", user.owner_name], ["Email", user.email], ["Phone", user.phone || "Not given"],
             ["Type", BTYPE[user.business_type] || user.business_type], ["Registered", when + " IST"], ["User ID", "#" + user.id]]
            .map(([k, v]) => `<tr><td style="padding:6px 0;color:#56665F;width:110px">${k}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join("")}
        </table>`),
      text: `New registration: ${user.shop_name} (${user.owner_name}, ${user.email}, ${user.phone}) at ${when} IST`,
      replyTo: user.email,
    }));
  }
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => { if (r.status === "rejected") console.error("[email error]", r.reason); });
}

async function passwordResetEmail(user, link) {
  return send({
    to: user.email,
    subject: `Reset your ${APP_NAME} password`,
    html: layout("Reset your password", `
      <p>Someone asked to reset the password for ${esc(user.email)}. If it was you, use the button below. The link works for 1 hour.</p>
      <p><a href="${esc(link)}" style="display:inline-block;background:#2445B5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Set a new password</a></p>
      <p style="font-size:13px;color:#56665F">If you didn't ask for this, ignore this email. Your password stays the same.</p>`),
    text: `Reset your ${APP_NAME} password (valid 1 hour): ${link}`,
  });
}

async function dailySummaryEmail(user, s, appUrl) {
  const rows = s.overdue.slice(0, 10).map((o) =>
    `<tr><td style="padding:6px 0">${esc(o.name)}</td><td style="padding:6px 0;text-align:right;font-weight:600">${esc(o.amount)}</td><td style="padding:6px 0 6px 12px;color:#B93A30;text-align:right">${o.days} day${o.days === 1 ? "" : "s"}</td></tr>`).join("");
  return send({
    to: user.email,
    subject: `${user.shop_name}: ${s.collected} collected today`,
    html: layout(`Today at ${user.shop_name}`, `
      <table style="width:100%;font-size:15px;border-collapse:collapse">
        <tr><td style="padding:4px 0">Collected today</td><td style="text-align:right;font-weight:700;color:#1F7A4B">${esc(s.collected)}</td></tr>
        <tr><td style="padding:4px 0">New credit today</td><td style="text-align:right;font-weight:700">${esc(s.credit)}</td></tr>
        <tr><td style="padding:4px 0">Total pending</td><td style="text-align:right;font-weight:700">${esc(s.pending)}</td></tr>
      </table>
      ${rows ? `<h2 style="font-size:15px;margin:18px 0 6px">Overdue</h2><table style="width:100%;font-size:14px;border-collapse:collapse">${rows}</table>` : `<p style="color:#1F7A4B">No overdue customers. Well done!</p>`}
      <p style="margin-top:18px"><a href="${esc(appUrl)}" style="color:#2445B5;font-weight:600">Open ${APP_NAME}</a></p>`),
    text: `Collected today ${s.collected}. New credit ${s.credit}. Pending ${s.pending}.`,
  });
}

// After a plan payment: a receipt to the owner and an alert to the admin.
async function planPurchaseEmails(user, payment, appUrl) {
  const amount = "₹" + Number(payment.amount).toLocaleString("en-IN");
  const jobs = [send({
    to: user.email,
    subject: `Payment received: ${APP_NAME} plan active till ${fmtDay(user.paid_until)}`,
    html: layout("Thank you! Your plan is active", `
      <table style="border-collapse:collapse;font-size:14px;width:100%">
        ${[["Business", user.shop_name], ["Plan", `${payment.months} months`], ["Amount paid", amount],
           ["Active until", fmtDay(user.paid_until)], ["Payment ID", payment.payment_id || ""], ["Order ID", payment.order_id]]
          .map(([k, v]) => `<tr><td style="padding:6px 0;color:#56665F;width:120px">${k}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join("")}
      </table>
      ${button(appUrl, "Open " + APP_NAME)}`),
    text: `Payment of ${amount} received. Your ${APP_NAME} plan is active until ${fmtDay(user.paid_until)}. Payment ID ${payment.payment_id}.`,
  })];
  const admins = adminList();
  if (admins.length) jobs.push(send({
    to: admins,
    subject: `${APP_NAME} plan purchased: ${user.shop_name} (${amount})`,
    html: layout("New plan purchase", `
      <table style="border-collapse:collapse;font-size:14px;width:100%">
        ${[["Business", user.shop_name], ["Owner", user.owner_name], ["Email", user.email], ["Phone", user.phone || "Not given"],
           ["Amount", amount], ["Plan", `${payment.months} months`], ["Active until", fmtDay(user.paid_until)], ["Payment ID", payment.payment_id || ""], ["User ID", "#" + user.id]]
          .map(([k, v]) => `<tr><td style="padding:6px 0;color:#56665F;width:120px">${k}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join("")}
      </table>`),
    text: `Plan purchased: ${user.shop_name} (${user.email}) paid ${amount}. Payment ${payment.payment_id}.`,
    replyTo: user.email,
  }));
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => { if (r.status === "rejected") console.error("[email error]", r.reason); });
}

// Trial or plan ending soon (stage "7" or "1"), or just ended ("0").
async function planNoticeEmail(user, stage, st, appUrl) {
  const price = `₹${Number(st.priceInr).toLocaleString("en-IN")} for ${st.months} months`;
  const what = st.state === "trial" || (!user.paid_until) ? "free trial" : "plan";
  const subject = stage === "0" ? `Your ${APP_NAME} ${what} has ended`
    : `Your ${APP_NAME} ${what} ends ${stage === "1" ? "tomorrow" : "in " + st.daysLeft + " days"}`;
  const body = stage === "0"
    ? `<p>Your ${what} for <b>${esc(user.shop_name)}</b> ended on ${esc(fmtDay(st.accessUntil))}. Your customers and ledger are safe, and you can still view them.</p>
       <p>To keep adding entries and sending reminders, subscribe for <b>${esc(price)}</b>.</p>`
    : `<p>Your ${what} for <b>${esc(user.shop_name)}</b> ends on <b>${esc(fmtDay(st.accessUntil))}</b>.</p>
       <p>Subscribe now for <b>${esc(price)}</b>. Your paid months start after the current period ends, so you don't lose any days.</p>`;
  return send({
    to: user.email, subject,
    html: layout(subject, body + button(appUrl + "/#/settings", "Subscribe in the app")),
    text: `${subject}. Subscribe for ${price}: ${appUrl}/#/settings`,
  });
}

module.exports = { configured, resendReady, listOutbox, OUTBOX, send, registrationEmails, passwordResetEmail, dailySummaryEmail, planPurchaseEmails, planNoticeEmail };
