# VasulBook Bazaar — WhatsApp shop bot

One WhatsApp number for many local grocery shops.

- **Admin** (ADMIN_PHONES — your personal number; the bot itself runs on 9003264537): adds shops and collects the ₹2,000 setup fee. Pauses or resumes shops and turns delivery on or off. Sees each shop's sales and the 2% commission, sends monthly bills and runs the delivery desk. Has a web dashboard.
- **Shop owner** (the number the admin registered for the shop): adds items with `Name | Category | Price | Stock` and updates them with `price Sugar 1kg 50`, `stock Sugar 1kg 40` or `remove Sugar 1kg`. Sets `upi name@okaxis`, `delfee 30` and `minorder 200`. Gets order alerts and accepts, rejects or marks orders ready. Sees sales and invoices and can opt in to admin delivery.
- **Customer** (anyone else): picks a shop, browses or searches, uses a cart and chooses pickup or home delivery. Pays the shop by UPI or in cash, gets a PDF invoice and receives status updates.

Testing tip: any number can send `#customer` to act as a customer, then `#admin` or `#shop` to switch back.

## Deploy (Railway)
1. Add a Postgres database and give this service `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
2. Generate a domain, for example `bazaar.vasulbook.com`.
3. Set these variables:

| Variable | Value |
|---|---|
| `WA_TOKEN` | Permanent System User token (Meta Business → System users) |
| `WA_PHONE_NUMBER_ID` | Phone number ID of the bot's WhatsApp number |
| `WA_VERIFY_TOKEN` | Any secret; use the same value in Meta's webhook setup |
| `WA_APP_SECRET` | Meta app secret (checks webhook signatures) |
| `ADMIN_PHONES` | Your personal WhatsApp number (not the bot number 9003264537); comma-separated for more than one |
| `ADMIN_KEY` | Password for `/admin?key=...` |
| `ADMIN_UPI` | Your UPI ID for setup fees and bills if Razorpay isn't set up |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Optional payment links for the setup fee and monthly bill |
| `WA_NOTIFY_TEMPLATE` | Name of an approved Utility template with one body variable, for example `VasulBook Bazaar update: {{1}}` |
| `PUBLIC_URL` | Optional; Railway's domain is used automatically |

4. In Meta → WhatsApp → Configuration, set the webhook to `https://<domain>/webhook` with your verify token and subscribe to **messages**.
5. In Razorpay → Webhooks, set `https://<domain>/razorpay/webhook` with the event `payment_link.paid`.

## Run locally / test
```
npm install
DATABASE_URL=postgres://... npm start   # without WA_TOKEN, messages are printed (dry run)
npm test                                 # full admin → owner → customer flow
```
