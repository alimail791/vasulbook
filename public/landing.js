(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  // The installed app, and old app links like /#/home, go straight into the app.
  if (location.hash.startsWith("#/") || location.hash === "#register" || standalone()) {
    location.replace("/app" + location.search + (location.hash || "#/home"));
    return;
  }

  window.addEventListener("hashchange", () => { if (location.hash.startsWith("#/")) location.replace("/app" + location.hash); });

  const lang = document.body.dataset.lang || "en";
  const pagePath = (c) => (c === "en" ? "/" : "/" + c);
  const remember = (c) => { try { localStorage.setItem("vb_lang", c); } catch { /* ignore */ } };

  // A visitor who picked a language before lands on that language's page.
  try {
    const saved = localStorage.getItem("vb_lang");
    if (lang === "en" && location.pathname === "/" && saved && saved !== "en" && document.querySelector(`#langPick option[value="${saved}"]`)) {
      location.replace(pagePath(saved) + location.search + location.hash);
      return;
    }
  } catch { /* storage blocked */ }
  $("langPick").addEventListener("change", (e) => { remember(e.target.value); location.href = pagePath(e.target.value) + location.hash; });
  document.querySelectorAll(".l-foot-langs a").forEach((a) => a.addEventListener("click", () => remember(a.getAttribute("hreflang"))));

  // Referral links: /?ref=CODE. Remember the code and carry it into sign-up.
  let ref = "";
  try {
    const q = new URLSearchParams(location.search).get("ref");
    if (q) { ref = q.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12); localStorage.setItem("vb_ref", ref); history.replaceState(null, "", location.pathname); }
    else ref = localStorage.getItem("vb_ref") || "";
  } catch { /* storage blocked: still works without it */ }
  const startHref = "/app?lang=" + lang + (ref ? "&ref=" + encodeURIComponent(ref) : "") + "#register";
  document.querySelectorAll("[data-start]").forEach((a) => { a.href = startHref; });
  if (ref) { $("refCode").textContent = ref; $("refBanner").hidden = false; }

  // Prices and text are rendered by the server; only optional extras come from config.
  fetch("/api/config", { credentials: "same-origin" }).then((r) => r.json()).then((c) => {
    if (!c.whatsappChat) document.querySelectorAll("[data-wa]").forEach((el) => { el.hidden = true; });
    addYouTube(c.demoVideos || []);
  }).catch(() => {});

  // Already logged in? Header buttons go straight into the app.
  fetch("/api/me", { credentials: "same-origin" }).then((r) => {
    if (!r.ok) return;
    const label = $("loginLink").textContent;
    $("loginLink").hidden = true;
    document.querySelectorAll(".l-top [data-start]").forEach((a) => { a.removeAttribute("data-start"); a.href = "/app#/home"; a.textContent = label; });
  }).catch(() => {});

  // YouTube demos (set DEMO_VIDEOS on the server). Load the player only when tapped.
  function addYouTube(ids) {
    if (!ids.length) return;
    const box = $("videos");
    box.classList.add("many");
    ids.forEach((v) => {
      const fig = document.createElement("figure");
      fig.className = "l-video wide";
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "l-yt"; btn.setAttribute("aria-label", "Play " + (v.title || "VasulBook video"));
      const img = document.createElement("img");
      img.src = `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`; img.alt = ""; img.loading = "lazy";
      const play = document.createElement("span"); play.className = "play";
      btn.append(img, play);
      btn.addEventListener("click", () => {
        const f = document.createElement("iframe");
        f.src = `https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0`;
        f.title = v.title || "VasulBook video";
        f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
        f.allowFullscreen = true;
        btn.replaceWith(f);
      }, { once: true });
      const cap = document.createElement("figcaption"); cap.textContent = v.title || "VasulBook video";
      const wrap = document.createElement("div"); wrap.className = "l-yt-wrap"; wrap.style.width = "100%"; wrap.style.position = "relative"; wrap.style.aspectRatio = "16/9"; wrap.append(btn);
      fig.append(wrap, cap);
      box.append(fig);
    });
  }

  // Install as an app (PWA)
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; $("installBtn").hidden = false; });
  $("installBtn").addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt(); await deferred.userChoice.catch(() => {}); deferred = null; $("installBtn").hidden = true;
  });
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone()) $("iosHint").hidden = false;
})();
