// All settings come from environment variables (Railway → Variables).
const norm = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  return d;
};
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

module.exports = {
  norm,
  PORT: process.env.PORT || 3000,
  DATABASE_URL: process.env.DATABASE_URL,

  // Meta WhatsApp Cloud API
  WA_TOKEN: process.env.WA_TOKEN || '',
  WA_PHONE_ID: process.env.WA_PHONE_NUMBER_ID || '',
  WA_VERIFY: process.env.WA_VERIFY_TOKEN || 'edeal-verify',
  WA_APP_SECRET: process.env.WA_APP_SECRET || '',
  WA_API_VERSION: process.env.WA_API_VERSION || 'v21.0',
  // Utility template (one body variable) for messages outside WhatsApp's 24-hour window
  WA_TEMPLATE: process.env.WA_NOTIFY_TEMPLATE || '',
  WA_TEMPLATE_LANG: process.env.WA_NOTIFY_TEMPLATE_LANG || 'en',
  // Marketing template (one body variable) for the 9 AM daily offers message
  WA_DIGEST_TEMPLATE: process.env.WA_DIGEST_TEMPLATE || '',

  // Main admin(s): comma-separated personal WhatsApp numbers (not the bot number)
  ADMINS: (process.env.ADMIN_PHONES || '').split(',').map(norm).filter(Boolean),
  ADMIN_KEY: process.env.ADMIN_KEY || 'change-me',
  // Your UPI ID: advertisers can pay directly; you confirm with one tap
  ADMIN_UPI: process.env.ADMIN_UPI || '',
  UPI_NAME: process.env.UPI_NAME || process.env.BRAND || 'EDeal',

  PUBLIC_URL: (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, ''),
  WEBSITE: process.env.BRAND_WEBSITE || 'https://edeal.vasulbook.com',

  // Razorpay (optional): payment links that confirm by themselves
  RZP_KEY: process.env.RAZORPAY_KEY_ID || '',
  RZP_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  RZP_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',

  BRAND: process.env.BRAND || 'EDeal',
  // Plans (prices can also be changed from the web panel)
  PLANS: {
    trial: { name: '15-day free trial', price: 0, days: num(process.env.TRIAL_DAYS, 15), km: 2, oneAd: true },
    day: { name: '1 Day', price: num(process.env.PRICE_DAY, 30), days: 1, km: 2, oneAd: true },
    week: { name: '7 Days', price: num(process.env.PRICE_WEEK, 100), days: 7, km: 2, oneAd: true },
    month: { name: 'Monthly', price: num(process.env.PRICE_MONTH, 299), days: 30, km: 2 },
    premium: { name: 'Premium', price: num(process.env.PRICE_PREMIUM, 499), days: 30, km: 5, featured: true },
  },
  AREA_SHARE: num(process.env.AREA_SHARE_PCT, 50) / 100, // area admin's share of plan payments
  DIGEST_HOUR: num(process.env.DIGEST_HOUR, 9), // IST
  MAX_RADIUS_KM: 5,
};
