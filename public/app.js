(function () {
  "use strict";
  const L = window.Ledger;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const waNumber = (p) => { const d = digits(p); return d.length === 10 ? "91" + d : d; };
  const NOUN = { retail: "Customer", tuition: "Student", delivery: "Household", services: "Customer", wholesale: "Shop", rental: "Tenant", clinic: "Client" };
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
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
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
  function showAuth(which) {
    $("appScreen").hidden = true; $("authScreen").hidden = false;
    ["loginForm", "registerForm", "forgotForm", "resetForm"].forEach((id) => { $(id).hidden = true; });
    const tabs = which === "login" || which === "register";
    $("authTabs").hidden = !tabs;
    $("authTabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === which)));
    $(which + "Form").hidden = false;
  }
  $("authTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showAuth(b.dataset.tab); });
  $("toForgot").addEventListener("click", () => { $("fEmail").value = $("lEmail").value; showAuth("forgot"); });
  document.querySelectorAll("[data-back-login]").forEach((b) => b.addEventListener("click", () => { history.replaceState(null, "", "/"); showAuth("login"); }));

  function busy(form, on) { form.querySelectorAll("button[type=submit]").forEach((b) => { b.disabled = on; }); }

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
        phone: $("rPhone").value, email: $("rEmail").value, password: $("rPass").value,
      });
      $("rPass").value = "";
      await enterApp(d.user);
      toast("Welcome! Add your UPI ID in Settings.");
    } catch (err) { $("rErr").textContent = err.message; }
    finally { busy(e.target, false); }
  });
  $("forgotForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true); $("fErr").textContent = "";
    try { await api("POST", "/api/auth/forgot", { email: $("fEmail").value }); showAuth("login"); toast("If that email has an account, a reset link is on its way."); }
    catch (err) { $("fErr").textContent = err.message; }
    finally { busy(e.target, false); }
  });
  $("resetForm").addEventListener("submit", async (e) => {
    e.preventDefault(); busy(e.target, true); $("nErr").textContent = "";
    try {
      await api("POST", "/api/auth/reset", { token: state.resetToken, password: $("nPass").value });
      history.replaceState(null, "", "/#/home");
      const d = await api("GET", "/api/me"); await enterApp(d.user); toast("Password changed");
    } catch (err) { $("nErr").textContent = err.message; }
    finally { busy(e.target, false); }
  });

  async function enterApp(user) {
    state.user = user;
    $("authScreen").hidden = true; $("appScreen").hidden = false;
    if (!location.hash.startsWith("#/")) history.replaceState(null, "", "#/home");
    await loadData();
    route();
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
  const riskLabel = (r) => (r === "high" ? "Often pays late" : r === "watch" ? "Paid late before" : "Pays on time");
  function ago(ms) { const d = Math.floor((Date.now() - ms) / 864e5); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; }

  function custRow(c, Lg, current) {
    return `<li><a class="cust" href="#/c/${c.id}" aria-current="${current}">
      <span class="nm">${esc(c.name)}</span><span class="amt">${Lg.bal > 0.001 ? L.inr(Lg.bal) : "₹0"}</span>
      <span class="meta"><span class="pill ${Lg.status}">${esc(L.statusLabel(Lg))}</span>${Lg.risk === "high" ? `<span class="pill risk-high">Often late</span>` : ""}</span>
      <span class="meta r">${c.lastReminderAt ? "Reminded " + esc(ago(c.lastReminderAt)) : ""}</span>
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
    const changedView = view !== state.view;
    state.view = view;
    ["home", "customers", "settings"].forEach((v) => { $("view-" + v).hidden = v !== view; });
    document.querySelectorAll("[data-nav]").forEach((a) => { if (a.dataset.nav === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    if (view === "settings") fillSettings();
    render();
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
    const t = L.todayIST();
    let pending = 0, owe = 0, od = 0, odCount = 0;
    for (const Lg of ledgers.values()) {
      if (Lg.bal > 0.001) { pending += Lg.bal; owe++; }
      if (Lg.overdueAmt > 0.001) { od += Lg.overdueAmt; odCount++; }
    }
    const todays = [...state.entries.values()].filter((e) => e.date === t);
    const col = todays.filter((e) => e.kind === "payment"), cr = todays.filter((e) => e.kind === "credit");
    const sum = (a) => a.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    $("tPending").textContent = L.inr(pending); $("tPendingSub").textContent = `${plural(owe, nl)} owe`;
    $("tCollected").textContent = L.inr(sum(col)); $("tCollectedSub").textContent = plural(col.length, "payment");
    $("tCredit").textContent = L.inr(sum(cr)); $("tCreditSub").textContent = cr.length === 1 ? "1 entry" : `${cr.length} entries`;
    $("tOverdue").textContent = L.inr(od); $("tOverdueSub").textContent = plural(odCount, nl);

    const chase = [...state.customers.values()].map((c) => ({ c, Lg: ledgers.get(c.id) }))
      .filter((x) => x.Lg.status === "overdue" || x.Lg.status === "due")
      .sort((a, b) => (a.Lg.status === b.Lg.status ? b.Lg.bal - a.Lg.bal : a.Lg.status === "overdue" ? -1 : 1)).slice(0, 6);
    $("chaseList").innerHTML = chase.length ? chase.map(({ c, Lg }) => custRow(c, Lg, false)).join("")
      : state.customers.size ? `<li class="empty"><strong>Nobody to chase today</strong><span>No ${nl}s are due or overdue.</span></li>`
      : `<li class="empty"><strong>Add your first ${nl}</strong><span>Use quick entry above, or go to ${n}s.</span></li>`;

    const top = [...state.customers.values()].map((c) => ({ c, Lg: ledgers.get(c.id) })).filter((x) => x.Lg.status === "overdue")
      .sort((a, b) => b.Lg.overdueAmt - a.Lg.overdueAmt).slice(0, 5);
    const text = [
      `${state.user.shopName} · ${L.fmtDate(t)}`, "",
      `Collected today: ${L.inr(sum(col))}`, `New credit today: ${L.inr(sum(cr))}`, `Total pending: ${L.inr(pending)}`, "",
      top.length ? `Overdue ${nl}s:` : `No overdue ${nl}s. Well done!`,
      ...top.map(({ c, Lg }) => `• ${c.name}: ${L.inr(Lg.overdueAmt)} (${plural(Lg.daysOver, "day")})`),
    ].join("\n");
    $("sumText").textContent = text;
    const num = waNumber(state.user.phone);
    $("sumWa").href = num ? `https://wa.me/${num}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
    $("sumNote").textContent = state.user.summaryEmail && state.config.email ? `This is also emailed to ${state.user.email} at 9 pm.` : "";
  }

  function renderCustomers(ledgers, n, nl) {
    $("listTitle").textContent = n + "s";
    $("aiName").placeholder = n + " name";
    $("fabAdd").textContent = "+ Add " + nl;
    $("fabAdd").classList.toggle("hide", !!state.sel);
    $("backLink").textContent = "← All " + nl + "s";
    $("split").classList.toggle("has-sel", !!state.sel);
    const q = state.q.trim().toLowerCase(), qd = digits(q);
    const order = { overdue: 0, due: 1, open: 2, clear: 3 };
    const rows = [...state.customers.values()].map((c) => ({ c, Lg: ledgers.get(c.id) }))
      .filter(({ c, Lg }) => (!q || c.name.toLowerCase().includes(q) || (qd && digits(c.phone).includes(qd))) && (state.filter === "all" || Lg.status === state.filter))
      .sort((a, b) => order[a.Lg.status] - order[b.Lg.status] || b.Lg.bal - a.Lg.bal || a.c.name.localeCompare(b.c.name));
    $("listCount").textContent = `${state.customers.size} total`;
    const ul = $("custList");
    if (!state.customers.size) ul.innerHTML = `<li class="empty"><strong>No ${nl}s yet</strong><span>Add the people who owe you money, with their WhatsApp numbers.</span></li>`;
    else if (!rows.length) ul.innerHTML = `<li class="empty">No matches.</li>`;
    else ul.innerHTML = rows.map(({ c, Lg }) => custRow(c, Lg, c.id === state.sel)).join("");
    $("detailEmpty").hidden = !!state.sel;
    renderDetail(ledgers);
  }

  function renderDetail(ledgers) {
    const c = state.sel && state.customers.get(state.sel);
    if (!c) return;
    const Lg = ledgers.get(c.id);
    $("dName").textContent = c.name;
    $("dPhone").textContent = c.phone ? "+91 " + c.phone.replace(/(\d{5})(\d{5})/, "$1 $2") : "No WhatsApp number";
    $("dPills").innerHTML = `<span class="pill ${Lg.status}">${esc(L.statusLabel(Lg))}</span>` + (Lg.count ? `<span class="pill risk-${Lg.risk}">${riskLabel(Lg.risk)}</span>` : "");
    $("dBal").textContent = L.inr(Lg.bal);
    $("dBal").style.color = Lg.bal > 0.001 ? (Lg.status === "overdue" ? "var(--bad)" : "var(--ink)") : "var(--good)";
    $("dBalLbl").textContent = Lg.bal < -0.001 ? "paid in advance" : "balance due";
    $("lastRem").textContent = c.lastReminderAt ? `Last reminded ${ago(c.lastReminderAt)}` : "Not reminded yet";

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
      <span class="dt">${L.fmtDate(e.date)}</span>
      <span class="what">${e.kind === "credit" ? esc(e.note || "Credit") + (e.due ? `<div class="sub">Due ${L.fmtDate(e.due)}</div>` : "") : "Payment" + (e.mode ? `<div class="sub">${esc(e.mode)}</div>` : "")}</span>
      <span class="fig"><span class="amt ${e.kind === "credit" ? "cr" : "pd"}">${e.kind === "credit" ? "+" : "−"}${L.inr(e.amount)}</span><span class="run">Bal ${bal < -0.001 ? "−" : ""}${L.inr(bal)}</span></span>
      <button class="btn ghost sm del" type="button" data-del="${e.id}">Delete</button>
    </li>`).join("") : `<li><span class="dt"></span><span class="what muted">No entries yet. Add credit or a payment above.</span><span></span></li>`;
  }

  function updateWa(c, Lg) {
    const a = $("waLink"), note = $("remNote"), num = waNumber(c.phone);
    if (!num) { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); note.textContent = "Add a WhatsApp number to send reminders."; return; }
    a.href = `https://wa.me/${num}?text=${encodeURIComponent($("remText").value)}`;
    a.removeAttribute("aria-disabled");
    note.textContent = Lg.bal > 0.001 ? (state.user.upiId || state.payLinks[c.id] ? "" : "Tip: add your UPI ID in Settings so customers can pay at once.") : "Nothing is due right now.";
  }

  // ---------------- quick entry ----------------
  const PAY = ["paid", "pay", "payment", "received", "got", "jama", "vasul", "gave"];
  const CREDIT = ["credit", "udhaar", "udhar", "baki", "kadan", "due"];
  function parseQuick(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const idx = words.findIndex((w) => /^₹?\d+(\.\d+)?$/.test(w.replace(/,/g, "")));
    if (idx < 0) return { error: "Add an amount, like 500." };
    const amount = Number(words[idx].replace(/[₹,]/g, ""));
    if (!(amount > 0)) return { error: "Amount must be above zero." };
    const skip = (w) => PAY.includes(w.toLowerCase()) || CREDIT.includes(w.toLowerCase());
    const kind = words.some((w) => PAY.includes(w.toLowerCase())) ? "payment" : "credit";
    const nameWords = words.slice(0, idx).filter((w) => !skip(w));
    const note = words.slice(idx + 1).filter((w) => !skip(w)).join(" ");
    if (!nameWords.length) return { error: "Start with the name." };
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
    const who = p.match ? p.match.name : `${p.newName} (new ${noun().toLowerCase()})`;
    el.textContent = (p.kind === "credit" ? `Credit ${L.inr(p.amount)} to ${who}` : `Payment ${L.inr(p.amount)} from ${who}`) + (p.note ? ` · ${p.note}` : "")
      + (p.kind === "credit" ? ` · due ${L.fmtDate(L.addDays(L.todayIST(), state.user.defaultDays))}` : "");
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
      toast(p.kind === "credit" ? "Credit saved" : "Payment saved");
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
      title: `Add ${n.toLowerCase()}`,
      body: `<label class="field">Name<input id="shName" required autocomplete="off"></label>
             <label class="field">WhatsApp number<input id="shPhone" type="tel" inputmode="tel" placeholder="10-digit mobile" autocomplete="off"></label>`,
      ok: "Add",
      onSubmit: () => addCustomer($("shName").value, $("shPhone").value),
    });
  });

  // ---------------- detail events ----------------
  $("editCust").addEventListener("click", () => {
    const c = state.customers.get(state.sel); if (!c) return;
    openSheet({
      title: "Edit details",
      body: `<label class="field">Name<input id="shName" required value="${esc(c.name)}"></label>
             <label class="field">WhatsApp number<input id="shPhone" type="tel" inputmode="tel" value="${esc(c.phone)}" placeholder="10-digit mobile"></label>`,
      onSubmit: async () => {
        const d = await api("PUT", "/api/customers/" + c.id, { name: $("shName").value, phone: $("shPhone").value });
        state.customers.set(c.id, d.customer); $("remText").dataset.for = ""; render(); toast("Saved");
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
    $("eSubmit").textContent = k === "credit" ? "Add credit" : "Record payment";
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
      b.dataset.armed = "1"; b.textContent = "Confirm delete"; b.style.color = "var(--bad)";
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ""; b.textContent = "Delete"; b.style.color = ""; } }, 3000);
      return;
    }
    try { await api("DELETE", "/api/entries/" + b.dataset.del); state.entries.delete(Number(b.dataset.del)); $("remText").dataset.for = ""; render(); toast("Entry deleted"); }
    catch (err) { toast(err.message); }
  });

  // ---------------- settings ----------------
  // ---------------- plan & subscription ----------------
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "");
  const priceText = () => { const b = state.config.billing || {}; return `${L.inr(b.priceInr || 1000)} for ${b.months || 10} months`; };
  function renderPlan() {
    const p = state.user && state.user.plan; if (!p) return;
    const bar = $("planBar"), txt = $("planBarText"), btn = $("planBarBtn");
    bar.classList.remove("warn", "bad");
    let show = true;
    if (p.state === "expired") {
      bar.classList.add("bad");
      txt.textContent = (p.paidUntil ? "Your plan has ended." : "Your free trial has ended.") + " Your data is safe. Subscribe to keep adding entries and sending reminders.";
      btn.textContent = "Subscribe";
    } else if (p.state === "trial") {
      if (p.daysLeft <= 14) bar.classList.add("warn");
      txt.textContent = `Free trial: ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} left (until ${fmtDay(p.accessUntil)}). Then ${priceText()}.`;
      btn.textContent = "Subscribe";
    } else {
      show = p.daysLeft <= 14;
      if (show) bar.classList.add("warn");
      txt.textContent = `Your plan ends in ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} (${fmtDay(p.accessUntil)}).`;
      btn.textContent = "Renew";
    }
    bar.hidden = !show || state.view === "settings";
    document.body.classList.toggle("plan-locked", !p.active);

    // Settings card
    const b = state.config.billing || {};
    $("planPill").className = "pill " + (p.state === "expired" ? "overdue" : p.state === "paid" ? "clear" : "open");
    $("planPill").textContent = p.state === "expired" ? "Ended" : p.state === "paid" ? "Active" : "Free trial";
    $("planStatus").textContent = p.state === "expired" ? `Ended on ${fmtDay(p.accessUntil)}. You can still view your ledger.`
      : p.state === "paid" ? `Active until ${fmtDay(p.accessUntil)} (${p.daysLeft} days left).`
      : `Free trial until ${fmtDay(p.accessUntil)} (${p.daysLeft} days left).`;
    $("planPrice").textContent = L.inr(b.priceInr || 1000);
    $("planPer").textContent = ` for ${b.months || 10} months`;
    $("planOfferNote").textContent = p.state === "expired" ? "Starts today. Pay by UPI, card, net banking or wallet."
      : `Starts after ${fmtDay(p.accessUntil)}, so you don't lose any days. Pay by UPI, card, net banking or wallet.`;
    $("planBuy").textContent = p.state === "paid" ? "Renew with Razorpay" : "Subscribe with Razorpay";
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
  $("planBarBtn").addEventListener("click", () => { location.hash = "#/settings"; });
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
    $("accEmail").textContent = `Logged in as ${u.email}`;
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
    }, $("bizErr"), "Settings saved");
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
    history.replaceState(null, "", "/"); showAuth("login");
  });
  $("deleteAccBtn").addEventListener("click", () => {
    openSheet({
      title: "Delete your account?",
      body: `<p class="small">This permanently deletes your business, all ${noun().toLowerCase()}s and every ledger entry. It can't be undone.</p>
             <label class="field">Type your password to confirm<input id="shPass" type="password" autocomplete="current-password" required></label>`,
      ok: "Delete everything",
      onSubmit: async () => {
        await api("POST", "/api/account/delete", { password: $("shPass").value });
        state.user = null; history.replaceState(null, "", "/"); showAuth("register"); toast("Your account was deleted.");
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
    setKind("credit");
    const m = location.hash.match(/^#reset=([a-f0-9]{64})$/);
    try { state.config = await api("GET", "/api/config"); } catch { state.config = {}; }
    if (m) { state.resetToken = m[1]; showAuth("reset"); return; }
    try { const d = await api("GET", "/api/me"); await enterApp(d.user); }
    catch (err) {
      if (err.offline) { toast(err.message); }
      showAuth(location.hash === "#register" ? "register" : "login");
    }
  })();
})();
