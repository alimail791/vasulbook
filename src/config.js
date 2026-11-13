// All settings come from environment variables (set them in Railway → Variables).
const norm = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  return d;
};

module.exports = {
  norm,
  PORT: process.env.PORT || 3000,
  DATABASE_URL: process.env.DATABASE_URL,

  // Meta WhatsApp Cloud API
  WA_TOKEN: process.env.WA_TOKEN || '',
  WA_PHONE_ID: process.env.WA_PHONE_NUMBER_ID || '',
  WA_VERIFY: process.env.WA_VERIFY_TOKEN || 'vasulbook-bazaar',
  WA_APP_SECRET: process.env.WA_APP_SECRET || '',
  WA_API_VERSION: process.env.WA_API_VERSION || 'v21.0',
  // Approved utility template with one body variable, used when a person
  // has not messaged the bot in the last 24 hours (Meta rule).
  WA_TEMPLATE: process.env.WA_NOTIFY_TEMPLATE || '',
  WA_TEMPLATE_LANG: process.env.WA_NOTIFY_TEMPLATE_LANG || 'en',

  // Admin(s): comma-separated phone numbers
  // Bot's own WhatsApp number is 9445775305 (set in Meta). Admins are separate numbers.
  ADMINS: (process.env.ADMIN_PHONES || '').split(',').map(norm).filter(Boolean),
  ADMIN_KEY: process.env.ADMIN_KEY || 'change-me',
  ADMIN_UPI: process.env.ADMIN_UPI || '',

  PUBLIC_URL: (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, ''),

  // Razorpay (optional) – for setup fee & commission payment links
  RZP_KEY: process.env.RAZORPAY_KEY_ID || '',
  RZP_SECRET: process.env.RAZORPAY_KEY_SECRET || '',
  RZP_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET || '',

  BRAND: process.env.BRAND || 'VasulBook Bazaar',
  SETUP_FEE: Number(process.env.SETUP_FEE || 2000),
  COMM: Number(process.env.COMMISSION_PCT || 2) / 100,
  DEFAULT_DEL_FEE: Number(process.env.DEFAULT_DELIVERY_FEE || 25),
};
