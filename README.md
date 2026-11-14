# EDeal — local offers on WhatsApp (edeal.vasulbook.com)

One WhatsApp number where people see **sales, discounts, offers, local events, tuition / coaching / schools, and houses for rent or sale within 2–5 km**, and where local businesses advertise.

## Who does what
- **Customer** (anyone): says *hi*, shares location (or picks an area), chooses 2 / 3 / 5 km. Browses offers, categories, education, events, rent & property, or just types what they need ("tuition", "2 bhk rent"). Gets coupon codes, books demo classes / site visits, contacts owners, gets directions as a map pin, and can turn on the **9 AM daily offers** message (STOP to stop).
- **Business** (sends *business*): registers with name, category and location → **15-day free trial** (once) or a paid plan → posts offers, events or property with a photo → ad goes to the locality admin for approval → sees views and leads, gets every enquiry on WhatsApp, redeems customer codes (just type the code).
- **Main admin** (`ADMIN_PHONES`): adds localities (run them yourself or give one or many to an area admin), approves ads, confirms UPI payments, sees revenue, sends the daily message. **Area admin** (number set on a locality): approves ads and sees revenue for their localities only and earns their share (default 50%).
- Anyone can switch views: `#customer`, `#business`, `#admin`.

## Plans (change prices in the web panel → Plans)
| Plan | Price | Gets |
|---|---|---|
| Free trial | ₹0, 15 days, once | 1 ad, 2 km |
| 1 Day | ₹30 | 1 ad, 2 km |
| 7 Days | ₹100 | 1 ad, 2 km |
| Monthly | ₹299 / month | unlimited ads & events, 2 km |
| Premium | ₹499 / month | unlimited, up to 5 km, featured on top + in the 9 AM message |

## Payments
- **Direct UPI** (`ADMIN_UPI`): the bot sends your UPI ID and a link to `/pay/<id>` (QR + "Open GPay / PhonePe / Paytm"). The business taps **I've paid** and sends the UPI reference or a screenshot; you get **Confirm / Not received** buttons on WhatsApp (or Panel → Payments).
- **Razorpay** (optional, `RAZORPAY_*`): a payment link (UPI, cards, net banking) is added too, and the plan starts by itself when paid. Webhook: `https://edeal.vasulbook.com/razorpay/webhook`, event `payment_link.paid`.
- Panel → Advertisers → **Give plan** records a cash payment or gives a free extension.

## Automatic jobs (every 5 minutes)
Ads end at their end date; plans end and the business is asked to renew; a reminder goes 2 days before a plan ends (with views and leads so far); the daily offers message goes out at `DIGEST_HOUR` (9 AM IST).

## Web admin panel
`https://edeal.vasulbook.com/panel` — log in with your WhatsApp number (6-digit code sent by the bot). Dashboard, Approvals, Ads (pause / remove), Advertisers (give plan), Payments (confirm UPI), Localities & area admins (main admin), Plans & prices (main admin), Broadcast (main admin). Area admins see only their localities.

## Deploy (Railway)
1. Postgres database → `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
2. Domain `edeal.vasulbook.com` (CNAME to the Railway domain).
3. Variables:

| Variable | Value |
|---|---|
| `WA_TOKEN` | Permanent System User token (can be the same as EMart's) |
| `WA_PHONE_NUMBER_ID` | Phone number ID of **EDeal's own WhatsApp number** |
| `WA_WABA_ID` | WhatsApp Business Account ID |
| `WA_VERIFY_TOKEN` | Any secret; same value in Meta's webhook setup |
| `WA_APP_SECRET` | Optional: Meta app secret (checks webhook signatures) |
| `WA_NOTIFY_TEMPLATE` | e.g. `edeal_update` – Utility template, created automatically |
| `WA_DIGEST_TEMPLATE` | e.g. `edeal_daily` – Marketing template for the 9 AM message, created automatically |
| `WA_WEBHOOK_OVERRIDE` | `1` to point this number's webhook to this server (when the Meta app's main webhook serves another bot) |
| `ADMIN_PHONES` | Your personal WhatsApp number(s), comma-separated |
| `ADMIN_KEY` | Password for `/panel?key=...` and `/admin/wa-check?key=...` |
| `ADMIN_UPI`, `UPI_NAME` | Your UPI ID and payee name for direct UPI payments |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Optional |
| `BOT_PHONE` | Bot's number, for the "Open on WhatsApp" button on the website |
| `PRICE_DAY`, `PRICE_WEEK`, `PRICE_MONTH`, `PRICE_PREMIUM`, `TRIAL_DAYS`, `AREA_SHARE_PCT`, `DIGEST_HOUR` | Optional defaults |

4. Meta → WhatsApp → Configuration: webhook `https://edeal.vasulbook.com/webhook`, subscribe to **messages** (or set `WA_WEBHOOK_OVERRIDE=1`).
5. Open `/admin/wa-check?key=ADMIN_KEY` once: it checks the token, subscribes the account, creates both templates and sets the business profile.

## Run locally / test
```
npm install
DATABASE_URL=postgres://... npm start   # without WA_TOKEN, messages are printed (dry run)
npm test                                 # full admin → business → customer → panel flow
```
