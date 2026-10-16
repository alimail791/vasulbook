/* "Receive payment": every owner gets a public payment page (/p/CODE) with a UPI QR code.
   The QR is made from their UPI ID (with the amount filled in), or is the QR image they uploaded
   (PhonePe / GPay / Paytm business QR). */
const crypto = require("crypto");
const QRCode = require("qrcode");
const { q } = require("./db");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const inr = (n) => "₹" + (Math.round(Number(n) * 100) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const UPI_RE = /^[\w.\-]{2,}@[a-zA-Z]{2,}$/;
const MAX_IMG = 600 * 1024; // data URL length

const T = {
  en: { title: "Pay {shop}", due: "Amount to pay", scan: "Scan with any UPI app", or: "or", open: "Pay {amt} with a UPI app", openNoAmt: "Pay with a UPI app", upi: "UPI ID", copy: "Copy", copied: "Copied", apps: "Works with Google Pay, PhonePe, Paytm, BHIM and every bank UPI app.", after: "After paying, please share the payment screenshot with {shop}.", notset: "{shop} has not set up UPI payments yet. Please contact them directly.", enterAmt: "Enter the amount in your UPI app.", powered: "Payment page by VasulBook" },
  hi: { title: "{shop} को भुगतान करें", due: "भुगतान राशि", scan: "किसी भी UPI ऐप से स्कैन करें", or: "या", open: "UPI ऐप से {amt} भुगतान करें", openNoAmt: "UPI ऐप से भुगतान करें", upi: "UPI ID", copy: "कॉपी करें", copied: "कॉपी हो गया", apps: "Google Pay, PhonePe, Paytm, BHIM और हर बैंक के UPI ऐप से काम करता है।", after: "भुगतान के बाद कृपया स्क्रीनशॉट {shop} को भेजें।", notset: "{shop} ने अभी UPI भुगतान सेट नहीं किया है। कृपया उनसे सीधे संपर्क करें।", enterAmt: "अपने UPI ऐप में राशि डालें।", powered: "VasulBook द्वारा भुगतान पेज" },
  ta: { title: "{shop}-க்கு செலுத்துங்கள்", due: "செலுத்த வேண்டிய தொகை", scan: "எந்த UPI செயலியிலும் ஸ்கேன் செய்யுங்கள்", or: "அல்லது", open: "UPI செயலி மூலம் {amt} செலுத்துங்கள்", openNoAmt: "UPI செயலி மூலம் செலுத்துங்கள்", upi: "UPI ID", copy: "நகலெடு", copied: "நகலெடுக்கப்பட்டது", apps: "Google Pay, PhonePe, Paytm, BHIM மற்றும் எல்லா வங்கி UPI செயலிகளிலும் வேலை செய்யும்.", after: "செலுத்திய பிறகு, ஸ்கிரீன்ஷாட்டை {shop}-க்கு அனுப்புங்கள்.", notset: "{shop} இன்னும் UPI கட்டணத்தை அமைக்கவில்லை. நேரடியாகத் தொடர்பு கொள்ளுங்கள்.", enterAmt: "உங்கள் UPI செயலியில் தொகையை உள்ளிடுங்கள்.", powered: "VasulBook கட்டணப் பக்கம்" },
  te: { title: "{shop}కి చెల్లించండి", due: "చెల్లించాల్సిన మొత్తం", scan: "ఏ UPI యాప్‌తోనైనా స్కాన్ చేయండి", or: "లేదా", open: "UPI యాప్‌తో {amt} చెల్లించండి", openNoAmt: "UPI యాప్‌తో చెల్లించండి", upi: "UPI ID", copy: "కాపీ", copied: "కాపీ అయింది", apps: "Google Pay, PhonePe, Paytm, BHIM మరియు ప్రతి బ్యాంక్ UPI యాప్‌తో పనిచేస్తుంది.", after: "చెల్లించిన తర్వాత స్క్రీన్‌షాట్‌ను {shop}కి పంపండి.", notset: "{shop} ఇంకా UPI చెల్లింపులు సెట్ చేయలేదు. నేరుగా సంప్రదించండి.", enterAmt: "మీ UPI యాప్‌లో మొత్తాన్ని నమోదు చేయండి.", powered: "VasulBook చెల్లింపు పేజీ" },
  kn: { title: "{shop}ಗೆ ಪಾವತಿಸಿ", due: "ಪಾವತಿಸಬೇಕಾದ ಮೊತ್ತ", scan: "ಯಾವುದೇ UPI ಆ್ಯಪ್‌ನಲ್ಲಿ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ", or: "ಅಥವಾ", open: "UPI ಆ್ಯಪ್ ಮೂಲಕ {amt} ಪಾವತಿಸಿ", openNoAmt: "UPI ಆ್ಯಪ್ ಮೂಲಕ ಪಾವತಿಸಿ", upi: "UPI ID", copy: "ಕಾಪಿ", copied: "ಕಾಪಿ ಆಯಿತು", apps: "Google Pay, PhonePe, Paytm, BHIM ಮತ್ತು ಎಲ್ಲ ಬ್ಯಾಂಕ್ UPI ಆ್ಯಪ್‌ಗಳಲ್ಲಿ ಕೆಲಸ ಮಾಡುತ್ತದೆ.", after: "ಪಾವತಿಸಿದ ನಂತರ ಸ್ಕ್ರೀನ್‌ಶಾಟ್ ಅನ್ನು {shop}ಗೆ ಕಳುಹಿಸಿ.", notset: "{shop} ಇನ್ನೂ UPI ಪಾವತಿ ಹೊಂದಿಸಿಲ್ಲ. ನೇರವಾಗಿ ಸಂಪರ್ಕಿಸಿ.", enterAmt: "ನಿಮ್ಮ UPI ಆ್ಯಪ್‌ನಲ್ಲಿ ಮೊತ್ತ ನಮೂದಿಸಿ.", powered: "VasulBook ಪಾವತಿ ಪುಟ" },
  ml: { title: "{shop}-ന് പണമടയ്ക്കുക", due: "അടയ്ക്കേണ്ട തുക", scan: "ഏത് UPI ആപ്പിലും സ്കാൻ ചെയ്യുക", or: "അല്ലെങ്കിൽ", open: "UPI ആപ്പ് വഴി {amt} അടയ്ക്കുക", openNoAmt: "UPI ആപ്പ് വഴി അടയ്ക്കുക", upi: "UPI ID", copy: "കോപ്പി", copied: "കോപ്പി ചെയ്തു", apps: "Google Pay, PhonePe, Paytm, BHIM എന്നിവയിലും എല്ലാ ബാങ്ക് UPI ആപ്പുകളിലും പ്രവർത്തിക്കും.", after: "പണമടച്ച ശേഷം സ്ക്രീൻഷോട്ട് {shop}-ന് അയയ്ക്കുക.", notset: "{shop} ഇതുവരെ UPI പേയ്‌മെന്റ് സജ്ജമാക്കിയിട്ടില്ല. നേരിട്ട് ബന്ധപ്പെടുക.", enterAmt: "നിങ്ങളുടെ UPI ആപ്പിൽ തുക നൽകുക.", powered: "VasulBook പേയ്‌മെന്റ് പേജ്" },
  mr: { title: "{shop} ला पैसे भरा", due: "भरायची रक्कम", scan: "कोणत्याही UPI ॲपने स्कॅन करा", or: "किंवा", open: "UPI ॲपने {amt} भरा", openNoAmt: "UPI ॲपने पैसे भरा", upi: "UPI ID", copy: "कॉपी करा", copied: "कॉपी झाले", apps: "Google Pay, PhonePe, Paytm, BHIM आणि प्रत्येक बँकेच्या UPI ॲपवर चालते.", after: "पैसे भरल्यानंतर स्क्रीनशॉट {shop} ला पाठवा.", notset: "{shop} ने अजून UPI पेमेंट सेट केलेले नाही. कृपया थेट संपर्क करा.", enterAmt: "तुमच्या UPI ॲपमध्ये रक्कम टाका.", powered: "VasulBook पेमेंट पेज" },
  bn: { title: "{shop}-কে পেমেন্ট করুন", due: "পেমেন্টের পরিমাণ", scan: "যেকোনো UPI অ্যাপে স্ক্যান করুন", or: "অথবা", open: "UPI অ্যাপে {amt} পেমেন্ট করুন", openNoAmt: "UPI অ্যাপে পেমেন্ট করুন", upi: "UPI ID", copy: "কপি", copied: "কপি হয়েছে", apps: "Google Pay, PhonePe, Paytm, BHIM এবং সব ব্যাংকের UPI অ্যাপে চলে।", after: "পেমেন্টের পরে স্ক্রিনশট {shop}-কে পাঠান।", notset: "{shop} এখনও UPI পেমেন্ট সেট করেনি। সরাসরি যোগাযোগ করুন।", enterAmt: "আপনার UPI অ্যাপে পরিমাণ লিখুন।", powered: "VasulBook পেমেন্ট পেজ" },
  gu: { title: "{shop} ને ચૂકવો", due: "ચૂકવવાની રકમ", scan: "કોઈપણ UPI એપથી સ્કેન કરો", or: "અથવા", open: "UPI એપથી {amt} ચૂકવો", openNoAmt: "UPI એપથી ચૂકવો", upi: "UPI ID", copy: "કૉપિ", copied: "કૉપિ થયું", apps: "Google Pay, PhonePe, Paytm, BHIM અને દરેક બેંકની UPI એપમાં ચાલે છે.", after: "ચૂકવણી પછી સ્ક્રીનશૉટ {shop} ને મોકલો.", notset: "{shop} એ હજી UPI ચૂકવણી સેટ કરી નથી. સીધો સંપર્ક કરો.", enterAmt: "તમારી UPI એપમાં રકમ લખો.", powered: "VasulBook ચૂકવણી પેજ" },
  pa: { title: "{shop} ਨੂੰ ਭੁਗਤਾਨ ਕਰੋ", due: "ਭੁਗਤਾਨ ਦੀ ਰਕਮ", scan: "ਕਿਸੇ ਵੀ UPI ਐਪ ਨਾਲ ਸਕੈਨ ਕਰੋ", or: "ਜਾਂ", open: "UPI ਐਪ ਨਾਲ {amt} ਭੁਗਤਾਨ ਕਰੋ", openNoAmt: "UPI ਐਪ ਨਾਲ ਭੁਗਤਾਨ ਕਰੋ", upi: "UPI ID", copy: "ਕਾਪੀ", copied: "ਕਾਪੀ ਹੋ ਗਿਆ", apps: "Google Pay, PhonePe, Paytm, BHIM ਅਤੇ ਹਰ ਬੈਂਕ ਦੇ UPI ਐਪ ਨਾਲ ਚੱਲਦਾ ਹੈ।", after: "ਭੁਗਤਾਨ ਤੋਂ ਬਾਅਦ ਸਕ੍ਰੀਨਸ਼ਾਟ {shop} ਨੂੰ ਭੇਜੋ।", notset: "{shop} ਨੇ ਅਜੇ UPI ਭੁਗਤਾਨ ਸੈੱਟ ਨਹੀਂ ਕੀਤਾ। ਸਿੱਧਾ ਸੰਪਰਕ ਕਰੋ।", enterAmt: "ਆਪਣੇ UPI ਐਪ ਵਿੱਚ ਰਕਮ ਪਾਓ।", powered: "VasulBook ਭੁਗਤਾਨ ਪੇਜ" },
};

function amountFrom(v) {
  const n = Number(String(v || "").replace(/[^\d.]/g, ""));
  return n > 0 && n <= 1e7 ? Math.round(n * 100) / 100 : 0;
}
function upiLink(u, amt) {
  const p = new URLSearchParams({ pa: u.upi_id, pn: u.shop_name.slice(0, 40), cu: "INR" });
  if (amt) p.set("am", amt.toFixed(2));
  p.set("tn", `${u.shop_name.slice(0, 30)} via VasulBook`);
  return "upi://pay?" + p.toString().replace(/\+/g, "%20");
}
async function newCode() {
  for (;;) {
    const c = crypto.randomBytes(6).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
    if (c.length < 8) continue;
    const { rows } = await q("SELECT 1 FROM users WHERE pay_code=$1", [c]);
    if (!rows[0]) return c;
  }
}
async function ensureCode(u) {
  if (u.pay_code) return u.pay_code;
  const c = await newCode();
  await q("UPDATE users SET pay_code=$1 WHERE id=$2 AND pay_code IS NULL", [c, u.id]);
  const { rows } = await q("SELECT pay_code FROM users WHERE id=$1", [u.id]);
  return rows[0].pay_code;
}
async function byCode(code) {
  if (!/^[A-Za-z0-9]{8}$/.test(String(code || ""))) return null;
  const { rows } = await q(`SELECT u.id, u.shop_name, u.upi_id, u.reminder_lang, u.pay_code, (x.user_id IS NOT NULL) AS has_qr, x.updated_at AS qr_updated_at
     FROM users u LEFT JOIN user_qr x ON x.user_id = u.id WHERE u.pay_code=$1`, [code]);
  return rows[0] || null;
}

function page(u, amt, lang, base) {
  const t = T[lang] || T.en;
  const f = (s) => s.replace(/\{shop\}/g, esc(u.shop_name)).replace(/\{amt\}/g, esc(inr(amt)));
  const hasUpi = UPI_RE.test(u.upi_id || "");
  const qrSrc = u.has_qr ? `/p/${u.pay_code}/qr.img?v=${new Date(u.qr_updated_at || 0).getTime()}` : hasUpi ? `/p/${u.pay_code}/qr.svg${amt ? "?a=" + amt : ""}` : "";
  const deep = hasUpi ? upiLink(u, amt) : "";
  const body = !qrSrc ? `<p class="pp-note">${f(t.notset)}</p>` : `
    ${amt ? `<p class="eyebrow">${f(t.due)}</p><p class="pp-amt">${esc(inr(amt))}</p>` : ""}
    <figure class="pp-qr"><img src="${qrSrc}" alt="UPI QR code for ${esc(u.shop_name)}" width="260" height="260"><figcaption>${f(t.scan)}</figcaption></figure>
    ${u.has_qr && amt ? `<p class="small muted">${f(t.enterAmt)}</p>` : ""}
    ${deep ? `<p class="pp-or">${f(t.or)}</p><a class="btn primary block pp-open" href="${esc(deep)}">${amt ? f(t.open) : f(t.openNoAmt)}</a>` : ""}
    ${hasUpi ? `<div class="pp-upi"><span><span class="eyebrow">${f(t.upi)}</span><b id="upiId">${esc(u.upi_id)}</b></span><button class="btn sm" type="button" id="copyUpi" data-done="${esc(t.copied)}">${f(t.copy)}</button></div>` : ""}
    <p class="small muted">${f(t.apps)}</p>
    <p class="pp-note">${f(t.after)}</p>`;
  const langLinks = ["en", u.reminder_lang].filter((v, i, a) => v && T[v] && a.indexOf(v) === i && v !== lang)
    .map((l) => `<a href="?${amt ? "a=" + amt + "&" : ""}l=${l}">${l === "en" ? "English" : { hi: "हिन्दी", ta: "தமிழ்", te: "తెలుగు", kn: "ಕನ್ನಡ", ml: "മലയാളം", mr: "मराठी", bn: "বাংলা", gu: "ગુજરાતી", pa: "ਪੰਜਾਬੀ" }[l]}</a>`).join(" · ");
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${f(t.title)}${amt ? " · " + esc(inr(amt)) : ""}</title>
<meta property="og:title" content="${f(t.title)}${amt ? " · " + esc(inr(amt)) : ""}">
<meta property="og:description" content="${f(t.scan)}">
<meta property="og:image" content="${base}/og-image.png">
<meta name="theme-color" content="#2445B5">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="/pay.css">
</head>
<body class="pp">
<main class="pp-card card stack">
  <p class="pp-shop">${esc(u.shop_name)}</p>
  <h1>${f(t.title)}</h1>
  ${body}
  ${langLinks ? `<p class="small pp-langs">${langLinks}</p>` : ""}
</main>
<p class="small muted pp-foot"><a href="/">${f(t.powered)}</a></p>
<script src="/pay.js"></script>
</body>
</html>`;
}

module.exports = function mountPay(app, { auth, wrap, bad, baseUrl }) {
  // Owner: their payment page link and QR status
  app.get("/api/pay/me", auth, wrap(async (req, res) => {
    const code = await ensureCode(req.user);
    const base = baseUrl(req);
    const { rows } = await q("SELECT updated_at FROM user_qr WHERE user_id=$1", [req.user.id]);
    const hasQr = Boolean(rows[0]);
    res.json({ code, url: `${base}/p/${code}`, hasUpi: UPI_RE.test(req.user.upi_id || ""), hasQr,
      qrUrl: hasQr ? `/p/${code}/qr.img?v=${new Date(rows[0].updated_at).getTime()}` : `/p/${code}/qr.svg` });
  }));
  // Owner uploads their own QR (a resized image as a data URL)
  app.post("/api/pay/qr", auth, wrap(async (req, res) => {
    const img = String(req.body.image || "");
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) return bad(res, "Choose a photo of your QR code (JPG or PNG).");
    if (img.length > MAX_IMG) return bad(res, "That image is too big. Try a smaller photo or a screenshot.");
    await ensureCode(req.user);
    await q(`INSERT INTO user_qr (user_id, image, updated_at) VALUES ($1,$2,now())
             ON CONFLICT (user_id) DO UPDATE SET image=EXCLUDED.image, updated_at=now()`, [req.user.id, img]);
    res.json({ ok: true });
  }));
  app.delete("/api/pay/qr", auth, wrap(async (req, res) => {
    await q("DELETE FROM user_qr WHERE user_id=$1", [req.user.id]);
    res.json({ ok: true });
  }));

  // Public payment page for customers
  app.get("/p/:code", wrap(async (req, res) => {
    const u = await byCode(req.params.code);
    if (!u) return res.status(404).type("html").send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><p style="font-family:sans-serif;padding:24px">This payment link is not valid. Please ask the shop for a new one.</p>');
    const lang = T[req.query.l] ? req.query.l : T[u.reminder_lang] ? u.reminder_lang : "en";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.type("html").send(page(u, amountFrom(req.query.a), lang, baseUrl(req)));
  }));
  app.get("/p/:code/qr.svg", wrap(async (req, res) => {
    const u = await byCode(req.params.code);
    if (!u || !UPI_RE.test(u.upi_id || "")) return res.status(404).end();
    const svg = await QRCode.toString(upiLink(u, amountFrom(req.query.a)), { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#14211D", light: "#FFFFFF" } });
    res.setHeader("Cache-Control", "private, max-age=300");
    res.type("image/svg+xml").send(svg);
  }));
  app.get("/p/:code/qr.png", wrap(async (req, res) => {
    const u = await byCode(req.params.code);
    if (!u || !UPI_RE.test(u.upi_id || "")) return res.status(404).end();
    const buf = await QRCode.toBuffer(upiLink(u, amountFrom(req.query.a)), { type: "png", width: 720, margin: 3, errorCorrectionLevel: "M" });
    res.setHeader("Cache-Control", "private, max-age=300");
    res.type("png").send(buf);
  }));
  app.get("/p/:code/qr.img", wrap(async (req, res) => {
    if (!/^[A-Za-z0-9]{8}$/.test(req.params.code)) return res.status(404).end();
    const { rows } = await q("SELECT x.image FROM user_qr x JOIN users u ON u.id = x.user_id WHERE u.pay_code=$1", [req.params.code]);
    const m = rows[0] && /^data:(image\/[a-z]+);base64,(.+)$/.exec(rows[0].image || "");
    if (!m) return res.status(404).end();
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type(m[1]).send(Buffer.from(m[2], "base64"));
  }));
};
module.exports.UPI_RE = UPI_RE;
