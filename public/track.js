/* VasulBook visitor counter: anonymous, no cookies. Shared by the landing page and the app. */
(function (root) {
  "use strict";
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
  function visitor() {
    let v = get("vb_vid");
    if (!v || !/^[a-z0-9]{12,40}$/i.test(v)) {
      v = (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 24);
      set("vb_vid", v);
    }
    return v;
  }
  // Where this visitor first came from (kept 30 days), so a later sign-up is credited to it.
  function source() {
    const q = new URLSearchParams(location.search);
    const ref = document.referrer || "";
    const external = ref && !/vasulbook\.com|vasulbook-production\.up\.railway\.app|localhost/.test(ref);
    const now = { u: q.get("utm_source") || "", r: external ? ref.slice(0, 200) : "", c: q.get("ref") || "", t: Date.now() };
    let saved = null; try { saved = JSON.parse(get("vb_src") || "null"); } catch { /* ignore */ }
    if (now.u || now.r || now.c || !saved || Date.now() - (saved.t || 0) > 30 * 864e5) { set("vb_src", JSON.stringify(now)); return now; }
    return saved;
  }
  function send(e, path) {
    if (navigator.webdriver) return;
    const s = source();
    const body = JSON.stringify({ e, v: visitor(), p: path || location.pathname, u: s.u, r: s.r, c: s.c });
    try { fetch("/api/t", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true, credentials: "same-origin" }).catch(() => {}); } catch { /* ignore */ }
  }
  root.VBTrack = { send, source };
})(window);
