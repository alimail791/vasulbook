/* Search landing pages: one page per business type plus feature and how-to guides.
   Each page answers one search intent ("udhaar khata app for kirana shop", "payment reminder message in Tamil")
   and links back to the free trial. Listed in sitemap.xml by src/seo.js. */
const billing = require("./billing");
const Ledger = require("../public/ledger");
const VBLang = require("../public/i18n/meta");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const UPDATED = "2026-11-24";

function plan() {
  const P = billing.PLAN, R = billing.REFERRAL;
  return { trial: P.trialMonths, price: inr(P.priceInr), months: P.months, pm: inr(P.priceInr / P.months), refer: R.rewardMonths };
}

// ---------- the pages ----------
// body() returns HTML; faq is [question, answer] pairs (plain text, also used for FAQPage markup).
const PAGES = [
  // ----- business types -----
  {
    slug: "for/kirana-shop", group: "business", short: "Kirana & general stores",
    title: "Udhaar Khata App for Kirana Shops: Track Credit and Get Paid on WhatsApp",
    desc: "A simple udhaar book for kirana and general stores. Note credit in seconds, send WhatsApp reminders with your UPI ID and see who is overdue. {trial} months free.",
    h1: "Udhaar khata app for kirana shops",
    lede: "Regular customers buy on credit every day. VasulBook keeps that udhaar book for you and does the polite asking on WhatsApp, so money comes back without awkward talks at the counter.",
    body: (p) => `
<h2>The kirana credit problem</h2>
<p>Most kirana owners give credit to families they know. The amounts are small, the entries are many, and the notebook gets messy. By month-end it is hard to say who owes what, and asking a regular customer to pay face to face feels rude.</p>
<h2>How VasulBook helps a kirana shop</h2>
<ul>
<li><b>Note credit in one line.</b> Type a name, amount and item, for example <code>Ravi 500 rice</code>. It is saved with a due date.</li>
<li><b>Running balance per customer.</b> Every credit and payment, with dates, like your paper book but searchable and never lost.</li>
<li><b>WhatsApp reminders with your UPI ID.</b> One tap sends a polite message in the customer's language. They pay with GPay, PhonePe, Paytm or any UPI app.</li>
<li><b>Overdue list.</b> Before giving more credit, see who is overdue and who often pays late.</li>
<li><b>9 pm summary.</b> Collected today, new credit and total pending, every evening.</li>
</ul>
<h2>A sample reminder your customer receives</h2>
${sample("en", "gentle", "Ravi", "Sri Lakshmi Stores", 1560)}
<p>Need it in Hindi or Tamil? See the <a href="/payment-reminder-message">payment reminder messages in 10 languages</a>.</p>
<h2>Price</h2>
<p>${p.trial} months free with every feature. After that ${p.price} for ${p.months} months (about ${p.pm} a month). No card needed to start.</p>`,
    faq: [
      ["Do my customers need to install VasulBook?", "No. They receive a normal WhatsApp message and pay with any UPI app they already use."],
      ["Can my staff use it on the shop computer?", "Yes. Log in on any phone or computer. On a phone you can install it to the home screen like an app."],
      ["Does it handle GST billing or stock?", "No. VasulBook is only for credit and collections, so there is nothing extra to learn."],
    ],
  },
  {
    slug: "for/medical-shop", group: "business", short: "Medical & pharmacy stores",
    title: "Credit Book App for Medical Shops: Collect Pending Payments on WhatsApp",
    desc: "Track customer credit at your medical or pharmacy store and send polite WhatsApp reminders with UPI. {trial} months free, works in 10 Indian languages.",
    h1: "Credit book for medical and pharmacy shops",
    lede: "Regular patients and nearby families often take medicines on credit. VasulBook records each entry and reminds them politely, so your pharmacy is paid without chasing.",
    body: (p) => `
<h2>Why credit is hard in a pharmacy</h2>
<p>Medicine is a need, not a choice, so pharmacists rarely refuse credit. But many small bills from many families add up, and a reminder about money for medicine has to be gentle.</p>
<h2>What you get</h2>
<ul>
<li><b>Per-customer ledger</b> with every credit and payment and a running balance.</li>
<li><b>Gentle first reminder, firmer later.</b> Messages change tone as the due date passes, so you never sound harsh too early.</li>
<li><b>Payment page with UPI QR.</b> The amount is filled in; the customer just pays.</li>
<li><b>Private by design.</b> Only you see your ledger; customer details are never sold or shared.</li>
</ul>
<h2>Sample reminder</h2>
${sample("en", "due", "Meena", "City Medicals", 840)}
<h2>Price</h2>
<p>${p.trial} months free, then ${p.price} for ${p.months} months.</p>`,
    faq: [
      ["Does VasulBook store prescriptions or medicine names?", "Only what you type in the note, such as an item or bill number. It is a credit ledger, not a pharmacy billing system."],
      ["Can I send reminders in Tamil, Hindi or other languages?", "Yes. Reminders are ready in English, Hindi, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati and Punjabi."],
    ],
  },
  {
    slug: "for/tuition-centre", group: "business", short: "Tuition & coaching centres",
    title: "Fee Reminder App for Tuition and Coaching Centres (WhatsApp + UPI)",
    desc: "Track pending tuition fees for every student and send polite WhatsApp fee reminders to parents with your UPI ID. {trial} months free.",
    h1: "Fee reminders for tuition and coaching centres",
    lede: "Teachers hate asking parents for fees. VasulBook keeps a fee ledger for each student and sends the reminder for you, politely and on time.",
    body: (p) => `
<h2>Fee collection without the awkward talk</h2>
<p>Monthly fees slip by a few days, then a few weeks. Calling a parent about money takes time and can spoil the relationship. A short WhatsApp message with a UPI link is easier for both sides.</p>
<h2>How it works for a tuition centre</h2>
<ol>
<li>Add each student with a parent's WhatsApp number.</li>
<li>Note the monthly fee as it falls due, for example <code>Arjun 1500 Nov fee</code>.</li>
<li>Tap remind. The parent gets a polite message with the amount and how to pay.</li>
<li>Mark payments as they come in, or let Razorpay mark them automatically.</li>
</ol>
<h2>Sample fee reminder</h2>
${sample("en", "gentle", "Arjun's parent", "Bright Tuition Centre", 1500)}
<p>Running a coaching centre? Our sister site <a href="https://www.classcoach.in/?utm_source=vasulbook&amp;utm_medium=guide" rel="noopener">ClassCoach</a> helps you create tests and track every student's progress.</p>
<h2>Price</h2>
<p>${p.trial} months free, then ${p.price} for ${p.months} months for unlimited students.</p>`,
    faq: [
      ["Can I track fees for many batches?", "Yes. Add as many students as you need; there is no limit on students or entries."],
      ["Will the message say it is from my centre?", "Yes. Your centre's name appears in every reminder."],
    ],
  },
  {
    slug: "for/milk-vendor", group: "business", short: "Milk, water & newspaper delivery",
    title: "Milk Vendor Hisab App: Monthly Bills and WhatsApp Payment Reminders",
    desc: "For milk, water can and newspaper delivery. Keep each household's monthly hisab and send WhatsApp reminders with UPI. {trial} months free.",
    h1: "Monthly hisab for milk, water and paper delivery",
    lede: "Daily delivery means one bill per household every month and many small follow-ups. VasulBook keeps each house's balance and reminds them on WhatsApp.",
    body: (p) => `
<h2>Built for doorstep delivery</h2>
<p>You deliver every morning and collect once a month. Some houses pay on the 1st, others need two reminders. Writing it all in a diary and knocking on doors takes hours.</p>
<ul>
<li><b>One entry per house per month</b>, for example <code>Flat 12B 1860 Nov milk</code>.</li>
<li><b>Households, not customers.</b> The app calls them households, so it fits how you work.</li>
<li><b>Reminders with UPI</b> so families pay from their phone instead of keeping cash ready.</li>
<li><b>Overdue at a glance</b> to decide whom to visit first.</li>
</ul>
<h2>Sample reminder</h2>
${sample("en", "firm", "Flat 12B", "Sri Krishna Milk", 1860, 4)}
<h2>Price</h2>
<p>${p.trial} months free, then ${p.price} for ${p.months} months.</p>`,
    faq: [
      ["Can I add daily quantities?", "Add the monthly total as one entry, or add entries as often as you like. The balance updates every time."],
      ["Does it work without internet?", "Your ledger opens without internet once installed; reminders go out when you are back online."],
    ],
  },
  {
    slug: "for/tailor-repair-salon", group: "business", short: "Tailors, repair shops & salons",
    title: "Customer Dues App for Tailors, Repair Shops and Salons",
    desc: "Track pending payments for stitching, repairs and salon services, and send WhatsApp reminders with UPI. {trial} months free.",
    h1: "Collect pending payments for tailoring, repair and salon work",
    lede: "Customers collect their clothes, phone or appliance and promise to pay later. VasulBook remembers, and reminds them for you.",
    body: (p) => `
<h2>Service businesses lose money in small amounts</h2>
<p>A balance of a few hundred rupees from many customers is easy to forget. Over a year it becomes real money.</p>
<ul>
<li>Note the balance when the job is delivered, for example <code>Suresh 350 blouse stitching</code>.</li>
<li>Send a reminder the same day with your UPI ID.</li>
<li>See all overdue customers in one list.</li>
</ul>
<h2>Sample reminder</h2>
${sample("en", "gentle", "Suresh", "Style Tailors", 350)}
<h2>Price</h2>
<p>${p.trial} months free, then ${p.price} for ${p.months} months.</p>`,
    faq: [["Is it only for big shops?", "No. Most users are one-person shops. It works on any phone."]],
  },
  {
    slug: "for/wholesale-distributor", group: "business", short: "Wholesalers & distributors",
    title: "Outstanding Payment Tracker for Wholesalers and Distributors",
    desc: "Track outstanding amounts from retailer shops and send WhatsApp payment reminders with UPI or a pay link. {trial} months free.",
    h1: "Outstanding tracker for wholesalers and distributors",
    lede: "You supply goods to shops on credit and your money stays out for weeks. VasulBook shows every shop's outstanding and follows up on WhatsApp.",
    body: (p) => `
<h2>Keep your working capital moving</h2>
<ul>
<li><b>Shops, not customers.</b> Each retailer has its own ledger and balance.</li>
<li><b>Due dates on every entry</b> so you know which bills are overdue.</li>
<li><b>Firmer reminders as days pass</b>, so you do not have to decide the tone each time.</li>
<li><b>Razorpay payment links</b> for retailers who prefer cards or net banking.</li>
</ul>
<h2>Sample reminder</h2>
${sample("en", "firm", "Ganesh Stores", "Balaji Distributors", 24500, 9)}
<h2>Price</h2>
<p>${p.trial} months free, then ${p.price} for ${p.months} months, unlimited shops and entries.</p>`,
    faq: [["Does it replace my billing software?", "No. Keep your billing software for invoices and GST. Use VasulBook only to follow up on what is unpaid."]],
  },
  {
    slug: "for/rent-hostel", group: "business", short: "Rent, PG, hostels & gyms",
    title: "Rent Reminder App for Landlords, PGs, Hostels and Gyms",
    desc: "Track monthly rent and membership fees and send polite WhatsApp rent reminders with UPI. For landlords, PG owners, hostels and gyms. {trial} months free.",
    h1: "Rent and membership reminders on WhatsApp",
    lede: "Rent and membership fees are due every month, and someone is always late. VasulBook keeps each tenant's balance and sends the reminder for you.",
    body: (p) => `
<h2>For landlords, PG owners, hostels and gyms</h2>
<ul>
<li>Each tenant or member gets a ledger with a running balance.</li>
<li>Add the monthly rent as it falls due, for example <code>Room 4 6500 Dec rent</code>.</li>
<li>Reminders include your UPI ID or a payment link with the amount filled in.</li>
<li>The evening summary tells you who paid today.</li>
</ul>
<h2>Sample rent reminder</h2>
${sample("en", "due", "Karthik", "Green Park PG", 6500)}
<h2>Price</h2>
<p>${p.trial} months free, then ${p.price} for ${p.months} months.</p>`,
    faq: [["Can I record a deposit or advance?", "Yes. A payment larger than the balance shows as an advance."]],
  },
  {
    slug: "for/clinic", group: "business", short: "Clinics & professionals",
    title: "Pending Payment Reminders for Clinics, CAs and Consultants",
    desc: "Clinics, CAs, lawyers and consultants: track unpaid fees per client and send polite WhatsApp reminders with UPI. {trial} months free.",
    h1: "Pending fee reminders for clinics and professionals",
    lede: "Professionals often finish the work first and get paid later. VasulBook tracks each client's unpaid fees and reminds them politely.",
    body: (p) => `
<h2>Polite, professional follow-up</h2>
<ul>
<li>Clients see a short, courteous message with your name, the amount and how to pay.</li>
<li>The tone becomes firmer only after the due date passes.</li>
<li>Client details stay private; only you see your ledger.</li>
</ul>
<h2>Sample reminder</h2>
${sample("en", "gentle", "Mr. Rao", "Sharma & Co.", 5000)}
<h2>Price</h2>
<p>${p.trial} months free, then ${p.price} for ${p.months} months.</p>`,
    faq: [["Can I edit the reminder text?", "You can pick the tone (gentle, due or firm) and the language for each reminder."]],
  },

  // ----- features and guides -----
  {
    slug: "udhaar-khata-app", group: "guide", short: "Udhaar khata app",
    title: "Udhaar Khata App: Digital Credit Book with WhatsApp Reminders",
    desc: "VasulBook is a digital udhaar khata (credit book) for any business that gives credit. Note dues, send WhatsApp reminders with UPI, see who is overdue. {trial} months free.",
    h1: "A digital udhaar khata that also collects the money",
    lede: "A paper khata tells you who owes you. VasulBook tells you, and then asks them for you, politely, on WhatsApp.",
    body: (p) => `
<h2>What is a digital udhaar khata?</h2>
<p>An udhaar khata (also called a credit book, hisab book or bahi khata) is the notebook where a business writes down credit given to customers and payments received. A digital khata keeps the same records on your phone, adds the totals for you and cannot be lost or torn.</p>
<h2>Paper khata vs VasulBook</h2>
<table class="g-table"><thead><tr><th></th><th>Paper khata</th><th>VasulBook</th></tr></thead><tbody>
<tr><td>Running balance per customer</td><td>Add by hand</td><td>Automatic</td></tr>
<tr><td>Know who is overdue</td><td>Turn pages</td><td>One list</td></tr>
<tr><td>Ask for payment</td><td>Call or ask in person</td><td>One-tap WhatsApp message with UPI</td></tr>
<tr><td>If lost or damaged</td><td>Records gone</td><td>Safe online, log in on any device</td></tr>
<tr><td>Cost</td><td>A few rupees</td><td>${p.trial} months free, then ${p.price} for ${p.months} months</td></tr>
</tbody></table>
<h2>Who uses it</h2>
<p>Any business that gives credit: ${bizLinks()}.</p>
<h2>Start in two minutes</h2>
<ol><li>Sign up with your mobile number and email.</li><li>Add your first customer with a WhatsApp number.</li><li>Type an entry like <code>Ravi 500 rice</code> and tap remind.</li></ol>`,
    faq: [
      ["Is VasulBook free?", "The first {trial} months are free with every feature. After that it costs {price} for {months} months."],
      ["Which languages does it support?", "English, Hindi, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati and Punjabi, for both the app and the reminders."],
      ["Is it an Android app?", "It is a web app that installs to the home screen on Android and iPhone and opens like any other app, even offline."],
    ],
  },
  {
    slug: "whatsapp-payment-reminder", group: "guide", short: "WhatsApp payment reminders",
    title: "WhatsApp Payment Reminder for Customers: Send Dues with UPI in One Tap",
    desc: "Send polite WhatsApp payment reminders to customers with the amount and your UPI ID or a pay link, in 10 Indian languages. Tone gets firmer as days pass.",
    h1: "WhatsApp payment reminders that get you paid",
    lede: "Your customers already read WhatsApp. A short reminder with the exact amount and a way to pay right now is the fastest way to get your money back.",
    body: (p) => `
<h2>What makes a reminder work</h2>
<ul>
<li><b>The exact amount.</b> No confusion about what is owed.</li>
<li><b>A way to pay immediately.</b> Your UPI ID, or a payment page with a UPI QR and the amount filled in.</li>
<li><b>The right tone for the day.</b> Friendly before the due date, clear on the due date, firm once overdue.</li>
<li><b>The customer's own language.</b> People respond faster to a message they read comfortably.</li>
</ul>
<h2>How VasulBook sends them</h2>
<p>Open a customer, tap <b>WhatsApp reminder</b>, and the message is ready with the balance, your shop name and payment details. VasulBook picks the tone from the due date; you can change it or the language before sending.</p>
<h2>The three tones</h2>
<h3>Before the due date (gentle)</h3>${sample("en", "gentle", "Ravi", "Sri Lakshmi Stores", 1560)}
<h3>On the due date</h3>${sample("en", "due", "Ravi", "Sri Lakshmi Stores", 1560)}
<h3>Overdue (firm)</h3>${sample("en", "firm", "Ravi", "Sri Lakshmi Stores", 1560, 5)}
<p>See the same messages in Hindi, Tamil and 7 more languages on the <a href="/payment-reminder-message">payment reminder message templates</a> page.</p>
<h2>Tips for sending reminders</h2>
<ul><li>Send in the morning, when people check their phones and have time to pay.</li><li>Do not send more than one reminder a day to the same customer.</li><li>Record the payment as soon as it arrives so the next reminder never goes to someone who has paid.</li></ul>`,
    faq: [
      ["Will the customer know it came from me?", "Yes. Your shop or business name is in every message."],
      ["Do I need WhatsApp Business?", "No. Normal WhatsApp works. WhatsApp Business also works."],
    ],
  },
  {
    slug: "payment-reminder-message", group: "guide", short: "Payment reminder message templates",
    title: "Payment Reminder Messages for Customers in English, Hindi, Tamil and 7 More Languages",
    desc: "Copy-ready polite and firm payment reminder messages for WhatsApp and SMS in English, Hindi, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati and Punjabi.",
    h1: "Payment reminder messages in 10 Indian languages",
    lede: "Copy these messages for WhatsApp or SMS. Replace the name, amount, shop and UPI ID. Or let VasulBook fill them in and send them for you.",
    body: () => `
<p>Each language has a <b>gentle</b> message (before the due date) and a <b>firm</b> message (once the payment is overdue). Example: customer Ravi, ₹1,500, shop Sri Lakshmi Stores, UPI ID <code>lakshmi@okaxis</code>.</p>
<nav class="g-toc" aria-label="Languages">${VBLang.LANGS.map((l) => `<a href="#msg-${l.code}">${esc(l.name)}</a>`).join("")}</nav>
${VBLang.LANGS.map((l) => `<h2 id="msg-${l.code}">Payment reminder message in ${esc(l.name)}${l.code === "en" ? "" : ` (${esc(l.native)})`}</h2>
<h3>Gentle</h3>${sample(l.code, "gentle", "Ravi", "Sri Lakshmi Stores", 1500)}
<h3>Overdue</h3>${sample(l.code, "firm", "Ravi", "Sri Lakshmi Stores", 1500, 3)}`).join("\n")}
<h2>How to write your own reminder</h2>
<ul><li>Start with a greeting and the customer's name.</li><li>Say who you are and the exact amount.</li><li>Give one easy way to pay: UPI ID, QR or link.</li><li>End with thanks, or an offer to talk if there is a problem.</li></ul>`,
    faq: [
      ["How do I ask a customer for pending payment politely?", "Greet them by name, mention your shop and the exact amount, give a UPI ID or link, and thank them. Keep it short."],
      ["Can I send these automatically?", "VasulBook fills in the name, amount and your UPI details and opens the reminder in WhatsApp in one tap."],
    ],
  },
  {
    slug: "khatabook-alternative", group: "guide", short: "Khata app alternative",
    title: "Looking for a Khatabook Alternative? Compare VasulBook",
    desc: "Comparing khata apps? VasulBook focuses on collecting: WhatsApp reminders in 10 languages, UPI payment page, overdue list and an evening summary. {trial} months free.",
    h1: "A khata app alternative focused on collecting money",
    lede: "Popular khata apps such as Khatabook and OkCredit are good at recording credit. If your real problem is getting paid, here is how VasulBook is different.",
    body: (p) => `
<h2>When VasulBook is the better fit</h2>
<ul>
<li>You already record credit, but customers still pay late.</li>
<li>You want reminders that change tone automatically as days pass.</li>
<li>Your customers prefer messages in Hindi, Tamil, Telugu or another Indian language.</li>
<li>You want a single list of who is overdue and a summary every evening.</li>
<li>You do not need billing, GST or stock features and prefer something simple.</li>
</ul>
<h2>When to stay with what you have</h2>
<p>If your current app works and customers pay on time, there is no need to switch. Features and prices of other apps change often, so check their current plans yourself.</p>
<h2>What VasulBook includes</h2>
<ul><li>Udhaar ledger with running balance and due dates</li><li>WhatsApp reminders in 10 languages with your UPI ID or a payment link</li><li>Payment page with UPI QR, amount filled in</li><li>Overdue list and 9 pm summary by app and email</li><li>Installs like an app, opens offline</li></ul>
<h2>Price</h2>
<p>${p.trial} months free, then ${p.price} for ${p.months} months. Refer another business and get ${p.refer} months free.</p>`,
    faq: [
      ["Can I move my customers from another app?", "Add your customers and their current balance as an opening entry; it takes a few minutes for most shops."],
      ["Is VasulBook made by Khatabook?", "No. VasulBook is an independent product. Khatabook and OkCredit are trademarks of their owners."],
    ],
  },
];

// ---------- helpers ----------
function sample(lang, tone, name, shop, amt, days = 2) {
  const T = Ledger.TPL[lang] || Ledger.TPL.en;
  const pay = T.payUpi.replace("{upi}", "lakshmi@okaxis");
  const txt = T[tone].replace("{name}", name).replace("{shop}", shop).replace("{amt}", inr(amt)).replace("{days}", days).replace("{pay}", pay);
  return `<blockquote class="g-msg" lang="${lang}">${esc(txt)}</blockquote>`;
}
function bizLinks() {
  return PAGES.filter((x) => x.group === "business").map((x) => `<a href="/${x.slug}">${esc(x.short.toLowerCase())}</a>`).join(", ");
}
const fillPlan = (s, p) => String(s).replace(/\{(\w+)\}/g, (m, k) => (p[k] !== undefined ? p[k] : m));

const CSS = `.g-doc{max-width:760px}.g-doc h2{font-size:22px;margin:30px 0 10px}.g-doc h3{font-size:16px;margin:18px 0 6px}
.g-lede{font-size:18px;color:var(--muted);line-height:1.55}.g-cta{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 8px}
.g-msg{margin:8px 0 14px;padding:12px 14px;border-radius:12px 12px 12px 4px;background:var(--good-soft);border:1px solid var(--line);line-height:1.6}
.g-table{width:100%;border-collapse:collapse;font-size:14.5px;margin:8px 0}.g-table th,.g-table td{border-bottom:1px solid var(--line);padding:9px 6px;text-align:left;vertical-align:top}
.g-toc{display:flex;flex-wrap:wrap;gap:6px 14px;margin:12px 0}.g-faq dt{font-weight:600;margin-top:14px}.g-faq dd{margin:4px 0 0}
.g-more{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;padding:0;list-style:none}.g-more a{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);text-decoration:none}
.g-crumb{font-size:13.5px;color:var(--muted)}.g-crumb a{color:var(--muted)}`;

function render(pg, base) {
  const p = plan();
  const url = base + "/" + pg.slug;
  const title = fillPlan(pg.title, p), desc = fillPlan(pg.desc, p);
  const faq = pg.faq.map(([q, a]) => [fillPlan(q, p), fillPlan(a, p)]);
  const crumbs = [{ name: "VasulBook", url: base + "/" }, { name: pg.group === "business" ? "Businesses" : "Guides", url: base + "/guides" }, { name: pg.short, url }];
  const jsonld = [
    { "@context": "https://schema.org", "@type": "WebPage", name: title, description: desc, url, inLanguage: "en", dateModified: UPDATED,
      isPartOf: { "@type": "WebSite", name: "VasulBook", url: base + "/" } },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url })) },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ];
  const related = PAGES.filter((x) => x !== pg).map((x) => `<li><a href="/${x.slug}">${esc(x.short)}</a></li>`).join("");
  return shell({ title, desc, url, base, jsonld, body: `
<p class="g-crumb"><a href="/">VasulBook</a> › <a href="/guides">${pg.group === "business" ? "Businesses" : "Guides"}</a> › ${esc(pg.short)}</p>
<h1>${esc(pg.h1)}</h1>
<p class="g-lede">${esc(pg.lede)}</p>
${cta(p)}
${pg.body(p)}
<h2>Questions</h2>
<dl class="g-faq">${faq.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join("")}</dl>
${cta(p)}
<h2>More from VasulBook</h2>
<ul class="g-more">${related}</ul>` });
}

function cta(p) {
  return `<div class="g-cta"><a class="btn primary" href="/app?lang=en#register">Start ${p.trial} months free</a><a class="btn" href="/#demo">Watch the demo</a></div>`;
}

function hub(base) {
  const url = base + "/guides";
  const list = (g) => PAGES.filter((x) => x.group === g).map((x) => `<li><a href="/${x.slug}">${esc(x.short)}</a></li>`).join("");
  const title = "VasulBook guides: udhaar khata, payment reminders and collections for every business";
  const desc = "Guides on keeping an udhaar khata, sending WhatsApp payment reminders, and collecting dues for kirana shops, tuition centres, milk vendors, landlords and more.";
  const jsonld = [{ "@context": "https://schema.org", "@type": "CollectionPage", name: title, description: desc, url, inLanguage: "en",
    hasPart: PAGES.map((x) => ({ "@type": "WebPage", name: fillPlan(x.title, plan()), url: base + "/" + x.slug })) }];
  return shell({ title, desc, url, base, jsonld, body: `
<h1>Collect your dues faster</h1>
<p class="g-lede">Practical guides for every business that gives credit, and how VasulBook helps.</p>
<h2>By business</h2><ul class="g-more">${list("business")}</ul>
<h2>Guides</h2><ul class="g-more">${list("guide")}</ul>
${cta(plan())}` });
}

function shell({ title, desc, url, base, jsonld, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<script src="/gtm.js"></script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index,follow,max-image-preview:large">
${process.env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(process.env.GOOGLE_SITE_VERIFICATION)}">` : ""}
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="VasulBook">
<meta property="og:locale" content="en_IN">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${base}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#2445B5">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Figtree:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap">
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="/landing.css">
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
</head>
<body class="landing legal">
<header class="l-top"><div class="l-wrap l-top-in">
  <a class="brand" href="/">Vasul<b>Book</b></a>
  <div class="l-top-cta"><a class="btn primary sm" href="/app?lang=en#register">Start free</a></div>
</div></header>
<main class="l-sec"><div class="l-wrap l-narrow lg-doc g-doc">
${body}
</div></main>
<footer class="l-foot"><div class="l-wrap">
  <nav class="lg-links" aria-label="Guides"><a href="/">Home</a><a href="/guides">Guides</a><a href="/udhaar-khata-app">Udhaar khata app</a><a href="/payment-reminder-message">Reminder messages</a><a href="/contact">Contact Us</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms</a></nav>
  <p class="small muted l-copy">© ${new Date().getFullYear()} VasulBook. All rights reserved.</p>
</div></footer>
<script src="/track.js"></script>
</body>
</html>`;
}

module.exports = function mountGuides(app, { baseUrl }) {
  const cache = new Map();
  const get = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
  const send = (res, html) => { res.setHeader("Cache-Control", "public, max-age=600"); res.type("html").send(html); };
  app.get("/guides", (req, res) => { const b = baseUrl(req); send(res, get("hub|" + b, () => hub(b))); });
  for (const pg of PAGES) {
    app.get("/" + pg.slug, (req, res) => { const b = baseUrl(req); send(res, get(pg.slug + "|" + b, () => render(pg, b))); });
    app.get("/" + pg.slug + "/", (req, res) => res.redirect(301, "/" + pg.slug));
  }
};
module.exports.PATHS = ["/guides", ...PAGES.map((p) => "/" + p.slug)];
module.exports.PAGES = PAGES;
