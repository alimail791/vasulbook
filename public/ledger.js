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
    },
    te: {
      gentle: "నమస్కారం {name}, {shop} నుండి గుర్తు చేస్తున్నాం: మీ బకాయి మొత్తం {amt}. {pay} ధన్యవాదాలు!",
      due: "నమస్కారం {name}, {shop} లో మీ బకాయి {amt} ఈరోజు చెల్లించాలి. {pay} ధన్యవాదాలు.",
      firm: "నమస్కారం {name}, {shop} లో మీ బకాయి {amt} చెల్లింపు {days} రోజులు ఆలస్యమైంది. దయచేసి ఈరోజే చెల్లించండి. {pay} ఏదైనా సమస్య ఉంటే మాకు కాల్ చేయండి.",
      payLink: "ఇక్కడ చెల్లించండి: {link}", payUpi: "ఏ UPI యాప్ ద్వారా అయినా {upi} కి చెల్లించవచ్చు."
    },
    kn: {
      gentle: "ನಮಸ್ಕಾರ {name}, {shop} ಇಂದ ನೆನಪಿಸುತ್ತಿದ್ದೇವೆ: ನಿಮ್ಮ ಬಾಕಿ ಮೊತ್ತ {amt}. {pay} ಧನ್ಯವಾದಗಳು!",
      due: "ನಮಸ್ಕಾರ {name}, {shop} ನಲ್ಲಿ ನಿಮ್ಮ ಬಾಕಿ {amt} ಇಂದು ಪಾವತಿಸಬೇಕಾಗಿದೆ. {pay} ಧನ್ಯವಾದಗಳು.",
      firm: "ನಮಸ್ಕಾರ {name}, {shop} ನಲ್ಲಿ ನಿಮ್ಮ ಬಾಕಿ {amt} ಪಾವತಿ {days} ದಿನಗಳಿಂದ ತಡವಾಗಿದೆ. ದಯವಿಟ್ಟು ಇಂದೇ ಪಾವತಿಸಿ. {pay} ಏನಾದರೂ ಸಮಸ್ಯೆ ಇದ್ದರೆ ನಮಗೆ ಕರೆ ಮಾಡಿ.",
      payLink: "ಇಲ್ಲಿ ಪಾವತಿಸಿ: {link}", payUpi: "ಯಾವುದೇ UPI ಆ್ಯಪ್ ಮೂಲಕ {upi} ಗೆ ಪಾವತಿಸಬಹುದು."
    },
    ml: {
      gentle: "നമസ്കാരം {name}, {shop} ൽ നിന്നുള്ള ഓർമ്മപ്പെടുത്തൽ: നിങ്ങളുടെ ബാക്കി തുക {amt} ആണ്. {pay} നന്ദി!",
      due: "നമസ്കാരം {name}, {shop} ൽ നിങ്ങളുടെ ബാക്കി {amt} ഇന്ന് അടയ്ക്കേണ്ടതാണ്. {pay} നന്ദി.",
      firm: "നമസ്കാരം {name}, {shop} ൽ നിങ്ങളുടെ ബാക്കി {amt} അടയ്ക്കാൻ {days} ദിവസം വൈകി. ദയവായി ഇന്നുതന്നെ അടയ്ക്കുക. {pay} എന്തെങ്കിലും പ്രശ്നമുണ്ടെങ്കിൽ ഞങ്ങളെ വിളിക്കുക.",
      payLink: "ഇവിടെ പണമടയ്ക്കുക: {link}", payUpi: "ഏത് UPI ആപ്പ് വഴിയും {upi} ലേക്ക് പണമടയ്ക്കാം."
    },
    mr: {
      gentle: "नमस्कार {name}, {shop} कडून आठवण: तुमची थकबाकी {amt} आहे. {pay} धन्यवाद!",
      due: "नमस्कार {name}, {shop} येथील तुमची थकबाकी {amt} आज भरायची आहे. {pay} धन्यवाद.",
      firm: "नमस्कार {name}, {shop} येथील तुमची थकबाकी {amt} भरण्यास {days} दिवस उशीर झाला आहे. कृपया आजच भरा. {pay} काही अडचण असल्यास आम्हाला फोन करा.",
      payLink: "येथे पैसे भरा: {link}", payUpi: "कोणत्याही UPI ॲपने {upi} वर पैसे भरू शकता."
    },
    bn: {
      gentle: "নমস্কার {name}, {shop}-এর পক্ষ থেকে মনে করিয়ে দিচ্ছি: আপনার বকেয়া {amt}। {pay} ধন্যবাদ!",
      due: "নমস্কার {name}, {shop}-এ আপনার বকেয়া {amt} আজ পরিশোধ করার কথা। {pay} ধন্যবাদ।",
      firm: "নমস্কার {name}, {shop}-এ আপনার বকেয়া {amt} পরিশোধে {days} দিন দেরি হয়েছে। অনুগ্রহ করে আজই পরিশোধ করুন। {pay} কোনো সমস্যা হলে আমাদের ফোন করুন।",
      payLink: "এখানে পেমেন্ট করুন: {link}", payUpi: "যেকোনো UPI অ্যাপে {upi}-তে পেমেন্ট করতে পারেন।"
    },
    gu: {
      gentle: "નમસ્તે {name}, {shop} તરફથી યાદ અપાવીએ છીએ: તમારું બાકી {amt} છે. {pay} આભાર!",
      due: "નમસ્તે {name}, {shop} માં તમારું બાકી {amt} આજે ચૂકવવાનું છે. {pay} આભાર.",
      firm: "નમસ્તે {name}, {shop} માં તમારું બાકી {amt} ચૂકવવામાં {days} દિવસનો વિલંબ થયો છે. કૃપા કરીને આજે જ ચૂકવો. {pay} કોઈ મુશ્કેલી હોય તો અમને ફોન કરો.",
      payLink: "અહીં ચૂકવો: {link}", payUpi: "કોઈપણ UPI એપથી {upi} પર ચૂકવી શકો છો."
    },
    pa: {
      gentle: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}, {shop} ਵੱਲੋਂ ਯਾਦ ਦਿਵਾ ਰਹੇ ਹਾਂ: ਤੁਹਾਡਾ ਬਕਾਇਆ {amt} ਹੈ। {pay} ਧੰਨਵਾਦ!",
      due: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}, {shop} 'ਤੇ ਤੁਹਾਡਾ ਬਕਾਇਆ {amt} ਅੱਜ ਦੇਣਾ ਹੈ। {pay} ਧੰਨਵਾਦ।",
      firm: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ {name}, {shop} 'ਤੇ ਤੁਹਾਡਾ ਬਕਾਇਆ {amt} ਦੇਣ ਵਿੱਚ {days} ਦਿਨ ਦੀ ਦੇਰੀ ਹੋ ਗਈ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਅੱਜ ਹੀ ਭੁਗਤਾਨ ਕਰੋ। {pay} ਕੋਈ ਸਮੱਸਿਆ ਹੋਵੇ ਤਾਂ ਸਾਨੂੰ ਫ਼ੋਨ ਕਰੋ।",
      payLink: "ਇੱਥੇ ਭੁਗਤਾਨ ਕਰੋ: {link}", payUpi: "ਕਿਸੇ ਵੀ UPI ਐਪ ਨਾਲ {upi} 'ਤੇ ਭੁਗਤਾਨ ਕਰ ਸਕਦੇ ਹੋ।"
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
