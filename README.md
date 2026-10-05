# VasulBook

VasulBook helps any business that gives credit (shops, tuition centres, milk and water vendors, tailors, wholesalers, clinics) collect money faster. Owners record dues, send WhatsApp reminders with UPI or Razorpay payment links, and get an evening summary.

It is an installable mobile app (PWA) backed by a Node.js server and PostgreSQL.

## What's included

| Area | Details |
| --- | --- |
| Accounts | Register, log in, forgot password by email, delete account. Passwords are hashed with bcrypt; sessions use a secure httpOnly cookie. |
| Registration emails | Every new sign-up gets a welcome email, and each address in `ADMIN_EMAIL` gets a "New registration" alert with the business name, owner, email, phone, type and time (IST). Sent through Resend. |
| Ledger | Customers, credit and payments, due dates, running balance, overdue status, and a "pays late" risk flag. Each business sees only its own data. |
| Quick entry | Type `Ravi 500 rice` to add credit or `Ravi paid 300` to record a payment. New names become new customers. |
| Reminders | English, Tamil and Hindi, with a tone that changes by due date. "Open in WhatsApp" works for everyone. Automatic sending is available when the WhatsApp Cloud API is set up. |
| Payments | Optional Razorpay payment links for each business, using its own Razorpay account. A webhook records the payment by itself. |
| Evening summary | Emailed at 9 pm IST to owners who have it switched on, and shown on the Home screen. |
| PWA | Installs to the home screen on Android and iPhone, opens full screen, and works offline for viewing the last loaded ledger. |
| Business types | Retail, tuition, delivery, services, wholesale, rental and clinic. Labels adapt, for example "Students" for tuition. |

## Subscription (free trial, then paid)

Every new account gets a **3-month free trial**. After that the plan is **₹1,000 for 10 months**, bought inside the app (Settings → Your plan, or the banner at the top) through Razorpay Checkout: UPI, cards, net banking and wallets.

- Paying early never loses days: the 10 months start when the current trial or plan ends.
- When the trial or plan ends, the owner can still log in and see everything, but adding entries, customers and reminders is paused until they pay.
- Emails: a receipt to the owner and a "plan purchased" alert to `ADMIN_EMAIL`. Owners also get a reminder 7 days and 1 day before the end, and one on the day it ends.
- Accounts that existed before the subscription was added get their 3 months counted from their sign-up date.

Set up, in your own Razorpay account:

1. **Account & Settings → API Keys**: generate keys. Put them in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Use test keys (`rzp_test_...`) first, then live keys.
2. **Account & Settings → Webhooks → Add**: URL `https://<your-app>/api/webhooks/razorpay-billing`, event **order.paid**, and a secret you choose. Put that secret in `RAZORPAY_WEBHOOK_SECRET`. This activates the plan even if the customer's phone closes before the app hears back.
3. Price and lengths can be changed with `PLAN_PRICE_INR`, `PLAN_MONTHS` and `TRIAL_MONTHS`.

Without Razorpay keys the Subscribe button is hidden in production. In local mode you get **Test payment** and **End my trial now** buttons instead, so you can try the whole flow without paying.

## Sign-up codes, refer & earn, and absent-user emails

- **Email confirmation:** after sign-up, the owner enters a 6-digit code sent to their email (valid 10 minutes, 5 tries, new code after 60 seconds, "Wrong email?" to fix a typo). Until then the app shows only the code screen. Accounts made before this feature count as confirmed.
- **Password reset:** "Forgot password?" emails a 6-digit code; the owner enters it with a new password.
- Both need Resend. **In production without Resend, codes can't be delivered, so new accounts are confirmed automatically and password reset is unavailable.** Add `RESEND_API_KEY` and `EMAIL_FROM` and both switch on.
- **Refer & earn:** every owner has a code and link (`https://<your-app>/?ref=CODE`). When a friend signs up with it and confirms their email, the owner gets **5 free months** (added after their current trial or plan) and the friend gets **1 extra trial month**. A popup on the Home screen shows once a day, with WhatsApp share, copy link and counts of friends joined and months earned. There's also a card on Home.
  Settings: `REFERRAL_REWARD_MONTHS` (default 5), `REFERRAL_FRIEND_BONUS_MONTHS` (default 1), `REFERRAL_TRIGGER` (`signup` by default, or `payment` to reward only when the friend subscribes).
- **We miss you:** owners who haven't opened the app for 5 days get one email at 11 am IST, showing how much is still pending from their customers. They get another only if they come back and then stay away for 5 days again.

Local testing pages: `/dev/run-inactive?days=0` sends the absent email now; sign-up codes also print in the terminal window.

## Landing page

- `/` is the public landing page (free trial, how it works, demo video, pricing, FAQ, footer with info@vasulbook.in). The app itself is at `/app`. Installed phone apps open `/app` directly.
- **WhatsApp chat button:** set `WHATSAPP_CONTACT` (e.g. `9443424064`). The page links to `/whatsapp`, and the server redirects to WhatsApp, so the number never appears on the page. Without the variable the button is hidden.
- **Demo video:** `public/media/demo.mp4` (and `.webm`) is a 48-second captioned walkthrough recorded from the app. To add YouTube videos as well, set `DEMO_VIDEOS`, comma separated, optionally with a title: `Tamil demo|https://youtu.be/XXXXXXXXXXX, https://youtu.be/YYYYYYYYYYY`.
- **Upgrade:** trial and expired owners see an Upgrade card on their dashboard and an Upgrade button in the top bar; both open Razorpay checkout.

## Admin dashboard

- Open `/admin` and log in with any address listed in `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 10 characters). Without `ADMIN_PASSWORD` the admin panel stays locked in production. Locally it is `admin@localhost` / `admin12345`.
- Shows: businesses, new sign-ups, paid / trial / expired counts, revenue this month and all time, a 30-day sign-up chart, and breakdowns by business type, state and app language.
- Businesses table: search, filters (trial, paid, expired, email not confirmed, away 5+ days), CSV export, and a detail panel where you can gift free months or mark an email as confirmed. Every admin action is logged in `admin_actions`.

## Languages

- The app, the landing page and the WhatsApp reminders work in English, Hindi, Tamil, Telugu, Kannada, Malayalam, Marathi, Bengali, Gujarati and Punjabi.
- At sign-up the owner picks their state; the app switches to that state's language (Tamil Nadu: Tamil, Kerala: Malayalam, and so on). They can change the app language and the reminder language any time in Settings.
- Texts live in `public/i18n/<code>.json` (an `app` section and a `landing` section). The state-to-language map is in `public/i18n/meta.js`. A missing text falls back to English.

## SEO

- The landing page is rendered on the server in every language: `/` (English), `/hi`, `/ta`, `/te`, `/kn`, `/ml`, `/mr`, `/bn`, `/gu`, `/pa`. Each page has its own title and description, `hreflang` links to the others, a canonical URL, Open Graph and Twitter tags with `public/og-image.png`, and JSON-LD (SoftwareApplication with the INR price, Organization, FAQ).
- `/sitemap.xml` lists all language pages; `/robots.txt` points to it and keeps `/app`, `/admin` and `/api` out of search.
- Set `APP_URL` to your real domain (e.g. `https://vasulbook.in`) so canonical and sitemap links use it. Then add the site in Google Search Console and submit `https://your-domain/sitemap.xml`.

## Deploy on Railway

1. Push this folder to a GitHub repository.
2. In Railway, create a project, choose **Deploy from GitHub repo**, and pick the repository.
3. In the same project, add **Database → PostgreSQL**.
4. Open the VasulBook service, go to **Variables**, and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `SESSION_SECRET` = a random 64-character string (see `.env.example` for how to generate one)
   - `NODE_ENV` = `production`
   - `RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_EMAIL` (see "Set up Resend" below)
5. Go to **Settings → Networking → Generate Domain**. Then set `APP_URL` to that address, for example `https://vasulbook-production.up.railway.app`.
6. Railway builds and starts the app. The database tables are created on first start. `/healthz` shows `{"ok":true}` when it's running.

The `railway.json` file already sets the start command and health check.

## Set up Resend (registration and summary emails)

1. Create an account at resend.com.
2. **Domains → Add domain.** Add your domain (for example `vasulbook.in`) and create the DNS records Resend shows you. Wait until it says **Verified**.
3. **API Keys → Create API key** with "Sending access". Copy it into `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to an address on the verified domain, for example `VasulBook <hello@vasulbook.in>`.
5. Set `ADMIN_EMAIL` to the address that should hear about every new registration.

Without a verified domain, Resend only delivers to your own Resend account email, so welcome emails to other people won't arrive. If the Resend variables are missing, the app still works and logs "email skipped" instead of sending.

Resend works over HTTPS, so it isn't affected by Railway blocking SMTP email ports on its Trial and Hobby plans.

## Optional: automatic WhatsApp reminders

Without this, owners send reminders with "Open in WhatsApp", which needs nothing extra.

To send automatically from one VasulBook business number:

1. Set up the WhatsApp Cloud API in Meta Business Manager and get a permanent access token and phone number ID.
2. Create and get approval for a **Utility** message template with four body variables, for example:
   `Hello {{1}}, your balance of {{2}} at {{3}} is pending. {{4}} Thank you.`
3. Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE` (the template name) and `WHATSAPP_TEMPLATE_LANG`.

Owners then see a **Send automatically** button, plus a setting that sends reminders every morning at 10:30 IST to customers who are due or overdue. Each customer gets at most one reminder every 3 days. Meta charges for each business-initiated conversation.

## Optional: Razorpay (per business)

Each owner connects their own Razorpay account in **Settings → Razorpay payment links**. They add their Key ID, Key secret and a webhook secret. Then in Razorpay they add the webhook URL that the Settings page shows, with the event `payment_link.paid`. The keys are encrypted in the database with `SESSION_SECRET`, so don't change that value once owners have connected Razorpay.

## Test on your own computer (no setup)

You only need **Node.js** (LTS version from nodejs.org). No database install and no email account are needed.

**Windows:** unzip the folder, then double-click `start-windows.bat`.
**Mac or Linux:** open a terminal in the folder and run `./start-mac-linux.sh`.
**Or by hand:** `npm install`, then `npm run local`.

The first start installs everything (about a minute), then your browser opens at http://localhost:3000. Keep the black window open while testing; close it to stop.

What happens in local mode:

- **Database:** a built-in PostgreSQL stores everything in the `local-data` folder. Your test data stays between restarts. Delete `local-data` to start fresh.
- **Emails are saved, not sent.** Open http://localhost:3000/dev/emails to see every email the app would send, including the welcome email and the **new registration alert**.
- **Evening summary now:** open http://localhost:3000/dev/run-summary to create today's summary email at once instead of waiting until 9 pm.
- **On your phone:** the window prints a "phone" address like `http://192.168.1.5:3000`. Open it on a phone on the same Wi-Fi to see the mobile layout. Installing as an app and offline mode need HTTPS, so try those after deploying (they work on `localhost` on the computer itself).
- **Send real emails while testing:** create a file named `.env` with `RESEND_API_KEY`, `EMAIL_FROM` and `ADMIN_EMAIL`, then restart.

If Windows asks whether to allow Node.js through the firewall, allow it on private networks so your phone can connect.

The `/dev` pages exist only in local mode. They are switched off when `NODE_ENV=production`, as on Railway.

## Project layout

```
server.js              Express app: auth, API, webhooks, static files
src/db.js              PostgreSQL pool and table setup (runs on start)
src/email.js           Resend emails: welcome, admin alert, password reset, evening summary
src/integrations.js    Razorpay payment links, WhatsApp Cloud API, key encryption
src/jobs.js            Scheduled jobs (IST): 9 pm summary, 10:30 am reminders, token cleanup
src/admin.js           Admin login and dashboard API (/api/admin/*)
src/seo.js             Landing page per language, sitemap.xml, robots.txt
views/landing.html     Landing page template ({{key}} texts come from public/i18n)
public/                The PWA and admin.html: index.html, app.js, app.css, ledger.js (shared maths), sw.js, manifest, icons
```

## API summary

| Method and path | What it does |
| --- | --- |
| `POST /api/auth/register` | Create account and send the registration emails |
| `POST /api/auth/login`, `/logout`, `/forgot`, `/reset` | Session and password reset |
| `GET /api/me`, `PUT /api/settings` | Account and business settings |
| `GET /api/data` | All customers and entries for the logged-in business |
| `POST/PUT/DELETE /api/customers[/:id]` | Manage customers |
| `POST /api/entries`, `DELETE /api/entries/:id` | Add or remove credit and payments |
| `POST /api/customers/:id/paylink` | Create a Razorpay payment link for the balance |
| `POST /api/customers/:id/send-reminder` | Send a WhatsApp template message (Cloud API) |
| `POST /api/webhooks/razorpay/:userId` | Razorpay webhook that records payments |
| `GET /healthz` | Health check |
