(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
  const num = (n) => Number(n || 0).toLocaleString("en-IN");
  const day = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "–");
  const ago = (d) => { if (!d) return "–"; const n = Math.floor((Date.now() - new Date(d).getTime()) / 864e5); return n <= 0 ? "Today" : n === 1 ? "Yesterday" : `${n} days ago`; };
  const TYPES = { retail: "Retail shop", tuition: "Tuition / coaching", delivery: "Daily delivery", services: "Services", wholesale: "Wholesale", rental: "Rent / hostel", clinic: "Clinic / professional" };
  const LANGS = { en: "English", hi: "हिन्दी Hindi", ta: "தமிழ் Tamil", te: "తెలుగు Telugu", kn: "ಕನ್ನಡ Kannada", ml: "മലയാളം Malayalam", mr: "मराठी Marathi", bn: "বাংলা Bengali", gu: "ગુજરાતી Gujarati", pa: "ਪੰਜਾਬੀ Punjabi" };
  const state = { status: "", q: "", page: 0, total: 0, sel: null };

  function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); }
  async function api(method, path, body) {
    const res = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/admin/login") { showLogin(); }
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  function showLogin() { $("dash").hidden = true; $("loginScreen").hidden = false; }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault(); $("aErr").textContent = "";
    try { await api("POST", "/api/admin/login", { email: $("aEmail").value, password: $("aPass").value }); $("aPass").value = ""; start(); }
    catch (err) { $("aErr").textContent = err.message; }
  });
  $("logout").addEventListener("click", async () => { await api("POST", "/api/admin/logout", {}).catch(() => {}); showLogin(); });

  async function start() {
    try { const me = await api("GET", "/api/admin/me"); $("whoami").textContent = me.email; }
    catch { showLogin(); return; }
    $("loginScreen").hidden = true; $("dash").hidden = false;
    loadStats(); loadUsers(); loadPayments();
  }

  // ---------- stats ----------
  async function loadStats() {
    const d = await api("GET", "/api/admin/stats");
    const k = d.kpi, r = d.revenue;
    const tiles = [
      ["Businesses", num(k.total), `${num(k.verified)} confirmed email`, ""],
      ["New, 7 days", num(k.new7), `${num(k.new1)} today · ${num(k.new30)} in 30 days`, "good"],
      ["Paid", num(k.paid), `${k.total ? Math.round((k.paid / k.total) * 100) : 0}% of all`, "good"],
      ["On trial", num(k.trial), `${num(k.trial_ending)} end within 7 days`, k.trial_ending ? "warn" : ""],
      ["Expired", num(k.expired), "Trial or plan ended", k.expired ? "bad" : ""],
      ["Active, 7 days", num(k.active7), "Opened the app", ""],
      ["Revenue this month", inr(r.month), `${num(r.month_orders)} payments`, "good"],
      ["Referrals", num(d.referrals.referred), `${num(d.referrals.rewarded)} rewarded`, ""],
    ];
    $("kpis").innerHTML = tiles.map(([l, v, s, c]) => `<div class="kpi ${c}"><span class="eyebrow">${l}</span><span class="amt">${v}</span><span class="sub">${esc(s)}</span></div>`).join("");
    $("revenue").innerHTML = `<div><span class="eyebrow">This month</span><span class="amt">${inr(r.month)}</span><span class="small muted">${num(r.month_orders)} payments</span></div>
      <div><span class="eyebrow">All time</span><span class="amt">${inr(r.total)}</span><span class="small muted">${num(r.orders)} payments · plan ${inr(d.plan.priceInr)} / ${d.plan.months} months</span></div>`;
    drawChart(d.signups);
    bars($("byType"), d.byType, (x) => TYPES[x] || x);
    bars($("byState"), d.byState, (x) => x);
    bars($("byLang"), d.byLang, (x) => LANGS[x] || x);
  }
  function bars(el, rows, label) {
    const max = Math.max(1, ...rows.map((r) => r.n));
    el.innerHTML = rows.length ? rows.map((r) => `<li><span>${esc(label(r.k))}</span><span class="amt">${num(r.n)}</span><span class="track"><span class="fill" style="width:${(r.n / max) * 100}%"></span></span></li>`).join("") : `<li class="muted">No data yet</li>`;
  }
  function drawChart(series) {
    const W = 760, H = 220, padL = 30, padB = 26, padT = 18, n = series.length;
    const max = Math.max(1, ...series.map((s) => s.n));
    const step = (W - padL - 8) / n, bw = Math.max(4, step * 0.66);
    const y = (v) => H - padB - (v / max) * (H - padB - padT);
    const ticks = [0, Math.ceil(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
    const total = series.reduce((s, x) => s + x.n, 0);
    $("signupTotal").textContent = `${num(total)} in 30 days`;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sign-ups per day for the last 30 days, ${total} in total">`;
    ticks.forEach((t) => { svg += `<line class="grid" x1="${padL}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`; });
    series.forEach((s, i) => {
      const x = padL + i * step + (step - bw) / 2;
      svg += `<rect class="bar" x="${x.toFixed(1)}" y="${y(s.n).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - padB - y(s.n)).toFixed(1)}" rx="2"><title>${s.d}: ${s.n} sign-up${s.n === 1 ? "" : "s"}</title></rect>`;
      if (s.n && s.n === max) svg += `<text class="val" x="${(x + bw / 2).toFixed(1)}" y="${(y(s.n) - 5).toFixed(1)}" text-anchor="middle">${s.n}</text>`;
      if (i % 5 === 0 || i === n - 1) { const [, m, dd] = s.d.split("-"); svg += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${Number(dd)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}</text>`; }
    });
    $("chart").innerHTML = svg + "</svg>";
  }

  // ---------- users ----------
  function planCell(p) {
    const cls = p.state === "paid" ? "clear" : p.state === "trial" ? "open" : "overdue";
    const label = p.state === "paid" ? "Paid" : p.state === "trial" ? "Trial" : "Expired";
    return `<span class="pill ${cls}">${label}</span><div class="sub">${p.state === "expired" ? "ended " : "till "}${day(p.accessUntil)}</div>`;
  }
  async function loadUsers() {
    const qs = new URLSearchParams({ q: state.q, status: state.status, page: state.page });
    $("csv").href = "/api/admin/users.csv?" + new URLSearchParams({ q: state.q, status: state.status });
    const d = await api("GET", "/api/admin/users?" + qs);
    state.total = d.total;
    $("users").innerHTML = d.users.length ? d.users.map((u) => `<tr class="click" data-id="${u.id}" tabindex="0">
      <td><div class="nm">${esc(u.shop_name)}</div><div class="sub">${esc(u.owner_name)}${u.referrer_shop ? ` · via ${esc(u.referrer_shop)}` : ""}</div></td>
      <td>${esc(u.email)}${u.email_verified ? "" : ` <span class="pill due">not confirmed</span>`}<div class="sub">${esc(u.phone || "")}</div></td>
      <td>${esc(TYPES[u.business_type] || u.business_type)}<div class="sub">${esc(u.state || "–")} · ${esc((LANGS[u.ui_lang] || u.ui_lang).split(" ")[0])}</div></td>
      <td>${planCell(u.plan)}</td>
      <td class="r">${num(u.customers)}</td><td class="r">${num(u.entries)}</td>
      <td>${ago(u.last_active_at)}</td><td>${day(u.created_at)}</td></tr>`).join("") : `<tr><td colspan="8" class="muted">No businesses match.</td></tr>`;
    const from = d.total ? state.page * 50 + 1 : 0, to = Math.min(d.total, (state.page + 1) * 50);
    $("pageInfo").textContent = `${num(from)}–${num(to)} of ${num(d.total)}`;
    $("prev").disabled = state.page === 0; $("next").disabled = to >= d.total;
  }
  let qt;
  $("q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value; state.page = 0; loadUsers(); }, 300); });
  document.querySelectorAll("[data-s]").forEach((b) => b.addEventListener("click", () => {
    state.status = b.dataset.s; state.page = 0;
    document.querySelectorAll("[data-s]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    loadUsers();
  }));
  $("prev").addEventListener("click", () => { state.page--; loadUsers(); });
  $("next").addEventListener("click", () => { state.page++; loadUsers(); });
  $("users").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) openUser(Number(tr.dataset.id)); });
  $("users").addEventListener("keydown", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr && e.key === "Enter") openUser(Number(tr.dataset.id)); });

  async function openUser(id) {
    state.sel = id; $("uErr").textContent = "";
    const d = await api("GET", "/api/admin/users/" + id);
    const u = d.user, p = u.plan;
    $("uTitle").textContent = u.shop_name;
    const facts = [["Owner", u.owner_name], ["Email", u.email + (u.email_verified ? "" : " (not confirmed)")], ["Phone", u.phone || "–"],
      ["Type", TYPES[u.business_type] || u.business_type], ["State", u.state || "–"], ["Language", LANGS[u.ui_lang] || u.ui_lang],
      ["Plan", `${p.state === "paid" ? "Paid" : p.state === "trial" ? "Free trial" : "Expired"} until ${day(p.accessUntil)}`],
      ["Customers", `${num(u.customers)} customers · ${num(u.entries)} entries`], ["Set up", `UPI ${u.upi_set ? "added" : "not added"} · Razorpay ${u.razorpay_connected ? "connected" : "not connected"}`],
      ["Joined", day(u.created_at)], ["Last active", ago(u.last_active_at)], ["Referral code", u.referral_code], ["Referred by", u.referrer_shop || "–"]];
    $("uFacts").innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
    $("verifyBtn").hidden = u.email_verified;
    $("uPays").innerHTML = d.payments.length ? d.payments.map((x) => `<li><span>${day(x.paid_at || x.created_at)}<div class="sub">${esc(x.payment_id || x.order_id)}</div></span><span>${inr(x.amount)} · ${x.months} months · ${esc(x.status)}</span></li>`).join("") : `<li class="muted">No payments</li>`;
    $("uRefs").innerHTML = d.referrals.length ? d.referrals.map((x) => `<li><span>${esc(x.shop_name)}</span><span class="small">${day(x.created_at)}${x.months ? ` · +${x.months} months earned` : ""}</span></li>`).join("") : `<li class="muted">None yet</li>`;
    $("uActs").innerHTML = d.actions.length ? d.actions.map((x) => `<li><span>${esc(x.action.replace("_", " "))}<div class="sub">${esc(x.detail)}</div></span><span class="small">${day(x.created_at)} · ${esc(x.admin_email)}</span></li>`).join("") : `<li class="muted">None</li>`;
    $("sheet").hidden = false;
  }
  const closeSheet = () => { $("sheet").hidden = true; };
  $("closeSheet").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  $("giftBtn").addEventListener("click", async () => {
    try {
      const d = await api("POST", `/api/admin/users/${state.sel}/extend`, { months: Number($("giftMonths").value), note: $("giftNote").value });
      toast(`Added. Plan now runs until ${day(d.plan.accessUntil)}`); $("giftNote").value = "";
      openUser(state.sel); loadUsers(); loadStats();
    } catch (err) { $("uErr").textContent = err.message; }
  });
  $("verifyBtn").addEventListener("click", async () => {
    try { await api("POST", `/api/admin/users/${state.sel}/verify`, {}); toast("Email marked as confirmed"); openUser(state.sel); loadUsers(); }
    catch (err) { $("uErr").textContent = err.message; }
  });

  // ---------- payments ----------
  async function loadPayments() {
    const d = await api("GET", "/api/admin/payments");
    $("payments").innerHTML = d.payments.length ? d.payments.map((p) => `<tr><td>${day(p.paid_at || p.created_at)}</td><td>${esc(p.shop_name)}<div class="sub">${esc(p.email)}</div></td>
      <td class="r amt">${inr(p.amount)}</td><td>${p.months}</td><td><span class="pill ${p.status === "paid" ? "clear" : "due"}">${p.status === "paid" ? "Paid" : "Started, not paid"}</span></td><td class="sub">${esc(p.payment_id || p.order_id)}</td></tr>`).join("")
      : `<tr><td colspan="6" class="muted">No payments yet.</td></tr>`;
  }

  start();
})();
