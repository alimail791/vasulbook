/* Policy pages required for payment gateways (Razorpay): terms, privacy, refunds, delivery, contact. */
const billing = require("./billing");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
const UPDATED = "16 October 2026";

function biz() {
  return {
    name: process.env.LEGAL_NAME || "VasulBook",
    address: process.env.BUSINESS_ADDRESS || "",
    city: process.env.BUSINESS_CITY || "",
    email: process.env.SUPPORT_EMAIL || "info@vasulbook.com",
    wa: !!process.env.WHATSAPP_CONTACT,
  };
}

const PAGES = {
  terms: { path: "/terms", title: "Terms & Conditions" },
  privacy: { path: "/privacy", title: "Privacy Policy" },
  refund: { path: "/refund-policy", title: "Refund & Cancellation Policy" },
  delivery: { path: "/delivery-policy", title: "Shipping & Delivery Policy" },
  contact: { path: "/contact", title: "Contact Us" },
};

function body(key, b) {
  const P = billing.PLAN, R = billing.REFERRAL;
  const price = inr(P.priceInr), months = P.months, trial = P.trialMonths;
  const who = esc(b.name) + (b.name === "VasulBook" ? "" : " (“VasulBook”)");
  const mail = `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>`;
  const courts = b.city ? `the courts at ${esc(b.city)}` : "the competent courts in India";

  if (key === "terms") return `
<p>These Terms &amp; Conditions (“Terms”) govern your use of the VasulBook website at www.vasulbook.com and the VasulBook app (together, the “Service”), operated by ${who} (“we”, “us”). By creating an account or using the Service you agree to these Terms. If you do not agree, please do not use the Service.</p>
<h2>1. The Service</h2>
<p>VasulBook is an online ledger for businesses that sell on credit. It lets you record amounts customers owe, record payments, send payment reminders to your customers through WhatsApp, and see summaries. VasulBook is a record-keeping and reminder tool. We do not lend money, collect money on your behalf, or act as a collection agent.</p>
<h2>2. Your account</h2>
<ul>
<li>You must be at least 18 years old and able to enter a binding contract under Indian law.</li>
<li>You must give accurate details when you sign up, including a working email address, and keep your password confidential. You are responsible for all activity under your account.</li>
<li>One account is meant for one business. Tell us at once at ${mail} if you think your account has been used without permission.</li>
</ul>
<h2>3. Free trial and subscription</h2>
<ul>
<li>New accounts get a free trial of ${trial} months with all features. No card or payment is needed to start.</li>
<li>After the trial, continued use of the paid features costs <b>${price} for ${months} months</b> (prices include applicable taxes unless stated otherwise at checkout). Payment is made once, in advance, through our payment partner Razorpay, by UPI, card, net banking or wallet.</li>
<li>A subscription does not renew automatically. Before your access ends we remind you by email; you choose whether to pay again.</li>
<li>If you buy a new period before your current access ends, the new months are added after the current end date.</li>
<li>If your trial or subscription ends, your data stays in your account and you can still view it, but adding new entries and sending reminders are paused until you subscribe.</li>
<li>We may change prices for future periods. A change never affects a period you have already paid for, and we will show the new price before you pay.</li>
</ul>
<h2>4. Refer &amp; earn</h2>
<p>If another business signs up with your referral link and confirms their email address, you may receive ${R.rewardMonths} free months and they may receive ${R.friendBonusMonths} extra free month, as shown in the app at the time. Free months have no cash value and cannot be transferred. We may withhold or reverse rewards that come from fake, duplicate or self-referred accounts, and we may change or end the programme for future referrals.</p>
<h2>5. Your data and your customers</h2>
<ul>
<li>You own the data you enter, including your customers’ names, phone numbers and amounts. You give us permission to store and process it only to run the Service for you.</li>
<li>You confirm that you have a genuine business relationship with each customer you add and that you are allowed to contact them about money they owe you.</li>
<li>Reminders must be polite and truthful. You must not use the Service to harass, threaten, shame or mislead anyone, to send messages to people who do not owe you, or to send spam or promotional messages.</li>
<li>Messages sent through WhatsApp are also subject to WhatsApp’s own terms. You are responsible for the messages you choose to send.</li>
</ul>
<h2>6. Acceptable use</h2>
<p>You must not misuse the Service. This includes trying to access other users’ data, interfering with or overloading the Service, reverse-engineering it, reselling it without our written permission, or using it for anything unlawful, including unlawful lending or recovery practices.</p>
<h2>7. Payments made by your customers</h2>
<p>If you connect your own Razorpay account or show your UPI ID in reminders, payments from your customers go directly to you through those services. We are not a party to those payments and are not responsible for disputes, failures or refunds between you and your customers.</p>
<h2>8. Availability and changes</h2>
<p>We work to keep the Service available and your data safe, but we do not promise that it will always be uninterrupted or error-free. We may improve, change or remove features. You should keep your own records of important information.</p>
<h2>9. Limitation of liability</h2>
<p>The Service is provided “as is”. To the extent permitted by law, we are not liable for indirect or consequential losses, lost profits, or amounts your customers fail to pay. Our total liability for any claim relating to the Service is limited to the amount you paid us in the 12 months before the claim.</p>
<h2>10. Closing your account</h2>
<p>You can delete your account at any time from Settings in the app; this permanently deletes your ledger. We may suspend or close an account that breaks these Terms, and we will tell you why unless the law prevents us.</p>
<h2>11. Governing law</h2>
<p>These Terms are governed by the laws of India. Any dispute will be subject to the exclusive jurisdiction of ${courts}.</p>
<h2>12. Changes to these Terms</h2>
<p>We may update these Terms. If a change is important we will tell you by email or in the app before it takes effect. Continuing to use the Service after that means you accept the updated Terms.</p>
<h2>13. Contact</h2>
<p>Questions about these Terms: ${mail}. See also our <a href="/privacy">Privacy Policy</a> and <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.</p>`;

  if (key === "privacy") return `
<p>This Privacy Policy explains what information ${who} collects when you use www.vasulbook.com and the VasulBook app, how we use it and the choices you have. We follow the Digital Personal Data Protection Act, 2023 and other applicable Indian law.</p>
<h2>1. Information we collect</h2>
<ul>
<li><b>Account details:</b> your name, business name, business type, state, mobile number, email address and a securely hashed password.</li>
<li><b>Ledger data you enter:</b> your customers’ names, phone numbers, amounts given on credit, payments, due dates and notes.</li>
<li><b>Settings:</b> your UPI ID, reminder and language choices and, if you connect it, your Razorpay key (stored encrypted).</li>
<li><b>Subscription payments:</b> the order and payment IDs, amount and status that Razorpay sends us. We do <b>not</b> receive or store your card number, UPI PIN or bank login; those are handled by Razorpay.</li>
<li><b>Usage information:</b> when you last used the app, and basic technical logs (such as IP address and browser type) used to keep the Service secure.</li>
</ul>
<h2>2. How we use it</h2>
<ul>
<li>To run the Service: keep your ledger, prepare reminder messages, and show summaries.</li>
<li>To send service emails: sign-up codes, password reset codes, your evening summary, receipts, and reminders about your trial or subscription. You can turn the evening summary off in Settings.</li>
<li>To process subscription payments and referral rewards.</li>
<li>To keep the Service secure, prevent misuse and fix problems.</li>
<li>To send a short email if you have not used the app for a few days. You can ask us to stop these.</li>
</ul>
<p>We do <b>not</b> sell your information or your customers’ information, and we do not use your ledger data for advertising.</p>
<h2>3. Your customers’ information</h2>
<p>For the ledger data you enter, you decide what is stored and why, and we process it only on your instructions to provide the Service. We never contact your customers ourselves for our own purposes. Reminders are sent by you, from your WhatsApp, or through the WhatsApp Business service if you set it up.</p>
<h2>4. Who we share it with</h2>
<p>We use trusted service providers only as needed to run the Service:</p>
<ul>
<li>Razorpay, for subscription payments;</li>
<li>Railway, for hosting and database storage (servers may be located outside India);</li>
<li>Resend, for sending emails;</li>
<li>Meta (WhatsApp), only if you choose to send reminders through WhatsApp.</li>
</ul>
<p>We may also disclose information if required by law or to protect the rights and safety of our users.</p>
<h2>5. Cookies and local storage</h2>
<p>We use one essential cookie to keep you logged in, and your browser’s local storage to remember your language and keep your ledger available offline. We do not use advertising or third-party tracking cookies. To count visitors we keep an anonymous, random browser ID with the page visited, the device type and the website you came from; we do not store your IP address for this, and counts are deleted after about a year.</p>
<h2>6. Security and retention</h2>
<p>Data is sent over HTTPS, passwords are hashed and payment keys are encrypted. We keep your data while your account is open. When you delete your account from Settings, your account and ledger are deleted from our live database; backups and payment records needed for tax and legal purposes are kept only as long as the law requires.</p>
<h2>7. Your rights</h2>
<p>You can see and correct your details in the app, delete individual customers or entries, or delete your whole account from Settings. You can also email us to access, correct or erase your personal data, withdraw consent, or raise a grievance.</p>
<h2>8. Children</h2>
<p>The Service is for businesses and is not meant for anyone under 18.</p>
<h2>9. Grievance officer and contact</h2>
<p>For privacy questions or complaints, write to our grievance officer at ${mail}. We will acknowledge your request within 48 hours and try to resolve it within 30 days.</p>
<h2>10. Changes</h2>
<p>We may update this policy. If we make important changes we will tell you by email or in the app.</p>`;

  if (key === "refund") return `
<p>This policy explains cancellations and refunds for the VasulBook subscription sold by ${who}.</p>
<h2>1. Try before you pay</h2>
<p>Every new account gets a free trial of ${trial} months with all features, and no payment is needed to start. Please use the trial to make sure VasulBook suits your business before you buy.</p>
<h2>2. Subscription</h2>
<p>The subscription is a one-time payment of <b>${price} for ${months} months</b> of access. It does <b>not</b> renew automatically and there are no hidden or recurring charges, so there is nothing to cancel: if you do not want to continue, simply do not pay again when your access ends.</p>
<h2>3. Refunds</h2>
<ul>
<li><b>Within 7 days:</b> if you are not satisfied, you may request a full refund within 7 days of your payment by writing to ${mail} with your registered email address and Razorpay payment ID.</li>
<li><b>After 7 days:</b> payments are not refundable, and unused months are not refunded. Your access continues until the end of the period you paid for.</li>
<li><b>Duplicate or failed payments:</b> if you were charged twice, or money was deducted but your subscription was not activated, we will refund the extra or failed amount in full. Please write to us with the payment details.</li>
<li>Free months from the trial or from Refer &amp; earn have no cash value and are not refundable.</li>
</ul>
<h2>4. How refunds are paid</h2>
<p>Approved refunds are processed within <b>5–7 working days</b> to the original payment method (UPI, card, net banking or wallet) through Razorpay. Your bank may take a few more days to show the amount.</p>
<h2>5. Payments to your own business</h2>
<p>Money your customers pay you through your own UPI ID or Razorpay account goes directly to you. Refunds of those payments are between you and your customer.</p>
<h2>6. Contact</h2>
<p>Refund requests and questions: ${mail}${b.wa ? ' or <a href="/whatsapp" target="_blank" rel="noopener">chat with us on WhatsApp</a>' : ""}.</p>`;

  if (key === "delivery") return `
<p>VasulBook is an online software service sold by ${who}. <b>No physical goods are sold or shipped.</b></p>
<h2>1. How the service is delivered</h2>
<ul>
<li>The free trial starts immediately when you create your account on www.vasulbook.com.</li>
<li>After a successful payment, your subscription is activated <b>instantly</b> in your account, and a receipt is sent to your registered email address.</li>
<li>You can use VasulBook in any web browser, or install it on your phone’s home screen from the website. There is nothing to ship and no delivery charge.</li>
</ul>
<h2>2. If activation is delayed</h2>
<p>In rare cases a payment confirmation from the bank or Razorpay can take a few minutes. If your subscription is not active within 30 minutes of a successful payment, please write to ${mail} with your registered email address and Razorpay payment ID. We will activate it within 24 hours, or refund the payment in full as described in our <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.</p>
<h2>3. Service area</h2>
<p>VasulBook is offered to businesses in India and prices are charged in Indian Rupees.</p>`;

  if (key === "contact") return `
<p>We are happy to help with questions about your account, payments, refunds or anything else.</p>
<div class="lg-card">
  <p><b>${esc(b.name)}</b></p>
  ${b.address ? `<p>${esc(b.address).replace(/\n/g, "<br>")}</p>` : ""}
  <p>Email: ${mail}</p>
  ${b.wa ? '<p>WhatsApp: <a href="/whatsapp" target="_blank" rel="noopener">Chat with us on WhatsApp</a></p>' : ""}
  <p>Hours: Monday to Saturday, 10 am to 6 pm IST. We reply to emails within one working day.</p>
</div>
<h2>Payments and refunds</h2>
<p>For payment problems please include your registered email address and the Razorpay payment ID from your receipt. See our <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.</p>
<h2>Grievances</h2>
<p>Complaints about privacy or the Service can be sent to our grievance officer at ${mail}.</p>`;
  return "";
}

function page(key) {
  const b = biz(), p = PAGES[key];
  const links = Object.entries(PAGES).map(([k, v]) => `<a href="${v.path}"${k === key ? ' aria-current="page"' : ""}>${esc(v.title)}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(p.title)} · VasulBook</title>
<meta name="description" content="${esc(p.title)} for VasulBook, the udhaar ledger and WhatsApp payment reminder app.">
<link rel="canonical" href="{{BASE}}${p.path}">
<meta name="theme-color" content="#2445B5">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Figtree:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="/landing.css">
</head>
<body class="landing legal">
<header class="l-top"><div class="l-wrap l-top-in">
  <a class="brand" href="/">Vasul<b>Book</b></a>
  <div class="l-top-cta"><a class="btn primary sm" href="/app#register">Start free</a></div>
</div></header>
<main class="l-sec"><div class="l-wrap l-narrow lg-doc">
  <p class="eyebrow">Last updated ${UPDATED}</p>
  <h1>${esc(p.title)}</h1>
  ${body(key, b)}
</div></main>
<footer class="l-foot"><div class="l-wrap">
  <nav class="lg-links" aria-label="Policies">${links}</nav>
  <p class="small muted l-copy">© ${new Date().getFullYear()} ${esc(b.name)}. All rights reserved.</p>
</div></footer>
</body>
</html>`;
}

module.exports = function mountLegal(app, { baseUrl }) {
  for (const [key, p] of Object.entries(PAGES)) {
    app.get(p.path, (req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.type("html").send(page(key).replace("{{BASE}}", baseUrl(req)));
    });
  }
};
module.exports.PAGES = PAGES;
