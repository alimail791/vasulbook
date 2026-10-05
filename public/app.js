(function () {
  "use strict";
  const L = window.Ledger;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const waNumber = (p) => { const d = digits(p); return d.length === 10 ? "91" + d : d; };
  const NOUN = { retail: "Customer", tuition: "Student", delivery: "Household", services: "Customer", wholesale: "Shop", rental: "Tenant", clinic: "Client" };
  // ---------------- languages ----------------
  const LANG = window.VBLang;
  const i18n = { lang: "en", d: {}, en: {} };
  const t = (k, v) => LANG.fill(i18n.d[k] ?? i18n.en[k] ?? k, v);
  const NOUN_KEY = { retail: "n_customer", tuition: "n_student", delivery: "n_household", services: "n_customer", wholesale: "n_shop", rental: "n_tenant", clinic: "n_client" };
  const nounPl = () => t(NOUN_KEY[state.user && state.user.businessType] || "n_customer");
  const loc = () => (LANG.LANGS.find((l) => l.code === i18n.lang) || {}).locale || "en-IN";
  const fd = (s) => (s ? new Date(String(s).slice(0, 10) + "T00:00:00Z").toLocaleDateString(loc(), { day: "numeric", month: "short", timeZone: "UTC" }) : "");
  async function fetchDict(code) { const r = await fetch(`/i18n/${code}.json`); if (!r.ok) throw new Error("lang"); return (await r.json()).app; }
  function initialLang() {
    const q = new URLSearchParams(location.search).get("lang");
    if (LANG.isLang(q)) return q;
    try { const s = localStorage.getItem("vb_lang"); if (LANG.isLang(s)) return s; } catch { /* ignore */ }
    return LANG.fromBrowser(navigator.languages || [navigator.language]);
  }
  async function setLang(code) {
    code = LANG.isLang(code) ? code : "en";
    if (!Object.keys(i18n.en).length) i18n.en = await fetchDict("en").catch(() => ({}));
    i18n.d = code === "en" ? i18n.en : await fetchDict(code).catch(() => i18n.en);
    i18n.lang = code;
    try { localStorage.setItem("vb_lang", code); } catch { /* ignore */ }
    document.documentElement.lang = code;
    applyI18n();
    if (state.user && !$("appScreen").hidden) { render(); if (state.view === "settings") fillSettings(); }
  }
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    $("quickHint").innerHTML = esc(t("quick_hint")).replace("{ex1}", "<code>Ravi 500 rice</code>").replace("{ex2}", "<code>Ravi paid 300</code>");
    if (state.user) $("vText").innerHTML = esc(t("verify_text")).replace("{email}", `<b>${esc(state.user.email)}</b>`);
    if (state.resetEmail) $("nText").innerHTML = esc(t("reset_sent")).replace("{email}", `<b>${esc(state.resetEmail)}</b>`);
    ["authLang", "sUiLang"].forEach((id) => { $(id).value = i18n.lang; });
  }
  (function fillLangSelects() {
    const ui = LANG.LANGS.map((l) => `<option value="${l.code}">${l.native}${l.code === "en" ? "" : " · " + l.name}</option>`).join("");
    $("authLang").innerHTML = ui; $("sUiLang").innerHTML = ui;
    $("remLang").innerHTML = ui; $("sLang").innerHTML = ui;
    const st = Object.keys(LANG.STATES).sort().map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    $("rState").insertAdjacentHTML("beforeend", st); $("sState").insertAdjacentHTML("beforeend", st);
  })();
  $("authLang").addEventListener("change", (e) => setLang(e.target.value));
  // Picking a state at sign-up switches the form to that state's language.
  $("rState").addEventListener("change", (e) => {
    const l = LANG.STATES[e.target.value];
    if (l && l !== i18n.lang) setLang(l);
  });
  function statusText(Lg) {
    if (Lg.status === "overdue") return Lg.daysOver === 1 ? t("st_overdue1") : t("st_overdue", { n: Lg.daysOver });
    if (Lg.status === "due") return Lg.daysOver === 0 ? t("st_due_today") : Lg.daysOver === -1 ? t("st_due_in1") : t("st_due_in", { n: -Lg.daysOver });
    if (Lg.status === "open") return t("st_due_on", { date: fd(Lg.oldestDue) });
    return Lg.bal < -0.001 ? t("st_advance", { amt: L.inr(Lg.bal) }) : t("st_all_paid");
  }
  const MODE_KEY = { Cash: "pm_cash", "Bank transfer": "pm_bank", Cheque: "pm_cheque" };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const state = {
    user: null, config: {}, customers: new Map(), entries: new Map(),
    sel: null, filter: "all", q: "", kind: "credit", payLinks: {}, view: "home",
  };
  const noun = () => NOUN[state.user && state.user.businessType] || "Customer";

  // ---------------- API ----------------
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method, credentials: "same-origin",
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error(navigator.onLine ? "Couldn't reach VasulBook. Check your connection and try again." : "You're offline. Connect to the internet and try again.");
      err.offline = true; throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith("/api/auth/")) { showAuth("login"); }
    if (res.status === 403 && data.code === "email_unverified" && state.user) { state.user.emailVerified = false; showVerify(); }
    if (res.status === 402 && state.user) {
      state.user.plan = { ...state.user.plan, active: false, state: "expired", daysLeft: 0 };
      renderPlan();
      if (state.view !== "settings") setTimeout(() => { location.hash = "#/settings"; }, 1200);
    }
    if (!res.ok) { const err = new Error(data.error || "Something went wrong. Please try again."); err.status = res.status; throw err; }
    return data;
  }

  // ---------------- toast & sheet ----------------
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2800);
  }
  async function copyText(text, el) {
    try { await navigator.clipboard.writeText(text); toast(t("t_copied")); }
    catch { if (el && el.select) { el.focus(); el.select(); } toast("Select the text and copy it."); }
  }
  let sheetState = null;
  function openSheet({ title, body, ok = "Save", onSubmit, extra }) {
    sheetState = { onSubmit, extra };
    $("sheetTitle").textContent = title;
    $("sheetBody").innerHTML = body;
    $("sheetErr").textContent = "";
    $("sheetOk").textContent = ok;
    const x = $("sheetExtra");
    x.hidden = !extra; if (extra) { x.textContent = extra.text; x.dataset.armed = ""; }
    $("sheet").hidden = false;
    const first = $("sheetBody").querySelector("input,select,textarea");
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeSheet() { $("sheet").hidden = true; sheetState = null; }
  $("sheetCancel").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
  $("sheetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sheetState) return;
    const btn = $("sheetOk"); btn.disabled = true;
    try { await sheetState.onSubmit(); closeSheet(); }
    catch (err) { $("sheetErr").textContent = err.message; }
    finally { btn.disabled = false; }
  });
  $("sheetExtra").addEventListener("click", async () => {
    const x = $("sheetExtra");
    if (!sheetState || !sheetState.extra) return;
    if (x.dataset.armed !== "1") { x.dataset.armed = "1"; x.textContent = sheetState.extra.confirm || "Tap again to confirm"; return; }
    try { await sheetState.extra.onClick(); closeSheet(); } catch (err) { $("sheetErr").textContent = err.message; }
  });

  // ---------------- auth screens ----------------
  const FORMS = ["loginForm", "registerForm", "forgotForm", "resetForm", "verifyForm"];
  function showAuth(which) {
    $("appScreen").hidden = true; $("authScreen").hidden = false;
    FORMS.forEach((id) => { $(id).hidden = true; });
    const tabs = which === "login" || which === "register";
    $("authTabs").hidden = !tabs;
    $("authTabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === which)));
    $(which + "Form").hidden = false;
  }
  $("authTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showAuth(b.dataset.tab); });
  $("toForgot").addEventListener("click", () => { $("fEmail").value = $("lEmail").value; showAuth("forgot"); });
  document.querySelectorAll("[data-back-login]").forEach((b) => b.addEventListener("click", () => { history.replaceState(null, "", "/app"); showAuth("login"); }));

  function busy(form, on) { form.querySelectorAll("button[type=submit]").forEach((b) => { b.disabled = on; }); }
  const codeOnly = (el) => el.addEventListener("input", () => { el.value = el.value.replace(/\D/g, "").slice(0, 6); });
  codeOnly($("vCode")); codeOnly($("nCode"));

  // A countdown on "Send a new code" so people don't hammer it.
  function cooldown(btn, secs = 60) {
    const label = t("send_new_code"); let left = secs; btn.disabled = true;
    const t = setInterval(() => {
      left--; btn.textContent = left > 0 ? `${label} (${left}s)` : label;
      if (left <= 0) { clearInterval(t); btn.disabled = false; }
    }, 1000);
    btn.textContent = `${label} (${left}s)`;
  }

  // Referral code from a shared link (?ref=VB123ABC), remembered until sign-up.
  function storedRef() { try { return localStorage.getItem("vb_ref") || ""; } catch { return ""; } }
  (function captureRef() {
    const ref = new URLSearchParams(location.search).get("ref");
    if (ref) {
      try { localStorage.setItem("vb_ref", ref.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)); } catch { /* ignore */ }
      history.replaceState(null, "", location.pathname + "#register");
    }
    if (storedRef()) $("rRef").value = storedRef();
  })();

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true); $("lErr").textContent = "";
    try { const d = await api("POST", "/api/auth/login", { email: $("lEmail").value, password: $("lPass").value }); $("lPass").value = ""; await enterApp(d.user); }
    catch (err) { $("lErr").textContent = err.message; }
    finally { busy(e.target, false); }
  });
  $("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true); $("rErr").textContent = "";
    try {
      const d = await api("POST", "/api/auth/register", {
        ownerName: $("rOwner").value, shopName: $("rShop").value, businessType: $("rType").value,
        phone: $("rPhone").value, email: $("rEmail").value, password: $("rPass").value, referralCode: $("rRef").value,
        state: $("rState").value, uiLang: i18n.lang,
      });
      $("rPass").value = "";
      try { localStorage.removeItem("vb_ref"); } catch { /* ignore */ }
      if (d.user.emailVerified) { await enterApp(d.user); }
      else { state.user = d.user; showVerify(true); }
    } catch (err) { $("rErr").textContent = err.message; }
    finally { busy(e.target, false); }
  });

  // ----- email confirmation with a 6-digit code -----
  function showVerify(justSent) {
    showAuth("verify");
    $("vText").innerHTML = esc(t("verify_text")).replace("{email}", `<b>${esc(state.user ? state.user.email : "")}</b>`);
    $("vCode").value = ""; $("vErr").textContent = ""; $("vChangeBox").hidden = true;
    if (justSent) cooldown($("vResend"));
    setTimeout(() => $("vCode").focus(), 50);
  }
  $("verifyForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true); $("vErr").textContent = "";
    try { const d = await api("POST", "/api/auth/verify-email", { code: $("vCode").value }); await enterApp(d.user); toast(t("t_welcome")); }
    catch (err) { $("vErr").textContent = err.message; $("vCode").select(); }
    finally { busy(e.target, false); }
  });
  $("vCode").addEventListener("input", () => { if ($("vCode").value.length === 6) $("verifyForm").requestSubmit(); });
  $("vResend").addEventListener("click", async () => {
    $("vErr").textContent = "";
    try { await api("POST", "/api/auth/resend-code", {}); toast("New code sent"); cooldown($("vResend")); }
    catch (err) { $("vErr").textContent = err.message; }
  });
  $("vChange").addEventListener("click", () => { $("vChangeBox").hidden = false; $("vNewEmail").value = state.user ? state.user.email : ""; $("vNewEmail").focus(); });
  $("vChangeSave").addEventListener("click", async () => {
    $("vErr").textContent = "";
    try { const d = await api("POST", "/api/auth/change-email", { email: $("vNewEmail").value }); state.user = d.user; showVerify(true); toast("Code sent to the new email"); }
    catch (err) { $("vErr").textContent = err.message; }
  });
  $("vLogout").addEventListener("click", () => $("logoutBtn").click());

  // ----- password reset with a 6-digit code -----
  async function requestReset(emailAddr) {
    await api("POST", "/api/auth/forgot", { email: emailAddr });
    state.resetEmail = emailAddr;
  }
  $("forgotForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true); $("fErr").textContent = "";
    try {
      await requestReset($("fEmail").value.trim());
      showAuth("reset"); $("nText").innerHTML = esc(t("reset_sent")).replace("{email}", `<b>${esc(state.resetEmail)}</b>`); $("nCode").value = ""; $("nPass").value = "";
      cooldown($("nResend")); setTimeout(() => $("nCode").focus(), 50);
    } catch (err) { $("fErr").textContent = err.message; }
    finally { busy(e.target, false); }
  });
  $("nResend").addEventListener("click", async () => {
    $("nErr").textContent = "";
    try { await requestReset(state.resetEmail); toast("New code sent"); cooldown($("nResend")); }
    catch (err) { $("nErr").textContent = err.message; }
  });
  $("resetForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true); $("nErr").textContent = "";
    try {
      const d = await api("POST", "/api/auth/reset", { email: state.resetEmail, code: $("nCode").value, password: $("nPass").value });
      $("nPass").value = "";
      history.replaceState(null, "", "/app#/home");
      await enterApp(d.user); toast("Password changed");
    } catch (err) { $("nErr").textContent = err.message; }
    finally { busy(e.target, false); }
  });

  async function enterApp(user) {
    state.user = user;
    if (user.uiLang && user.uiLang !== i18n.lang) await setLang(user.uiLang);
    if (!user.emailVerified) { showVerify(false); return; }
    $("authScreen").hidden = true; $("appScreen").hidden = false;
    if (!location.hash.startsWith("#/")) history.replaceState(null, "", "#/home");
    await loadData();
    route();
    maybeShowReferPopup();
  }

  async function loadData() {
    try {
      const d = await api("GET", "/api/data");
      state.customers = new Map(d.customers.map((c) => [c.id, c]));
      state.entries = new Map(d.entries.map((e) => [e.id, e]));
    } catch (err) { toast(err.message); }
  }

  // ---------------- ledger helpers ----------------
  function ledgerFor(cid) { return L.compute([...state.entries.values()].filter((e) => e.customerId === cid)); }
  function allLedgers() { const m = new Map(); for (const c of state.customers.values()) m.set(c.id, ledgerFor(c.id)); return m; }
  const riskLabel = (r) => (r === "high" ? t("risk_high") : r === "watch" ? t("risk_watch") : t("risk_good"));
  function ago(ms) { const d = Math.floor((Date.now() - ms) / 864e5); return d <= 0 ? t("today") : d === 1 ? t("yesterday") : t("days_ago", { n: d }); }

  function custRow(c, Lg, current) {
    return `<li><a class="cust" href="#/c/${c.id}" aria-current="${current}">
      <span class="nm">${esc(c.name)}</span><span class="amt">${Lg.bal > 0.001 ? L.inr(Lg.bal) : "₹0"}</span>
      <span class="meta"><span class="pill ${Lg.status}">${esc(statusText(Lg))}</span>${Lg.risk === "high" ? `<span class="pill risk-high">${esc(t("often_late"))}</span>` : ""}</span>
      <span class="meta r">${c.lastReminderAt ? esc(t("reminded_ago", { when: ago(c.lastReminderAt) })) : ""}</span>
    </a></li>`;
  }

  // ---------------- routing ----------------
  function route() {
    if (!state.user) return;
    const h = location.hash;
    let view = "home"; state.sel = null;
    const m = h.match(/^#\/c\/(\d+)/);
    if (m) { view = "customers"; state.sel = Number(m[1]); if (!state.customers.has(state.sel)) { state.sel = null; } }
    else if (h.startsWith("#/customers")) view = "customers";
    else if (h.startsWith("#/settings")) view = "settings";
    else if (h.startsWith("#/refer")) { view = "home"; setTimeout(openRefer, 50); }
    const changedView = view !== state.view;
    state.view = view;
    ["home", "customers", "settings"].forEach((v) => { $("view-" + v).hidden = v !== view; });
    document.querySelectorAll("[data-nav]").forEach((a) => { if (a.dataset.nav === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    if (view === "settings") fillSettings();
    render();
    if (view === "home") maybeShowReferPopup();
    if (changedView || m) window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);

  // ---------------- render ----------------
  function render() {
    if (!state.user) return;
    renderPlan();
    $("topShop").textContent = state.user.shopName;
    const n = noun(), nl = n.toLowerCase();
    const ledgers = allLedgers();
    if (state.view === "home") renderHome(ledgers, n, nl);
    if (state.view === "customers") renderCustomers(ledgers, n, nl);
  }

  function renderHome(ledgers, n, nl) {
    const today = L.todayIST();
    let pending = 0, owe = 0, od = 0, odCount = 0;
    for (const Lg of ledgers.values()) {
      if (Lg.bal > 0.001) { pending += Lg.bal; owe++; }
      if (Lg.overdueAmt > 0.001) { od += Lg.overdueAmt; odCount++; }
    }
    const todays = [...state.entries.values()].filter((e) => e.date === today);
    const col = todays.filter((e) => e.kind === "payment"), cr = todays.filter((e) => e.kind === "credit");
    const sum = (a) => a.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    $("tPending").textContent = L.inr(pending); $("tPendingSub").textContent = t("sub_owe", { n: owe });
    $("tCollected").textContent = L.inr(sum(col)); $("tCollectedSub").textContent = t("sub_payments", { n: col.length });
    $("tCredit").textContent = L.inr(sum(cr)); $("tCreditSub").textContent = t("sub_entries", { n: cr.length });
    $("tOverdue").textContent = L.inr(od); $("tOverdueSub").textContent = t("sub_people", { n: odCount });

    const chase = [...state.customers.values()].map((c) => ({ c, Lg: ledgers.get(c.id) }))
      .filter((x) => x.Lg.status === "overdue" || x.Lg.status === "due")
      .sort((a, b) => (a.Lg.status === b.Lg.status ? b.Lg.bal - a.Lg.bal : a.Lg.status === "overdue" ? -1 : 1)).slice(0, 6);
    $("chaseList").innerHTML = chase.length ? chase.map(({ c, Lg }) => custRow(c, Lg, false)).join("")
      : state.customers.size ? `<li class="empty"><strong>${esc(t("nobody_chase"))}</strong><span>${esc(t("nobody_chase_sub"))}</span></li>`
      : `<li class="empty"><strong>${esc(t("add_first"))}</strong><span>${esc(t("add_first_sub"))}</span></li>`;

    const top = [...state.customers.values()].map((c) => ({ c, Lg: ledgers.get(c.id) })).filter((x) => x.Lg.status === "overdue")
      .sort((a, b) => b.Lg.overdueAmt - a.Lg.overdueAmt).slice(0, 5);
    const text = [
      `${state.user.shopName} · ${fd(today)}`, "",
      `${t("sum_collected")}: ${L.inr(sum(col))}`, `${t("sum_credit")}: ${L.inr(sum(cr))}`, `${t("sum_pending")}: ${L.inr(pending)}`, "",
      top.length ? `${t("sum_overdue")}:` : t("sum_none"),
      ...top.map(({ c, Lg }) => `• ${c.name}: ${L.inr(Lg.overdueAmt)} (${Lg.daysOver === 1 ? t("st_overdue1") : t("st_overdue", { n: Lg.daysOver })})`),
    ].join("\n");
    $("sumText").textContent = text;
    const num = waNumber(state.user.phone);
    $("sumWa").href = num ? `https://wa.me/${num}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
    $("sumNote").textContent = state.user.summaryEmail && state.config.email ? t("sum_email_note", { email: state.user.email }) : "";
  }

  function renderCustomers(ledgers, n, nl) {
    $("listTitle").textContent = nounPl();
    $("fabAdd").textContent = t("add_fab");
    $("fabAdd").classList.toggle("hide", !!state.sel);
    $("backLink").textContent = `${t("back_all")} ${nounPl()}`;
    $("split").classList.toggle("has-sel", !!state.sel);
    const q = state.q.trim().toLowerCase(), qd = digits(q);
    const order = { overdue: 0, due: 1, open: 2, clear: 3 };
    const rows = [...state.customers.values()].map((c) => ({ c, Lg: ledgers.get(c.id) }))
      .filter(({ c, Lg }) => (!q || c.name.toLowerCase().includes(q) || (qd && digits(c.phone).includes(qd))) && (state.filter === "all" || Lg.status === state.filter))
      .sort((a, b) => order[a.Lg.status] - order[b.Lg.status] || b.Lg.bal - a.Lg.bal || a.c.name.localeCompare(b.c.name));
    $("listCount").textContent = t("total_count", { n: state.customers.size });
    const ul = $("custList");
    if (!state.customers.size) ul.innerHTML = `<li class="empty"><strong>${esc(t("no_people"))}</strong><span>${esc(t("no_people_sub"))}</span></li>`;
    else if (!rows.length) ul.innerHTML = `<li class="empty">${esc(t("no_match"))}</li>`;
    else ul.innerHTML = rows.map(({ c, Lg }) => custRow(c, Lg, c.id === state.sel)).join("");
    $("detailEmpty").hidden = !!state.sel;
    renderDetail(ledgers);
  }

  function renderDetail(ledgers) {
    const c = state.sel && state.customers.get(state.sel);
    if (!c) return;
    const Lg = ledgers.get(c.id);
    $("dName").textContent = c.name;
    $("dPhone").textContent = c.phone ? "+91 " + c.phone.replace(/(\d{5})(\d{5})/, "$1 $2") : t("no_wa_number");
    $("dPills").innerHTML = `<span class="pill ${Lg.status}">${esc(statusText(Lg))}</span>` + (Lg.count ? `<span class="pill risk-${Lg.risk}">${riskLabel(Lg.risk)}</span>` : "");
    $("dBal").textContent = L.inr(Lg.bal);
    $("dBal").style.color = Lg.bal > 0.001 ? (Lg.status === "overdue" ? "var(--bad)" : "var(--ink)") : "var(--good)";
    $("dBalLbl").textContent = Lg.bal < -0.001 ? t("paid_advance") : t("balance_due");
    $("lastRem").textContent = c.lastReminderAt ? t("last_reminded", { when: ago(c.lastReminderAt) }) : t("not_reminded");

    // Reminder text: keep the owner's own edits unless they switch customer, language or tone.
    const ta = $("remText");
    if (ta.dataset.for !== String(c.id)) { $("remLang").value = state.user.reminderLang || "en"; $("remTone").value = "auto"; }
    const auto = L.reminder({ lang: $("remLang").value, tone: $("remTone").value, customerName: c.name, shop: state.user.shopName, upi: state.user.upiId, link: state.payLinks[c.id], L: Lg });
    if (document.activeElement !== ta && (ta.dataset.for !== String(c.id) || ta.dataset.auto === ta.value || !ta.value)) { ta.value = auto; ta.dataset.auto = auto; ta.dataset.for = String(c.id); }
    updateWa(c, Lg);
    $("apiSend").hidden = !state.config.whatsappApi;
    $("payLinkBtn").hidden = !(state.user.razorpay && state.user.razorpay.connected) || !!state.payLinks[c.id];

    // Entry form defaults
    const f = $("entryForm");
    if (f.dataset.for !== String(c.id)) { f.dataset.for = String(c.id); $("eDue").value = L.addDays(L.todayIST(), state.user.defaultDays); $("eAmt").value = ""; $("eNote").value = ""; }

    const rows = Lg.rows.slice().reverse();
    $("ledger").innerHTML = rows.length ? rows.map(({ e, bal }) => `<li>
      <span class="dt">${fd(e.date)}</span>
      <span class="what">${e.kind === "credit" ? esc(e.note || t("entry_credit")) + (e.due ? `<div class="sub">${esc(t("due_on", { date: fd(e.due) }))}</div>` : "") : esc(t("entry_payment")) + (e.mode ? `<div class="sub">${esc(MODE_KEY[e.mode] ? t(MODE_KEY[e.mode]) : e.mode)}</div>` : "")}</span>
      <span class="fig"><span class="amt ${e.kind === "credit" ? "cr" : "pd"}">${e.kind === "credit" ? "+" : "−"}${L.inr(e.amount)}</span><span class="run">${esc(t("bal_short", { amt: (bal < -0.001 ? "−" : "") + L.inr(bal) }))}</span></span>
      <button class="btn ghost sm del" type="button" data-del="${e.id}">${esc(t("delete"))}</button>
    </li>`).join("") : `<li><span class="dt"></span><span class="what muted">${esc(t("no_entries"))}</span><span></span></li>`;
  }

  function updateWa(c, Lg) {
    const a = $("waLink"), note = $("remNote"), num = waNumber(c.phone);
    if (!num) { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); note.textContent = t("need_wa"); return; }
    a.href = `https://wa.me/${num}?text=${encodeURIComponent($("remText").value)}`;
    a.removeAttribute("aria-disabled");
    note.textContent = Lg.bal > 0.001 ? (state.user.upiId || state.payLinks[c.id] ? "" : t("upi_tip")) : t("nothing_due");
  }

  // ---------------- quick entry ----------------
  const PAY = ["paid", "pay", "payment", "received", "got", "jama", "vasul", "gave",
    "जमा", "दिया", "मिला", "भुगतान", "வரவு", "கொடுத்தார்", "செலுத்தினார்", "చెల్లించారు", "జమ", "ಪಾವತಿ", "ಜಮಾ", "അടച്ചു", "നൽകി", "भरले", "দিল", "জমা", "ચૂકવ્યા", "જમા", "ਜਮ੍ਹਾ", "ਦਿੱਤੇ"];
  const CREDIT = ["credit", "udhaar", "udhar", "baki", "kadan", "due"];
  function parseQuick(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const idx = words.findIndex((w) => /^₹?\d+(\.\d+)?$/.test(w.replace(/,/g, "")));
    if (idx < 0) return { error: t("err_amount") };
    const amount = Number(words[idx].replace(/[₹,]/g, ""));
    if (!(amount > 0)) return { error: "Amount must be above zero." };
    const skip = (w) => PAY.includes(w.toLowerCase()) || CREDIT.includes(w.toLowerCase());
    const kind = words.some((w) => PAY.includes(w.toLowerCase())) ? "payment" : "credit";
    const nameWords = words.slice(0, idx).filter((w) => !skip(w));
    const note = words.slice(idx + 1).filter((w) => !skip(w)).join(" ");
    if (!nameWords.length) return { error: t("err_name") };
    const typed = nameWords.join(" ").toLowerCase();
    const all = [...state.customers.values()];
    const match = all.find((c) => c.name.toLowerCase() === typed) || all.find((c) => c.name.toLowerCase().startsWith(typed))
      || all.find((c) => c.name.toLowerCase().split(/\s+/).some((p) => p.startsWith(typed)));
    return { amount, kind, note, match, newName: match ? null : nameWords.join(" ").replace(/\b\p{L}/gu, (m) => m.toUpperCase()) };
  }
  function showQuick() {
    const p = parseQuick($("quickInput").value), el = $("quickPreview");
    el.className = "preview";
    if (!p) { el.textContent = ""; return; }
    if (p.error) { el.textContent = p.error; el.classList.add("err"); return; }
    const who = p.match ? p.match.name : t("new_person", { name: p.newName });
    el.textContent = (p.kind === "credit" ? t("credit_to", { amt: L.inr(p.amount), who }) : t("payment_from", { amt: L.inr(p.amount), who })) + (p.note ? ` · ${p.note}` : "")
      + (p.kind === "credit" ? ` · ${t("due_word", { date: fd(L.addDays(L.todayIST(), state.user.defaultDays)) })}` : "");
    el.classList.add("ok");
  }
  $("quickInput").addEventListener("input", showQuick);
  $("quickForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = parseQuick($("quickInput").value);
    if (!p || p.error) { showQuick(); return; }
    busy(e.target, true);
    try {
      let cid = p.match && p.match.id;
      if (!cid) { const d = await api("POST", "/api/customers", { name: p.newName, phone: "" }); state.customers.set(d.customer.id, d.customer); cid = d.customer.id; }
      const d = await api("POST", "/api/entries", { customerId: cid, kind: p.kind, amount: p.amount, note: p.kind === "credit" ? p.note : "", mode: "UPI" });
      state.entries.set(d.entry.id, d.entry);
      $("quickInput").value = ""; showQuick(); render();
      toast(p.kind === "credit" ? t("t_credit_saved") : t("t_payment_saved"));
    } catch (err) { toast(err.message); }
    finally { busy(e.target, false); }
  });

  // ---------------- customers list events ----------------
  $("search").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    state.filter = b.dataset.f;
    document.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }));
  async function addCustomer(name, phone) {
    const d = await api("POST", "/api/customers", { name, phone });
    state.customers.set(d.customer.id, d.customer);
    location.hash = "#/c/" + d.customer.id;
    toast(`${d.customer.name} added`);
  }
  $("addInline").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true);
    try { await addCustomer($("aiName").value, $("aiPhone").value); $("aiName").value = ""; $("aiPhone").value = ""; }
    catch (err) { toast(err.message); }
    finally { busy(e.target, false); }
  });
  $("fabAdd").addEventListener("click", () => {
    const n = noun();
    openSheet({
      title: t("add_person"),
      body: `<label class="field">${esc(t("f_name"))}<input id="shName" required autocomplete="off"></label>
             <label class="field">${esc(t("f_whatsapp"))}<input id="shPhone" type="tel" inputmode="tel" placeholder="${esc(t("ph_mobile"))}" autocomplete="off"></label>`,
      ok: t("add"),
      onSubmit: () => addCustomer($("shName").value, $("shPhone").value),
    });
  });

  // ---------------- detail events ----------------
  $("editCust").addEventListener("click", () => {
    const c = state.customers.get(state.sel); if (!c) return;
    openSheet({
      title: t("edit_details"),
      body: `<label class="field">Name<input id="shName" required value="${esc(c.name)}"></label>
             <label class="field">WhatsApp number<input id="shPhone" type="tel" inputmode="tel" value="${esc(c.phone)}" placeholder="10-digit mobile"></label>`,
      onSubmit: async () => {
        const d = await api("PUT", "/api/customers/" + c.id, { name: $("shName").value, phone: $("shPhone").value });
        state.customers.set(c.id, d.customer); $("remText").dataset.for = ""; render(); toast(t("t_saved"));
      },
      extra: {
        text: "Delete " + noun().toLowerCase(), confirm: "Delete with all entries?",
        onClick: async () => {
          await api("DELETE", "/api/customers/" + c.id);
          state.customers.delete(c.id);
          for (const [id, e] of state.entries) if (e.customerId === c.id) state.entries.delete(id);
          location.hash = "#/customers"; toast("Deleted");
        },
      },
    });
  });

  ["remLang", "remTone"].forEach((id) => $(id).addEventListener("change", () => {
    const ta = $("remText"), c = state.customers.get(state.sel); if (!c) return;
    const Lg = ledgerFor(c.id);
    const auto = L.reminder({ lang: $("remLang").value, tone: $("remTone").value, customerName: c.name, shop: state.user.shopName, upi: state.user.upiId, link: state.payLinks[c.id], L: Lg });
    ta.value = auto; ta.dataset.auto = auto; updateWa(c, Lg);
  }));
  $("remText").addEventListener("input", () => { const c = state.customers.get(state.sel); if (c) updateWa(c, ledgerFor(c.id)); });
  async function markReminded() {
    const id = state.sel; if (!id) return;
    try { const d = await api("POST", `/api/customers/${id}/reminded`, {}); state.customers.set(id, d.customer); setTimeout(render, 400); } catch { /* not critical */ }
  }
  $("waLink").addEventListener("click", (e) => { if (!$("waLink").getAttribute("href")) { e.preventDefault(); return; } markReminded(); });
  $("copyRem").addEventListener("click", () => { copyText($("remText").value, $("remText")); markReminded(); });
  $("apiSend").addEventListener("click", async () => {
    const b = $("apiSend"); b.disabled = true;
    try { const d = await api("POST", `/api/customers/${state.sel}/send-reminder`, { link: state.payLinks[state.sel] || "" }); state.customers.set(state.sel, d.customer); render(); toast("Reminder sent on WhatsApp"); }
    catch (err) { toast(err.message); }
    finally { b.disabled = false; }
  });
  $("payLinkBtn").addEventListener("click", async () => {
    const b = $("payLinkBtn"); b.disabled = true;
    try {
      const d = await api("POST", `/api/customers/${state.sel}/paylink`, {});
      state.payLinks[state.sel] = d.url; $("remText").dataset.for = ""; render(); toast("Payment link added to the message");
    } catch (err) { toast(err.message); }
    finally { b.disabled = false; }
  });

  function setKind(k) {
    state.kind = k;
    $("entryForm").querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.k === k)));
    $("eDueWrap").hidden = k !== "credit"; $("eNoteWrap").hidden = k !== "credit";
    $("eModeWrap").hidden = k !== "payment"; $("eFull").hidden = k !== "payment";
    $("eSubmit").textContent = k === "credit" ? t("btn_add_credit") : t("btn_record_payment");
  }
  $("entryForm").querySelector(".seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setKind(b.dataset.k); });
  $("eFull").addEventListener("click", () => { const Lg = ledgerFor(state.sel); $("eAmt").value = Lg.bal > 0 ? String(Math.round(Lg.bal)) : ""; });
  $("entryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const amount = Number($("eAmt").value.replace(/[₹,\s]/g, ""));
    if (!(amount > 0)) { toast("Enter an amount above zero."); return; }
    busy(e.target, true);
    try {
      const body = { customerId: state.sel, kind: state.kind, amount };
      if (state.kind === "credit") { body.due = $("eDue").value; body.note = $("eNote").value; } else body.mode = $("eMode").value;
      const d = await api("POST", "/api/entries", body);
      state.entries.set(d.entry.id, d.entry);
      $("eAmt").value = ""; $("eNote").value = ""; $("remText").dataset.for = "";
      render(); toast(state.kind === "credit" ? "Credit added" : "Payment recorded");
    } catch (err) { toast(err.message); }
    finally { busy(e.target, false); }
  });
  $("ledger").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1"; b.textContent = t("confirm_delete"); b.style.color = "var(--bad)";
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ""; b.textContent = t("delete"); b.style.color = ""; } }, 3000);
      return;
    }
    try { await api("DELETE", "/api/entries/" + b.dataset.del); state.entries.delete(Number(b.dataset.del)); $("remText").dataset.for = ""; render(); toast("Entry deleted"); }
    catch (err) { toast(err.message); }
  });

  // ---------------- settings ----------------
  // ---------------- refer & earn ----------------
  function referLink() { const l = i18n.lang === "en" ? "/" : "/" + i18n.lang; return `${location.origin}${l}?ref=${encodeURIComponent(state.user.referralCode || "")}`; }
  function referMessage() {
    const r = state.config.referral || {};
    return t("refer_msg", { months: ((state.config.billing || {}).trialMonths || 3) + (r.friendBonusMonths || 0), link: referLink(), code: state.user.referralCode });
  }
  function fillReferTexts() {
    const r = state.config.referral || {}; const m = r.rewardMonths || 5, fb = r.friendBonusMonths || 0;
    const when = r.trigger === "payment" ? "subscribes" : "joins";
    $("rsBody").textContent = t("refer_body", { m, f: fb });
    $("referTitle").textContent = t("refer_title", { m });
    $("referCardTitle").textContent = t("refer_card_title", { m });
    $("referCardSub").textContent = t("refer_card_sub", { m });
    $("rsCode").textContent = state.user.referralCode || "";
    $("rsLink").value = referLink();
    $("rsWa").href = `https://wa.me/?text=${encodeURIComponent(referMessage())}`;
    $("rsShare").hidden = !navigator.share;
  }
  async function openRefer() {
    if (!state.user) return;
    fillReferTexts();
    $("referSheet").hidden = false;
    try {
      const d = await api("GET", "/api/referrals");
      $("rsJoined").textContent = d.joined; $("rsEarned").textContent = d.monthsEarned;
      $("rsFriends").hidden = !d.friends.length;
      $("rsFriends").innerHTML = d.friends.slice(0, 10).map((f) => `<li><span>${esc(f.shop)}<div class="sub">${new Date(f.joinedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</div></span><span class="small ${f.rewardMonths ? "" : "muted"}">${f.rewardMonths ? `+${f.rewardMonths}` : "…"}</span></li>`).join("");
    } catch { /* stats are optional */ }
  }
  function closeRefer() { $("referSheet").hidden = true; if (location.hash === "#/refer") history.replaceState(null, "", "#/home"); }
  // Once a day, on the dashboard: the popup reminds owners they can earn free months.
  function maybeShowReferPopup() {
    if (!state.user || !state.user.referralPopupDue || state.view !== "home" || state.referShownThisVisit) return;
    state.referShownThisVisit = true;
    setTimeout(() => {
      if (!$("sheet").hidden || state.view !== "home") return;
      openRefer();
      state.user.referralPopupDue = false;
      api("POST", "/api/referrals/popup-seen", {}).catch(() => {});
    }, 1500);
  }
  $("referCard").addEventListener("click", openRefer);
  $("rsClose").addEventListener("click", closeRefer);
  $("referSheet").addEventListener("click", (e) => { if (e.target === $("referSheet")) closeRefer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("referSheet").hidden) closeRefer(); });
  $("rsCopyCode").addEventListener("click", () => copyText(state.user.referralCode, null));
  $("rsCopyLink").addEventListener("click", () => copyText(referLink(), $("rsLink")));
  $("rsShare").addEventListener("click", () => { navigator.share({ title: "VasulBook", text: referMessage() }).catch(() => {}); });

  // ---------------- plan & subscription ----------------
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(loc(), { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "");
  const priceText = () => { const b = state.config.billing || {}; return `${L.inr(b.priceInr || 1000)} for ${b.months || 10} months`; };
  function renderPlan() {
    const p = state.user && state.user.plan; if (!p) return;
    const bar = $("planBar"), txt = $("planBarText"), btn = $("planBarBtn");
    bar.classList.remove("warn", "bad");
    // Top banner only for warnings: plan ended, or 14 days or less left.
    let show = p.state === "expired" || p.daysLeft <= 14;
    if (p.state === "expired") {
      bar.classList.add("bad");
      txt.textContent = p.paidUntil ? t("bar_plan_ended") : t("bar_trial_ended");
      btn.textContent = t("upgrade");
    } else if (p.state === "trial") {
      bar.classList.add("warn");
      txt.textContent = t("bar_trial", { n: p.daysLeft, date: fmtDay(p.accessUntil), price: L.inr((state.config.billing || {}).priceInr || 1000), months: (state.config.billing || {}).months || 10 });
      btn.textContent = t("upgrade");
    } else {
      bar.classList.add("warn");
      txt.textContent = t("bar_plan_ends", { n: p.daysLeft, date: fmtDay(p.accessUntil) });
      btn.textContent = t("renew");
    }

    // Dashboard upgrade card and top bar button
    const bl = state.config.billing || {};
    const perMonth = L.inr((bl.priceInr || 1000) / (bl.months || 10));
    const showCard = p.state !== "paid" || p.daysLeft <= 30;
    $("upgradeCard").hidden = !showCard;
    $("upgradeCard").classList.toggle("bad", p.state === "expired");
    if (showCard) {
      const pv = { n: p.daysLeft, price: L.inr(bl.priceInr || 1000), months: bl.months || 10, pm: perMonth, date: fmtDay(p.accessUntil) };
      $("upEyebrow").textContent = p.state === "expired" ? (p.paidUntil ? t("up_plan_ended") : t("up_trial_ended")) : p.state === "trial" ? t("up_trial_left", pv) : t("up_plan_ends", pv);
      $("upTitle").textContent = p.state === "expired" ? t("up_title_expired") : p.state === "trial" ? t("up_title_upgrade", pv) : t("up_title_renew", pv);
      $("upSub").textContent = p.state === "expired" ? t("up_sub_expired", pv) : t("up_sub", pv);
      $("upBtn").textContent = p.state === "paid" ? t("renew_now") : t("upgrade_now");
    }
    $("topUpgrade").hidden = p.state === "paid" && p.daysLeft > 30;
    $("topUpgrade").textContent = p.state === "paid" ? t("renew") : t("upgrade");
    bar.hidden = !show || state.view === "settings";
    document.body.classList.toggle("plan-locked", !p.active);

    // Settings card
    const b = state.config.billing || {};
    $("planPill").className = "pill " + (p.state === "expired" ? "overdue" : p.state === "paid" ? "clear" : "open");
    $("planPill").textContent = p.state === "expired" ? t("plan_ended") : p.state === "paid" ? t("plan_active") : t("plan_trial");
    const sv = { date: fmtDay(p.accessUntil), n: p.daysLeft };
    $("planStatus").textContent = p.state === "expired" ? t("plan_ended_on", sv) : p.state === "paid" ? t("plan_active_until", sv) : t("plan_trial_until", sv);
    $("planPrice").textContent = L.inr(b.priceInr || 1000);
    $("planPer").textContent = " " + t("for_months", { months: b.months || 10 });
    $("planOfferNote").textContent = p.state === "expired" ? t("offer_today") : t("offer_after", { date: fmtDay(p.accessUntil) });
    $("planBuy").textContent = p.state === "paid" ? t("renew_rzp") : t("subscribe_rzp");
    $("planBuy").hidden = !b.ready;
    $("planTestPay").hidden = !b.testMode;
    $("planTestExpire").hidden = !b.testMode;
    if (!b.ready && !b.testMode) $("planErr").textContent = "Online payment is being set up. Please check back soon.";
  }
  async function loadPlanHistory() {
    try {
      const d = await api("GET", "/api/subscription");
      state.user.plan = d.plan; renderPlan();
      $("planHistoryWrap").hidden = !d.payments.length;
      $("planHistory").innerHTML = d.payments.map((x) => `<li><span>${fmtDay(x.paidAt)}<div class="sub">${esc(x.paymentId || "")}</div></span><span><span class="amt">${L.inr(x.amount)}</span> <span class="muted small">· ${x.months} months</span></span></li>`).join("");
    } catch { /* offline: keep what we have */ }
  }
  let rzpLoading = null;
  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    if (!rzpLoading) rzpLoading = new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "https://checkout.razorpay.com/v1/checkout.js";
      sc.onload = () => resolve(); sc.onerror = () => { rzpLoading = null; reject(new Error("Couldn't load Razorpay. Check your internet and try again.")); };
      document.head.appendChild(sc);
    });
    return rzpLoading;
  }
  async function buyPlan() {
    const btn = $("planBuy"); btn.disabled = true; $("planErr").textContent = "";
    try {
      const [order] = await Promise.all([api("POST", "/api/subscription/order", {}), loadRazorpay()]);
      const rzp = new window.Razorpay({
        key: order.keyId, amount: order.amount, currency: order.currency, order_id: order.orderId,
        name: "VasulBook", description: `${order.months} months plan for ${order.shop}`,
        prefill: { name: order.name, email: order.email, contact: order.phone ? "+91" + order.phone : "" },
        notes: { shop: order.shop }, theme: { color: "#2445B5" },
        handler: async (resp) => {
          try {
            const d = await api("POST", "/api/subscription/verify", resp);
            state.user = d.user; renderPlan(); loadPlanHistory();
            toast(`Payment received. Plan active till ${fmtDay(d.user.plan.accessUntil)}`);
          } catch (err) { $("planErr").textContent = err.message; }
        },
        modal: { ondismiss: () => { btn.disabled = false; } },
      });
      rzp.on("payment.failed", (r) => { $("planErr").textContent = (r && r.error && r.error.description) || "Payment failed. No money was taken. Please try again."; });
      rzp.open();
    } catch (err) { $("planErr").textContent = err.message; }
    finally { setTimeout(() => { btn.disabled = false; }, 1500); }
  }
  $("planBuy").addEventListener("click", buyPlan);
  // Upgrade buttons on the dashboard: open the plan in Settings and start Razorpay checkout.
  function goUpgrade() {
    location.hash = "#/settings";
    setTimeout(() => {
      $("planCard").scrollIntoView({ block: "start" });
      if ((state.config.billing || {}).ready) buyPlan();
    }, 150);
  }
  $("planBarBtn").addEventListener("click", goUpgrade);
  $("upBtn").addEventListener("click", goUpgrade);
  $("topUpgrade").addEventListener("click", goUpgrade);
  $("planTestPay").addEventListener("click", async () => {
    try { const d = await api("POST", "/api/subscription/test-pay", {}); state.user = d.user; renderPlan(); loadPlanHistory(); toast("Test payment done. Plan extended."); }
    catch (err) { $("planErr").textContent = err.message; }
  });
  $("planTestExpire").addEventListener("click", async () => {
    try { const d = await api("POST", "/api/subscription/test-expire", {}); state.user = d.user; renderPlan(); toast("Trial ended (test). Try adding an entry."); }
    catch (err) { $("planErr").textContent = err.message; }
  });

  function fillSettings() {
    loadPlanHistory();
    const u = state.user;
    $("sShop").value = u.shopName; $("sOwner").value = u.ownerName; $("sType").value = u.businessType;
    $("sPhone").value = u.phone; $("sUpi").value = u.upiId; $("sDays").value = u.defaultDays; $("sLang").value = u.reminderLang;
    $("sSummary").checked = u.summaryEmail; $("sAuto").checked = u.autoRemind;
    $("sAutoWrap").hidden = !state.config.whatsappApi;
    $("sSummary").closest(".check").hidden = !state.config.email;
    $("rzpId").value = u.razorpay.keyId || ""; $("rzpSecret").value = ""; $("rzpHook").value = "";
    $("rzpStatus").textContent = u.razorpay.connected ? (u.razorpay.webhookSet ? "Connected. Payments are recorded automatically." : "Connected. Add the webhook secret so payments are recorded automatically.") : "Not connected.";
    $("rzpStatus").style.color = u.razorpay.connected ? "var(--good)" : "var(--muted)";
    $("rzpUrl").value = `${location.origin}/api/webhooks/razorpay/${u.id}`;
    $("rzpDisconnect").hidden = !u.razorpay.connected;
    $("accEmail").textContent = t("logged_in_as", { email: u.email });
    $("sUiLang").value = i18n.lang; $("sState").value = u.state || "";
  }
  async function saveSettings(body, errEl, okMsg) {
    errEl.textContent = "";
    try { const d = await api("PUT", "/api/settings", body); state.user = d.user; fillSettings(); render(); toast(okMsg); }
    catch (err) { errEl.textContent = err.message; }
  }
  $("bizForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true);
    await saveSettings({
      shopName: $("sShop").value, ownerName: $("sOwner").value, businessType: $("sType").value, phone: $("sPhone").value,
      upiId: $("sUpi").value, defaultDays: $("sDays").value, reminderLang: $("sLang").value,
      summaryEmail: $("sSummary").checked, autoRemind: $("sAuto").checked,
      uiLang: $("sUiLang").value, state: $("sState").value,
    }, $("bizErr"), t("t_saved"));
    if (state.user.uiLang !== i18n.lang) await setLang(state.user.uiLang);
    $("remText").dataset.for = "";
    busy(e.target, false);
  });
  $("rzpForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true);
    await saveSettings({ razorpay: { keyId: $("rzpId").value, keySecret: $("rzpSecret").value, webhookSecret: $("rzpHook").value } }, $("rzpErr"), "Razorpay saved");
    busy(e.target, false);
  });
  $("rzpDisconnect").addEventListener("click", () => saveSettings({ razorpay: { disconnect: true } }, $("rzpErr"), "Razorpay disconnected"));
  $("rzpCopy").addEventListener("click", () => copyText($("rzpUrl").value, $("rzpUrl")));
  $("sumCopy").addEventListener("click", () => copyText($("sumText").textContent, null));
  $("logoutBtn").addEventListener("click", async () => {
    try { await api("POST", "/api/auth/logout", {}); } catch { /* ignore */ }
    state.user = null; state.customers.clear(); state.entries.clear();
    if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage("clear-data");
    history.replaceState(null, "", "/app"); showAuth("login");
  });
  $("deleteAccBtn").addEventListener("click", () => {
    openSheet({
      title: "Delete your account?",
      body: `<p class="small">This permanently deletes your business, all ${noun().toLowerCase()}s and every ledger entry. It can't be undone.</p>
             <label class="field">Type your password to confirm<input id="shPass" type="password" autocomplete="current-password" required></label>`,
      ok: "Delete everything",
      onSubmit: async () => {
        await api("POST", "/api/account/delete", { password: $("shPass").value });
        state.user = null; location.href = "/"; toast("Your account was deleted.");
      },
    });
  });

  // ---------------- PWA: service worker, install, offline ----------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }
  let deferredPrompt = null;
  const dismissed = () => { try { return localStorage.getItem("vb_install_dismissed") === "1"; } catch { return false; } };
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); deferredPrompt = e;
    if (!dismissed() && !standalone()) { $("installCard").hidden = false; $("installBtn").hidden = false; }
  });
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (isIOS && !standalone() && !dismissed()) {
    $("installCard").hidden = false; $("installBtn").hidden = true;
    $("installText").textContent = "Install VasulBook: tap the Share button, then \"Add to Home Screen\".";
  }
  $("installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => {});
    deferredPrompt = null; $("installCard").hidden = true;
  });
  $("installDismiss").addEventListener("click", () => { $("installCard").hidden = true; try { localStorage.setItem("vb_install_dismissed", "1"); } catch { /* ignore */ } });
  window.addEventListener("appinstalled", () => { $("installCard").hidden = true; toast("VasulBook installed"); });
  const net = () => { $("offlineBar").hidden = navigator.onLine; };
  window.addEventListener("online", () => { net(); if (state.user) loadData().then(render); });
  window.addEventListener("offline", net);
  net();

  // Refresh when the app comes back to the foreground (another device may have added entries).
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.user && navigator.onLine) loadData().then(render); });

  // ---------------- boot ----------------
  (async function boot() {
    await setLang(initialLang());
    setKind("credit");
    try { state.config = await api("GET", "/api/config"); } catch { state.config = {}; }
    try { const d = await api("GET", "/api/me"); await enterApp(d.user); }
    catch (err) {
      if (err.offline) { toast(err.message); }
      showAuth(location.hash === "#register" || storedRef() ? "register" : "login");
    }
  })();
})();
