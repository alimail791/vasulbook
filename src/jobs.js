const cron = require("node-cron");
const { q } = require("./db");
const email = require("./email");
const ix = require("./integrations");
const Ledger = require("../public/ledger");
const billing = require("./billing");

const toEntry = (r) => ({ kind: r.kind, amount: r.amount, date: r.entry_date, due: r.due_date, createdAt: new Date(r.created_at).getTime() });

async function userLedgers(userId) {
  const [c, e] = await Promise.all([
    q("SELECT * FROM customers WHERE user_id=$1", [userId]),
    q("SELECT * FROM entries WHERE user_id=$1", [userId]),
  ]);
  const by = new Map();
  for (const r of e.rows) { if (!by.has(r.customer_id)) by.set(r.customer_id, []); by.get(r.customer_id).push(r); }
  return { customers: c.rows, entries: e.rows, ledgers: new Map(c.rows.map((x) => [x.id, Ledger.compute((by.get(x.id) || []).map(toEntry))])) };
}

// 9:00 pm IST: evening summary email to each owner who has it switched on and had any activity or dues.
async function eveningSummaries() {
  if (!email.configured()) return;
  const today = Ledger.todayIST();
  const { rows: users } = await q("SELECT * FROM users WHERE summary_email AND (last_summary_on IS NULL OR last_summary_on < $1)", [today]);
  for (const u of users) {
    if (!billing.status(u).active) continue;
    try {
      const { customers, entries, ledgers } = await userLedgers(u.id);
      const todays = entries.filter((e) => e.entry_date === today);
      const sum = (k) => todays.filter((e) => e.kind === k).reduce((s, e) => s + Number(e.amount), 0);
      let pending = 0;
      for (const L of ledgers.values()) if (L.bal > 0) pending += L.bal;
      if (!todays.length && pending < 1) continue;
      const overdue = customers.map((c) => ({ c, L: ledgers.get(c.id) })).filter((x) => x.L.status === "overdue")
        .sort((a, b) => b.L.overdueAmt - a.L.overdueAmt)
        .map((x) => ({ name: x.c.name, amount: Ledger.inr(x.L.overdueAmt), days: x.L.daysOver }));
      const r = await email.dailySummaryEmail(u, { collected: Ledger.inr(sum("payment")), credit: Ledger.inr(sum("credit")), pending: Ledger.inr(pending), overdue }, process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`);
      if (r && r.ok) await q("UPDATE users SET last_summary_on=$1 WHERE id=$2", [today, u.id]);
    } catch (err) { console.error(`[summary] user #${u.id}`, err.message); }
  }
}

// 10:30 am IST: automatic WhatsApp reminders (only when the WhatsApp Business API is configured).
// Reminds customers who are due today or overdue, at most once every 3 days each.
async function autoReminders() {
  if (!ix.whatsappConfigured()) return;
  const { rows: users } = await q("SELECT * FROM users WHERE auto_remind");
  for (const u of users) {
    if (!billing.status(u).active) continue;
    const { customers, ledgers } = await userLedgers(u.id);
    for (const c of customers) {
      const L = ledgers.get(c.id);
      if (!c.phone || L.bal < 1 || !(L.daysOver >= 0)) continue;
      if (c.last_reminder_at && Date.now() - new Date(c.last_reminder_at).getTime() < 3 * 864e5 - 3600e3) continue;
      try {
        await ix.sendWhatsAppReminder({
          to: c.phone, customerName: c.name.split(" ")[0], amount: Ledger.inr(L.bal), shopName: u.shop_name,
          payText: u.upi_id ? `Pay by UPI to ${u.upi_id}` : "",
        });
        await q("UPDATE customers SET last_reminder_at=now() WHERE id=$1", [c.id]);
      } catch (err) { console.error(`[auto-remind] customer #${c.id}`, err.message); }
    }
  }
}

// 10:00 am IST: tell owners 7 days and 1 day before their trial or plan ends, and on the day it ends.
async function planNotices() {
  const { rows: users } = await q(
    "SELECT * FROM users WHERE GREATEST(COALESCE(trial_ends_at, 'epoch'), COALESCE(paid_until, 'epoch')) BETWEEN now() - interval '3 days' AND now() + interval '7 days'");
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  for (const u of users) {
    const st = billing.status(u);
    const stage = !st.active ? "0" : st.daysLeft <= 1 ? "1" : "7";
    const key = `${String(st.accessUntil).slice(0, 10)}:${stage}`;
    if (u.plan_notice === key) continue;
    try {
      const r = await email.planNoticeEmail(u, stage, st, appUrl);
      if (r && r.ok) await q("UPDATE users SET plan_notice=$1 WHERE id=$2", [key, u.id]);
    } catch (err) { console.error(`[plan notice] user #${u.id}`, err.message); }
  }
}

// 11:00 am IST: one friendly email when an owner hasn't opened the app for 5 days.
// Sent once per absence: coming back and leaving again for 5 days sends one more.
async function inactiveNudges({ days = 5 } = {}) {
  if (!email.configured()) return;
  const { rows: users } = await q(
    `SELECT * FROM users WHERE email_verified AND last_active_at < now() - make_interval(days => $1)
       AND (inactive_notice_at IS NULL OR inactive_notice_at < last_active_at)`, [days]);
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  for (const u of users) {
    try {
      const { ledgers } = await userLedgers(u.id);
      let pending = 0, owing = 0, overdue = 0;
      for (const L of ledgers.values()) { if (L.bal > 0.5) { pending += L.bal; owing++; } if (L.status === "overdue") overdue++; }
      const st = billing.status(u);
      const away = Math.floor((Date.now() - new Date(u.last_active_at).getTime()) / 864e5);
      const planNote = !st.active ? "Your plan has ended. Subscribe in the app to start sending reminders again."
        : st.daysLeft <= 7 ? `Your ${st.state === "trial" ? "free trial" : "plan"} ends in ${st.daysLeft} day${st.daysLeft === 1 ? "" : "s"}.` : "";
      const r = await email.inactiveEmail(u, { days: away, pending, pendingText: Ledger.inr(pending), owing, overdue, planNote }, appUrl);
      if (r && r.ok) await q("UPDATE users SET inactive_notice_at=now() WHERE id=$1", [u.id]);
    } catch (err) { console.error(`[inactive] user #${u.id}`, err.message); }
  }
}

function start() {
  const opts = { timezone: "Asia/Kolkata" };
  cron.schedule("0 21 * * *", () => eveningSummaries().catch((e) => console.error("[summary job]", e)), opts);
  cron.schedule("30 10 * * *", () => autoReminders().catch((e) => console.error("[remind job]", e)), opts);
  cron.schedule("0 11 * * *", () => inactiveNudges().catch((e) => console.error("[inactive job]", e)), opts);
  cron.schedule("0 10 * * *", () => planNotices().catch((e) => console.error("[plan notice job]", e)), opts);
  // Clean up old email codes once a day.
  cron.schedule("15 3 * * *", () => q("DELETE FROM email_codes WHERE used OR expires_at < now() - interval '1 day'").catch(() => {}), opts);
}

module.exports = { start, eveningSummaries, autoReminders, planNotices, inactiveNudges };
