const cfg = require('./config');
const db = require('./db');

const rs = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TAG = { New: 'y', Accepted: 'bl', Ready: 'bl', 'Out for delivery': 'bl', Completed: 'g', Cancelled: 'r' };

async function html() {
  const shops = await db.shops.all();
  let gmv = 0;
  for (const s of shops) {
    s.ms = await db.shops.monthSales(s.id); gmv += s.ms;
    const r = await db.one('select count(*)::int n, count(*) filter (where stock<5)::int low from items where shop_id=$1', [s.id]);
    s.items = r.n; s.low = r.low;
  }
  const areas = await db.areas.all();
  for (const a of areas) {
    const sh = shops.filter((s) => s.area_id === a.id);
    a.n = sh.length; a.sales = sh.reduce((t, s) => t + s.ms, 0); a.paid = sh.filter((s) => s.paid).length;
    a.share = (a.sales * a.comm_pct) / 100 + a.paid * cfg.SETUP_FEE * a.setup_share;
  }
  const orders = await db.all(`select o.*, s.name shop_name from orders o join shops s on s.id=o.shop_id order by o.id desc limit 100`);
  const del = (await db.one(`select coalesce(sum(del_fee),0) s from orders where status='Completed' and created_at >= date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'`)).s;
  const month = new Date().toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60">
<title>${esc(cfg.BRAND)} – Admin</title><style>
body{margin:0;font-family:system-ui,sans-serif;background:#e9edef;color:#111b21}header{background:#008069;color:#fff;padding:14px 16px}
main{max-width:1300px;margin:0 auto;padding:14px}h3{font-size:14px;color:#3b4a54;margin:18px 0 8px}
.kp{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.k{background:#fff;border-radius:10px;padding:11px 12px}
.k small{color:#667781;font-size:12px}.k b{display:block;font-size:20px;margin-top:3px}.tw{overflow-x:auto;background:#fff;border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:640px}th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eef0f1;white-space:nowrap}
th{background:#f7f8f8;color:#54656f}.tag{padding:2px 7px;border-radius:10px;font-size:11.5px;font-weight:600}
.g{background:#d9fdd3;color:#0a6b3a}.y{background:#fff3c4;color:#7a5b00}.r{background:#fde2e1;color:#a01818}.bl{background:#e1f0fb;color:#0b5c8f}
</style></head><body><header><b>${esc(cfg.BRAND)}</b> · Admin dashboard — ${month}</header><main>
<div class="kp"><div class="k"><small>Live shops</small><b>${shops.filter((s) => s.paid && s.active).length} / ${shops.length}</b></div>
<div class="k"><small>Setup fees collected</small><b>${rs(shops.filter((s) => s.paid).length * cfg.SETUP_FEE)}</b></div>
<div class="k"><small>Shop sales (month)</small><b>${rs(gmv)}</b></div>
<div class="k"><small>Your ${cfg.COMM * 100}% commission</small><b>${rs(gmv * cfg.COMM)}</b></div>
<div class="k"><small>Delivery charges (month)</small><b>${rs(del)}</b></div>
<div class="k"><small>Orders (last 100)</small><b>${orders.length}</b></div></div>
<h3>Areas & area admins</h3><div class="tw"><table><tr><th>Area</th><th>Area admin</th><th>Radius</th><th>Shops</th><th>Month sales</th><th>Area admin share (${cfg.AREA_COMM_PCT}% + ${Math.round(cfg.AREA_SETUP_SHARE * 100)}% setup)</th><th>Status</th></tr>
${areas.map((a) => `<tr><td><b>${esc(a.name)}</b></td><td>${a.admin_phone ? '+' + a.admin_phone : '—'}</td><td>${a.lat != null ? a.radius_km + ' km' : 'no location'}</td><td>${a.n}</td><td>${rs(a.sales)}</td><td>${rs(a.share)}</td><td>${a.active ? '<span class="tag g">Active</span>' : '<span class="tag r">Paused</span>'}</td></tr>`).join('') || '<tr><td colspan="7">No areas yet — add one from WhatsApp: menu → Areas & admins.</td></tr>'}</table></div>
<h3>Shops</h3><div class="tw"><table><tr><th>Shop</th><th>Area</th><th>Owner</th><th>Status</th><th>Delivery</th><th>Items</th><th>Low stock</th><th>Month sales</th><th>${cfg.COMM * 100}% due</th><th>Setup fee</th></tr>
${shops.map((s) => `<tr><td><b>${esc(s.name)}</b> <span style="color:#889">${s.code}</span></td><td>${esc(s.area)}</td><td>+${s.owner_phone}</td><td>${!s.paid ? '<span class="tag y">Pending</span>' : s.active ? '<span class="tag g">Live</span>' : '<span class="tag r">Paused</span>'}</td><td>${s.delivery ? '🛵 ' + rs(s.del_fee) : 'Pickup only'}</td><td>${s.items}</td><td>${s.low}</td><td>${rs(s.ms)}</td><td>${rs(s.ms * cfg.COMM)}</td><td>${s.paid ? '✅' : '⏳'}</td></tr>`).join('') || '<tr><td colspan="10">No shops yet — add one from WhatsApp.</td></tr>'}</table></div>
<h3>Orders & invoices</h3><div class="tw"><table><tr><th>#</th><th>Date</th><th>Shop</th><th>Invoice</th><th>Customer</th><th>Mode</th><th>Total</th><th>Payment</th><th>Status</th></tr>
${orders.map((o) => `<tr><td>${o.id}</td><td>${new Date(o.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(o.shop_name)}</td><td><a href="/inv/${o.token}.pdf" target="_blank">${o.inv}</a></td><td>${esc(o.cust_name)} +${o.cust_phone}</td><td>${o.mode === 'delivery' ? '🛵 Delivery' : '🏃 Pickup'}</td><td>${rs(o.total)}</td><td>${o.paid ? 'Paid' : o.pay === 'UPI' ? 'UPI – unverified' : 'Cash due'}</td><td><span class="tag ${TAG[o.status] || 'y'}">${o.status}</span></td></tr>`).join('') || '<tr><td colspan="9">No orders yet.</td></tr>'}</table></div>
</main></body></html>`;
}
module.exports = { html };
