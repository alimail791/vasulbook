// Background jobs: end expired ads and plans, plan-ending reminders, 9 AM daily offers.
const cfg = require('./config');
const db = require('./db');
const wa = require('./wa');
const bot = require('./bot');

const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const hourIST = () => Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));

async function expireAds() {
  const ended = await db.all(`update ads set status='expired' where status in ('live','paused','pending') and valid_until < now() returning id, adv_id, title, status`);
  for (const a of ended) {
    const adv = await db.advertisers.get(a.adv_id);
    if (adv && bot.planActive(adv)) await bot.notify(adv.phone, `⌛ Your ad “${a.title}” has ended. Post a fresh one to keep customers coming.`, [['➕ Post again', 'post:deal'], ['📊 My ads & leads', 'myads']]);
  }
  return ended.length;
}

async function planJobs() {
  // plan ended
  const ended = await db.all(`select * from advertisers where plan_until is not null and plan_until < now() and (ended_for is null or ended_for <> plan_until)`);
  for (const a of ended) {
    await db.q(`update advertisers set ended_for=plan_until where id=$1`, [a.id]);
    await db.q(`update ads set status='expired' where adv_id=$1 and status in ('live','paused','pending')`, [a.id]);
    const P = await db.plans();
    await bot.notify(a.phone, `⌛ Your ${cfg.BRAND} *${P[a.plan] ? P[a.plan].name : ''}* plan has ended, so your ads are no longer shown.\nRenew from ${bot.rs(P.day.price)} to keep getting customers.`, [['💳 Plans & renew', 'plans']]);
  }
  // ending within 2 days (not for the 1-day plan)
  const soon = await db.all(`select * from advertisers where plan_until > now() and plan_until < now() + interval '2 days' and plan <> 'day' and (reminded_for is null or reminded_for <> plan_until)`);
  for (const a of soon) {
    await db.q(`update advertisers set reminded_for=plan_until where id=$1`, [a.id]);
    const P = await db.plans();
    const stats = await db.one(`select coalesce(sum(views),0)::int v, coalesce(sum(leads),0)::int l from ads where adv_id=$1`, [a.id]);
    await bot.notify(a.phone, `⏰ Your ${P[a.plan].name} ends on *${bot.istDate(a.plan_until)}*.\nSo far: 👁 ${stats.v} views · 🙋 ${stats.l} leads.\nRenew now so your ads keep running.`, [[`⭐ Monthly – ${bot.rs(P.month.price)}`, 'plan:month'], [`👑 Premium – ${bot.rs(P.premium.price)}`, 'plan:premium'], ['💳 All plans', 'plans']]);
  }
  return { ended: ended.length, reminded: soon.length };
}

// Top 5 live ads near each subscriber. Inside the 24h window: normal message with buttons.
// Outside it: the approved marketing template (WA_DIGEST_TEMPLATE), if configured.
async function runDigest(force = false, localityIds = null) {
  const subs = await db.all(`select * from customers where subscribed and lat is not null ${force ? '' : 'and (last_digest is null or last_digest < $1::date)'} ${localityIds ? `and locality_id = any($${force ? 1 : 2})` : ''}`,
    [...(force ? [] : [todayIST()]), ...(localityIds ? [localityIds] : [])]);
  let sent = 0;
  for (const cu of subs) {
    const top = (await bot.nearby(cu)).slice(0, 5);
    if (!top.length) continue;
    const lines = top.map((a, i) => `${i + 1}. ${a.title} – ${a.offer} (${a.shop}, ${a.dist < 1 ? Math.round(a.dist * 1000) + ' m' : a.dist.toFixed(1) + ' km'})`);
    const recent = cu.last_seen && Date.now() - new Date(cu.last_seen).getTime() < 23 * 3600e3;
    try {
      if (recent) await wa.send(cu.phone, `☀️ *Good morning! Top offers near you today*\n\n${lines.join('\n')}\n\nReply *STOP* to stop these.`, [["🔥 See all offers", 'offers'], ['🔕 Stop daily offers', 'alerts']]);
      else if (cfg.WA_DIGEST_TEMPLATE) await wa.sendTemplate(cu.phone, lines.join(' | '), cfg.WA_DIGEST_TEMPLATE);
      else continue;
      await db.q('update customers set last_digest=$2 where phone=$1', [cu.phone, todayIST()]);
      sent++;
    } catch (e) { console.error('digest', cu.phone, e.message); }
  }
  await db.q('insert into broadcasts(scope,sent) values($1,$2)', [localityIds ? 'localities:' + localityIds.join(',') : 'all', sent]);
  return sent;
}

let running = false;
async function tick() {
  if (running) return; running = true;
  try {
    await expireAds();
    await planJobs();
    if (hourIST() === cfg.DIGEST_HOUR) {
      const row = await db.one(`select value from settings where key='digest_date'`);
      if (!row || row.value !== todayIST()) {
        await db.q(`insert into settings(key,value) values('digest_date',$1) on conflict(key) do update set value=$1`, [JSON.stringify(todayIST())]);
        const n = await runDigest(false);
        console.log('daily digest sent to', n);
      }
    }
  } catch (e) { console.error('jobs', e); }
  finally { running = false; }
}
function start() { setTimeout(tick, 20e3); return setInterval(tick, 5 * 60e3); }

module.exports = { start, tick, expireAds, planJobs, runDigest };
