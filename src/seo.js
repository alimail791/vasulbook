/* Search-friendly landing pages: one server-rendered page per language, plus sitemap.xml and robots.txt. */
const fs = require("fs");
const path = require("path");
const VBLang = require("../public/i18n/meta");
const billing = require("./billing");

const ROOT = path.join(__dirname, "..");
const TEMPLATE = fs.readFileSync(path.join(ROOT, "views", "landing.html"), "utf8");
const DICTS = {};
for (const c of VBLang.CODES) DICTS[c] = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "i18n", c + ".json"), "utf8")).landing || {};
const UPDATED = new Date().toISOString().slice(0, 10);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const pagePath = (c) => (c === "en" ? "/" : "/" + c);

// Fill {vars} into an already-escaped string, so the vars may carry markup we control.
const fillHtml = (str, vars) => esc(str).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));

function render(lang, base) {
  const d = DICTS[lang], en = DICTS.en;
  const P = billing.PLAN, R = billing.REFERRAL;
  const vars = {
    trial: P.trialMonths, price: inr(P.priceInr), months: P.months, pm: inr(P.priceInr / P.months), m: R.rewardMonths,
    code: "<code>Ravi 500 rice</code>",
  };
  const special = { ref_banner: { code: '<span class="amt" id="refCode"></span>', months: '<span id="refMonths">' + (P.trialMonths + R.friendBonusMonths) + "</span>" } };
  const text = (k) => fillHtml(d[k] ?? en[k] ?? k, { ...vars, ...(special[k] || {}) });
  const plain = (k) => VBLang.fill(d[k] ?? en[k] ?? k, { ...vars, code: "Ravi 500 rice" });

  const canonical = base + (lang === "en" ? "/" : pagePath(lang));
  const alternates = VBLang.LANGS.map((l) => `<link rel="alternate" hreflang="${l.code}" href="${base}${pagePath(l.code)}">`)
    .concat(`<link rel="alternate" hreflang="x-default" href="${base}/">`).join("\n");
  const langOptions = VBLang.LANGS.map((l) => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${esc(l.native)}</option>`).join("");
  const langLinks = VBLang.LANGS.map((l) => `<a href="${pagePath(l.code)}" hreflang="${l.code}" lang="${l.code}"${l.code === lang ? ' aria-current="page"' : ""}>${esc(l.native)}</a>`).join("");
  const meta = VBLang.LANGS.find((l) => l.code === lang);

  const jsonld = [
    {
      "@context": "https://schema.org", "@type": "SoftwareApplication", name: "VasulBook", url: canonical, inLanguage: lang,
      applicationCategory: "BusinessApplication", operatingSystem: "Web, Android, iOS",
      description: plain("meta_desc"), image: base + "/og-image.png",
      offers: { "@type": "Offer", price: String(P.priceInr), priceCurrency: "INR", description: plain("p_for") },
    },
    { "@context": "https://schema.org", "@type": "Organization", name: "VasulBook", url: base + "/", email: "info@vasulbook.in", logo: base + "/icons/icon-512.png" },
    {
      "@context": "https://schema.org", "@type": "FAQPage", inLanguage: lang,
      mainEntity: [1, 2, 3, 4, 5].map((i) => ({ "@type": "Question", name: plain("q" + i), acceptedAnswer: { "@type": "Answer", text: plain("a" + i) } })),
    },
  ];

  const raw = {
    lang, base, canonical, alternates, langOptions, langLinks, home: pagePath(lang),
    ogLocale: (meta.locale || "en-IN").replace("-", "_"),
    appHref: "/app?lang=" + lang, startHref: "/app?lang=" + lang + "#register",
    priceFmt: inr(P.priceInr), year: new Date().getFullYear(),
    jsonld: JSON.stringify(jsonld).replace(/</g, "\\u003c"),
  };
  return TEMPLATE
    .replace(/\{\{=(\w+)\}\}/g, (m, k) => (raw[k] !== undefined ? String(raw[k]) : ""))
    .replace(/\{\{(\w+)\}\}/g, (m, k) => text(k));
}

module.exports = function mountSeo(app, { baseUrl }) {
  const cache = new Map();
  const page = (lang, base) => {
    const key = lang + "|" + base;
    if (!cache.has(key)) cache.set(key, render(lang, base));
    return cache.get(key);
  };
  const send = (lang) => (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Language", lang);
    res.type("html").send(page(lang, baseUrl(req)));
  };
  app.get("/", send("en"));
  app.get("/en", (req, res) => res.redirect(301, "/"));
  for (const c of VBLang.CODES) if (c !== "en") app.get(["/" + c, "/" + c + "/"], send(c));

  app.get("/sitemap.xml", (req, res) => {
    const base = baseUrl(req);
    const alts = VBLang.CODES.map((c) => `    <xhtml:link rel="alternate" hreflang="${c}" href="${base}${pagePath(c)}"/>`)
      .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${base}/"/>`).join("\n");
    const urls = VBLang.CODES.map((c) => `  <url>\n    <loc>${base}${pagePath(c)}</loc>\n    <lastmod>${UPDATED}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${c === "en" ? "1.0" : "0.9"}</priority>\n${alts}\n  </url>`).join("\n");
    res.type("application/xml").setHeader("Cache-Control", "public, max-age=3600");
    res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`);
  });

  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").setHeader("Cache-Control", "public, max-age=3600");
    res.send(`User-agent: *\nAllow: /\nAllow: /app.css\nAllow: /app.js\nDisallow: /app\nDisallow: /admin\nDisallow: /api/\nDisallow: /dev/\nDisallow: /whatsapp\n\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
  });
};
module.exports.render = render;
