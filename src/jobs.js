const cron = require("node-cron");
const { q } = require("./db");
const email = require("./email");
const ix = require("./integrations");
const Ledger = require("../public/ledger");

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

function start() {
  const opts = { timezone: "Asia/Kolkata" };
  cron.schedule("0 21 * * *", () => eveningSummaries().catch((e) => console.error("[summary job]", e)), opts);
  cron.schedule("30 10 * * *", () => autoReminders().catch((e) => console.error("[remind job]", e)), opts);
  // Clean up used or expired password reset tokens once a day.
  cron.schedule("15 3 * * *", () => q("DELETE FROM password_resets WHERE used OR expires_at < now()").catch(() => {}), opts);
}

module.exports = { start, eveningSummaries, autoReminders };
