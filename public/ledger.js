/* Shared ledger maths for VasulBook. Runs in the browser (window.Ledger) and in Node (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const pad = (n) => String(n).padStart(2, "0");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Today's date in India (YYYY-MM-DD), whatever the device or server clock zone is.
  function todayIST(now) {
    const d = new Date((now || Date.now()) + 5.5 * 3600e3);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }
  const dayNum = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const addDays = (s, n) => { const t = new Date((dayNum(s) + n) * 864e5); return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1) + "-" + pad(t.getUTCDate()); };
  const fmtDate = (s) => { const [, m, d] = String(s).slice(0, 10).split("-").map(Number); return d + " " + MON.at(m - 1); };
  const inr = (n) => "₹" + Math.round(Math.abs(Number(n) || 0)).toLocaleString("en-IN");

  // entries: [{kind:'credit'|'payment', amount, date:'YYYY-MM-DD', due:'YYYY-MM-DD'|null, createdAt}]
  function compute(entries, today) {
    const t = today || todayIST();
    const list = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
    const credits = []; let bal = 0; const rows = [];
    for (const e of list) {
      const amt = Number(e.amount) || 0;
      if (e.kind === "credit") { credits.push({ e, left: amt, paidOn: null }); bal += amt; }
      else {
        bal -= amt; let rest = amt;
        for (const c of credits) {
          if (rest <= 0) break; if (c.left <= 0) continue;
          const take = Math.min(c.left, rest); c.left -= take; rest -= take;
          if (c.left <= 0.001) c.paidOn = e.date;
        }
      }
      rows.push({ e, bal });
    }
    const unpaid = credits.filter((c) => c.left > 0.001);
    const oldestDue = unpaid.map((c) => c.e.due || c.e.date).sort()[0] || null;
    const daysOver = oldestDue ? dayNum(t) - dayNum(oldestDue) : null;
    const overdueAmt = unpaid.filter((c) => (c.e.due || c.e.date) < t).reduce((s, c) => s + c.left, 0);
    let late = 0;
    for (const c of credits) { const due = c.e.due || c.e.date; if (c.paidOn ? c.paidOn > due : t > due) late++; }
    let status = "clear";
    if (bal > 0.001) status = daysOver > 0 ? "overdue" : daysOver >= -3 ? "due" : "open";
    const risk = late >= 3 ? "high" : late >= 1 ? "watch" : "good";
    return { rows, bal, oldestDue, daysOver, overdueAmt, late, status, risk, count: list.length };
  }

  function statusLabel(L) {
    if (L.status === "overdue") return "Overdue " + L.daysOver + " day" + (L.daysOver === 1 ? "" : "s");
    if (L.status === "due") return L.daysOver === 0 ? "Due today" : "Due in " + -L.daysOver + " day" + (L.daysOver === -1 ? "" : "s");
    if (L.status === "open") return "Due " + fmtDate(L.oldestDue);
    return L.bal < -0.001 ? "Advance " + inr(L.bal) : "All paid";
  }

  const TPL = {
    en: {
      gentle: "Hello {name}, a friendly reminder from {shop}: your pending balance is {amt}. {pay} Thank you!",
      due: "Hello {name}, your balance of {amt} at {shop} is due today. {pay} Thank you.",
      firm: "Hello {name}, your balance of {amt} at {shop} is overdue by {days} days. Please clear it today. {pay} Call us if there is any issue.",
      payLink: "Pay here: {link}", payUpi: "You can pay with any UPI app to {upi}."
    },
    ta: {
      gentle: "வணக்கம் {name}, {shop} நினைவூட்டல்: உங்கள் நிலுவைத் தொகை {amt}. {pay} நன்றி!",
      due: "வணக்கம் {name}, {shop} இல் உங்கள் {amt} தொகையை இன்று செலுத்த வேண்டும். {pay} நன்றி.",
      firm: "வணக்கம் {name}, {shop} இல் உங்கள் {amt} தொகை {days} நாட்கள் தாமதமாகியுள்ளது. இன்றே செலுத்தவும். {pay} ஏதேனும் சிக்கல் இருந்தால் எங்களை அழைக்கவும்.",
      payLink: "இங்கே செலுத்தவும்: {link}", payUpi: "எந்த UPI செயலி மூலமும் {upi} க்கு செலுத்தலாம்."
    },
    hi: {
      gentle: "नमस्ते {name}, {shop} की ओर से याद दिलाना: आपका बकाया {amt} है। {pay} धन्यवाद!",
      due: "नमस्ते {name}, {shop} पर आपका {amt} आज देय है। {pay} धन्यवाद।",
      firm: "नमस्ते {name}, {shop} पर आपका {amt} {days} दिन से बकाया है। कृपया आज ही भुगतान करें। {pay} कोई समस्या हो तो हमें कॉल करें।",
      payLink: "यहाँ भुगतान करें: {link}", payUpi: "आप किसी भी UPI ऐप से {upi} पर भुगतान कर सकते हैं।"
    }
  };
  const autoTone = (L) => (L.daysOver > 0 ? "firm" : L.daysOver === 0 ? "due" : "gentle");
  function reminder({ lang, tone, customerName, shop, upi, link, L }) {
    const T = TPL[lang] || TPL.en;
    const tn = !tone || tone === "auto" ? autoTone(L) : tone;
    const pay = link ? T.payLink.replace("{link}", link) : upi ? T.payUpi.replace("{upi}", upi) : "";
    return T[tn]
      .replaceAll("{name}", String(customerName || "").split(" ")[0])
      .replaceAll("{shop}", shop || "our shop")
      .replaceAll("{amt}", inr(L.bal))
      .replaceAll("{days}", String(Math.max(L.daysOver || 0, 1)))
      .replaceAll("{pay}", pay)
      .replace(/\s{2,}/g, " ").trim();
  }

  return { todayIST, dayNum, addDays, fmtDate, inr, compute, statusLabel, reminder, autoTone };
});
