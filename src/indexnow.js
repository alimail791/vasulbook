/* IndexNow: tells Bing, Yandex, Seznam and others about our public pages as soon as a new version starts,
   so new pages are crawled in hours instead of weeks. Google does not use IndexNow; submit the sitemap
   in Google Search Console for Google. */
const VBLang = require("../public/i18n/meta");
const guides = require("./guides");

const KEY = process.env.INDEXNOW_KEY || "a6062022d5c68c4a58887d0ad8b32788";
const pagePath = (c) => (c === "en" ? "/" : "/" + c);
const paths = () => [...VBLang.CODES.map(pagePath), ...guides.PATHS, "/contact", "/terms", "/privacy", "/refund-policy", "/delivery-policy"];

function mount(app) {
  app.get("/" + KEY + ".txt", (req, res) => res.type("text/plain").send(KEY));
}

async function ping(base) {
  if (!/^https:\/\//.test(base || "") || /localhost|railway\.app/.test(base) || process.env.INDEXNOW_OFF === "1") return;
  const host = new URL(base).host;
  try {
    const r = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key: KEY, keyLocation: base + "/" + KEY + ".txt", urlList: paths().map((p) => base + p) }),
    });
    console.log("[indexnow] submitted", paths().length, "urls:", r.status);
  } catch (e) { console.log("[indexnow] failed:", e.message); }
}

module.exports = { mount, ping, paths };
