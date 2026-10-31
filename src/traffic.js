/* Visitor and sign-up counter.
   The landing page and app send a small "beacon" from the browser (bots that don't run JavaScript never do).
   No IP address is stored: each browser gets a random id, which we hash with a secret before saving. */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { q } = require("./db");

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|python|curl|wget|go-http|java\/|okhttp|axios|node-fetch|httpclient|libwww|scrapy|phantom|selenium|puppeteer|playwright|preview|facebookexternalhit|whatsapp\/|semrush|ahrefs|mj12|dataforseo|bytespider|gptbot|claude|perplexity|amazonbot|applebot|bingpreview|yandex|petal|gort/i;
const KINDS = ["view", "reg_open", "signup"];
const OWN = ["vasulbook.com", "vasulbook-production.up.railway.app", "localhost"];
const SOURCES = [
  [/google\./, "Google"], [/bing\.|duckduckgo|yahoo\.|ecosia/, "Other search"], [/whatsapp|wa\.me/, "WhatsApp"],
  [/facebook|fb\.com|fb\.me/, "Facebook"], [/instagram/, "Instagram"], [/youtube|youtu\.be/, "YouTube"],
  [/t\.co$|twitter|x\.com/, "X / Twitter"], [/linkedin|lnkd\.in/, "LinkedIn"], [/telegram|t\.me/, "Telegram"],
  [/yneet/, "yneet.in"], [/testmandi/, "testmandi.in"], [/classcoach/, "classcoach.in"],
  [/chatgpt|openai|claude\.ai|perplexity|gemini/, "AI assistants"],
];
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const clean = (s, n) => String(s || "").replace(/[^\w.\-:/ ]/g, "").trim().slice(0, n);

// Turn utm_source or the referring website into a readable source name.
function sourceOf(utm, ref, refCode) {
  const u = clean(utm, 40).toLowerCase();
  if (u) {
    for (const [re, name] of SOURCES) if (re.test(u)) return name;
    if (u === "vasulbook") return "Own sites";
    return u.slice(0, 30);
  }
  let host = "";
  try { host = new URL(ref).hostname.replace(/^www\./, "").toLowerCase(); } catch { /* none */ }
  if (host && !OWN.some((o) => host.endsWith(o))) {
    for (const [re, name] of SOURCES) if (re.test(host)) return name;
    return host.slice(0, 40);
  }
  return refCode ? "Referral link" : "Direct / typed";
}
function deviceOf(ua) {
  if (/ipad|tablet/i.test(ua)) return "Tablet";
  if (/mobi|android|iphone/i.test(ua)) return "Phone";
  return "Computer";
}

module.exports = function mountTraffic(app, { limit, secret, PROD }) {
  const hashId = (id) => crypto.createHmac("sha256", String(secret)).update("visitor:" + id).digest("hex").slice(0, 24);
  const isAdmin = (req) => { try { return jwt.verify(req.cookies.vb_admin || "", secret).admin; } catch { return false; } };

  app.post("/api/t", limit(240, 3600e3), async (req, res) => {
    res.status(204).end();
    try {
      const ua = String(req.get("user-agent") || "");
      if (!ua || BOT.test(ua) || isAdmin(req)) return;
      const b = req.body || {};
      const kind = KINDS.includes(b.e) ? b.e : null;
      const vid = /^[a-z0-9]{12,40}$/i.test(b.v || "") ? b.v : null;
      if (!kind || !vid) return;
      const path = clean(b.p, 40) || "/";
      const src = sourceOf(b.u, b.r, b.c);
      await q(`INSERT INTO site_visits (day, visitor, kind, path, source, device) VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (day, visitor, kind, path) DO NOTHING`,
      [todayIST(), hashId(vid), kind, path, src, deviceOf(ua)]);
    } catch (e) { if (!PROD) console.error("[traffic]", e.message); }
  });
};
module.exports.sourceOf = sourceOf;
module.exports.cleanSource = (s) => clean(s, 40);
module.exports.todayIST = todayIST;
