// Shop sticker poster (PDF) to bring in advertisers. EDeal colours, Tamil + English.
// Highlights: 15 days free, reach within 5 km, leads on WhatsApp, and every live category (from the database).
// /sticker.pdf (A4) · /sticker.pdf?size=A5 · /sticker/CODE.pdf (QR carries a zone admin's referral code)
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cfg = require('./config');
const db = require('./db');
const i18n = require('./strings');

const ORANGE = '#c2410c', YELLOW = '#facc15', BROWN = '#431407', CREAM = '#fff7ed', PEACH = '#fed7aa', INK = '#1c1917', GREY = '#57534e';
const F = (n) => path.join(__dirname, '..', 'fonts', n);
const LOGO = path.join(__dirname, '..', 'public', 'edeal-logo.png');
const HELP = (process.env.HELP_PHONE || '9443424064').replace(/\D/g, '').slice(-10);
const GROUPS = [['shop', 'Shops & services', 'கடைகள் & சேவைகள்'], ['edu', 'Education', 'கல்வி'], ['property', 'Property', 'சொத்து']];
const TAMIL = /[஀-௿]/;
const sp = (n) => `${n.slice(0, 5)} ${n.slice(5)}`;
const TA_DAYS = (d) => ({ 7: 'ஏழு நாள்', 10: 'பத்து நாள்', 14: 'பதினான்கு நாள்', 15: 'பதினைந்து நாள்', 30: 'முப்பது நாள்' }[d] || 'சில நாள்');

async function pdf({ size = 'A4', code = null } = {}) {
  const k = size === 'A5' ? 1 / 1.414 : 1; // A5 = A4 layout scaled down
  const bot = cfg.norm(process.env.BOT_PHONE || '').replace(/^91/, '');
  const link = `https://wa.me/91${bot}?text=${encodeURIComponent(code ? `business ref:${code}` : 'business')}`;
  const qr = await QRCode.toBuffer(link, { type: 'png', width: 700, margin: 1, errorCorrectionLevel: 'M', color: { dark: BROWN, light: '#ffffff' } });
  const cats = await db.all(`select name, coalesce(kind, case when edu then 'edu' else 'shop' end) kind from categories where active order by sort, name`);
  const trial = (cfg.PLANS.trial && cfg.PLANS.trial.days) || 15;

  return new Promise((resolve) => {
    const doc = new PDFDocument({ size, margin: 0 }), bufs = [];
    doc.on('data', (b) => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.registerFont('ta', F('noto-sans-tamil-tamil-400-normal.woff')); doc.registerFont('taB', F('noto-sans-tamil-tamil-700-normal.woff'));
    doc.registerFont('en', F('poppins-latin-400-normal.woff')); doc.registerFont('enS', F('poppins-latin-600-normal.woff')); doc.registerFont('enB', F('poppins-latin-800-normal.woff'));
    const W = doc.page.width, H = doc.page.height, X = (v) => v * k, M = X(28);

    // Text mixing Tamil with digits/punctuation: Tamil runs in Noto Sans Tamil, the rest in Poppins
    const mixed = (str, x, y, o = {}) => {
      const runs = String(str).match(/[஀-௿]+(?:\s+[஀-௿]+)*|[^஀-௿]+/g) || [];
      doc.fillColor(o.color || INK).fontSize(X(o.size || 10));
      runs.forEach((r, i) => {
        doc.font(TAMIL.test(r) ? (o.bold ? 'taB' : 'ta') : (o.bold ? 'enS' : 'en'));
        const opt = { continued: i < runs.length - 1, width: o.width, align: o.align || 'left' };
        if (i === 0) doc.text(r, x, y, opt); else doc.text(r, opt);
      });
      return doc.y;
    };
    // Width of a (possibly mixed) string, and the largest size up to max that fits in w on one line
    const runsOf = (str) => String(str).match(/[\u0B80-\u0BFF]+(?:\s+[\u0B80-\u0BFF]+)*|[^\u0B80-\u0BFF]+/g) || [];
    const widthAt = (str, size, bold) => runsOf(str).reduce((t, r) => t + doc.font(TAMIL.test(r) ? (bold ? 'taB' : 'ta') : (bold ? 'enS' : 'en')).fontSize(X(size)).widthOfString(r), 0);
    const fitSize = (str, max, w, bold) => { let s = max; while (s > 6 && widthAt(str, s, bold) > w) s -= 0.25; return s; };
    const taName = (n) => { const t = i18n.tr('ta', n); return t && t !== n ? t : ''; };

    // ---------------- top band: logo, headline, FREE badge
    const bandH = X(250);
    doc.rect(0, 0, W, H).fill(CREAM);
    doc.rect(0, 0, W, bandH).fill(ORANGE);
    doc.image(LOGO, M - X(6), X(54), { width: X(150) });
    const hx = M + X(160), hw = W - hx - X(150);
    doc.font('enS').fontSize(X(9)).fillColor(PEACH).text('FOR SHOPS, TUTORS & PROPERTY OWNERS', hx, X(28), { width: hw + X(130), characterSpacing: X(1.2) });
    doc.font('enB').fontSize(X(30)).fillColor('#ffffff').text('Reach every customer', hx, X(48), { width: hw + X(40), lineGap: -X(6) });
    doc.text('within ', hx, doc.y, { continued: true }).fillColor(YELLOW).text('5 km');
    mixed('5 கி.மீ.-க்குள் உள்ள அனைவருக்கும் உங்கள் விளம்பரம்', hx, doc.y + X(6), { size: 13, bold: true, color: '#ffffff', width: hw + X(10) });

    const bx = W - X(88), by = X(150), br = X(66);
    doc.circle(bx, by, br + X(6)).fill('#e07a4f');
    doc.circle(bx, by, br).fill(YELLOW);
    doc.font('enB').fontSize(X(31)).fillColor(BROWN).text('FREE', bx - br, by - X(44), { width: 2 * br, align: 'center' });
    doc.font('enB').fontSize(X(15)).text(`${trial} DAYS`, bx - br, by - X(8), { width: 2 * br, align: 'center' });
    // centred lines stay in one font (pdfkit can't centre mixed-font runs), so the Tamil spells the number out
    doc.font('taB').fontSize(X(9.5)).fillColor(BROWN).text(TA_DAYS(trial) + ' இலவசம்', bx - br + X(8), by + X(14), { width: 2 * br - X(16), align: 'center' });

    // ---------------- free strip
    let y = bandH + X(16);
    doc.roundedRect(M, y, W - 2 * M, X(46), X(12)).fill(YELLOW);
    doc.font('enB').fontSize(X(15)).fillColor(BROWN).text(`First ${trial} days FREE — post your ad today`, M, y + X(6), { width: W - 2 * M, align: 'center' });
    doc.font('taB').fontSize(X(10.5)).fillColor(BROWN).text(`முதல் ${TA_DAYS(trial)} முற்றிலும் இலவசம்  இன்றே பதிவிடுங்கள்`, M, doc.y - X(1), { width: W - 2 * M, align: 'center' });
    y += X(58);

    // ---------------- two benefit cards
    const cw = (W - 2 * M - X(12)) / 2, ch = X(80);
    const card = (x, title, ta, body) => {
      doc.roundedRect(x, y, cw, ch, X(12)).fillAndStroke('#ffffff', ORANGE);
      doc.roundedRect(x + X(12), y + X(12), X(6), ch - X(24), X(3)).fill(YELLOW);
      doc.font('enB').fontSize(X(12.5)).fillColor(INK).text(title, x + X(26), y + X(10), { width: cw - X(36) });
      mixed(ta, x + X(26), doc.y, { size: 9.5, bold: true, color: ORANGE, width: cw - X(36) });
      doc.font('en').fontSize(X(8.5)).fillColor(GREY).text(body, x + X(26), doc.y + X(2), { width: cw - X(36), lineGap: -X(1) });
    };
    card(M, 'Get real customer leads', 'நேரடி வாடிக்கையாளர் லீட்ஸ்', "Coupon, enquiry and visit requests reach your WhatsApp with the customer's name and number.");
    card(M + cw + X(12), 'No pamphlets, no printing', 'நோட்டீஸ் அச்சடிக்கத் தேவையில்லை', 'Your ad goes straight to phones nearby in the daily 9 AM offers message. Change it anytime.');
    y += ch + X(16);

    // ---------------- categories (highlighted, live from the database)
    doc.font('enB').fontSize(X(17)).fillColor(ORANGE).text('Advertise in any category', M, y);
    mixed('எந்த வகையிலும் விளம்பரம் செய்யலாம்', M + X(262), y + X(5), { size: 11, bold: true, color: BROWN });
    y += X(30);
    const groups = GROUPS.map(([kd, en, ta]) => [en, ta, cats.filter((c) => c.kind === kd)]);
    const extra = cats.filter((c) => !GROUPS.some(([kd]) => kd === c.kind));
    if (extra.length) groups[0][2].push(...extra);
    const qrH = X(128), colTop = y, colH = H - qrH - X(24) - colTop;
    // Long lists (shops) get a wider card split into two columns, so every name stays readable
    const subs = groups.map((g) => (g[2].length > 6 ? 2 : 1));
    const weight = groups.map((g, i) => (subs[i] === 2 ? 0.5 : g[2].length > 3 ? 0.34 : 0.21));
    const tot = weight.reduce((a, b) => a + b, 0), inner = W - 2 * M - X(20);
    const gws = weight.map((w) => (inner * w) / tot);
    const most = Math.max(...groups.map((g, i) => Math.ceil(g[2].length / subs[i])), 1);
    const itemH = Math.min(X(36), (colH - X(64)) / most);
    const fsEn = Math.min(11.5, (itemH / k) * 0.42), fsTa = fsEn * 0.85;
    let gx = M;
    groups.forEach(([en, ta, list], i) => {
      const x = gx, gw = gws[i]; gx += gw + X(10);
      const sw = (gw - X(16)) / subs[i], rows = Math.ceil(list.length / subs[i]);
      doc.roundedRect(x, colTop, gw, colH, X(12)).fillAndStroke('#ffffff', PEACH);
      doc.roundedRect(x + X(10), colTop + X(10), gw - X(20), X(40), X(8)).fill(ORANGE);
      doc.font('enB').fontSize(X(11)).fillColor('#ffffff').text(en, x + X(16), colTop + X(13), { width: gw - X(32) });
      mixed(ta, x + X(16), doc.y - X(2), { size: 9, bold: true, color: YELLOW, width: gw - X(32) });
      let iy = colTop + X(58);
      list.forEach((c, j) => {
        const cx = x + X(8) + Math.floor(j / rows) * sw, cy = iy + (j % rows) * itemH;
        doc.circle(cx + X(9), cy + X(fsEn) * 0.6, X(2.2)).fill(ORANGE);
        const tw2 = sw - X(20), s1 = fitSize(c.name, fsEn, tw2, true);
        doc.font('enS').fontSize(X(s1)).fillColor(INK).text(c.name, cx + X(16), cy, { width: tw2 + X(40), lineBreak: false });
        const t = taName(c.name); if (t) mixed(t, cx + X(16), cy + X(fsEn) * 1.25, { size: fitSize(t, fsTa, tw2, false), color: ORANGE, width: tw2 + X(40) });
      });
      iy += rows * itemH;
      if (i === 1) {
        const ny = Math.max(iy + X(6), colTop + colH - X(52));
        doc.roundedRect(x + X(8), ny, gw - X(16), X(42), X(8)).fill(CREAM);
        doc.font('enS').fontSize(X(fitSize('Need another category?', 8.5, gw - X(28), true))).fillColor(BROWN).text('Need another category?', x + X(14), ny + X(7), { width: gw, lineBreak: false });
        doc.font('en').fontSize(X(fitSize('Ask us, we will add it.', 8, gw - X(28), false))).fillColor(GREY).text('Ask us, we will add it.', x + X(14), ny + X(22), { width: gw, lineBreak: false });
      }
    });

    // ---------------- QR + how to join + help
    const qy = H - qrH - X(14);
    doc.roundedRect(M, qy, W - 2 * M, qrH, X(14)).fill(BROWN);
    doc.roundedRect(M + X(12), qy + X(12), qrH - X(24), qrH - X(24), X(8)).fill('#ffffff');
    doc.image(qr, M + X(18), qy + X(18), { width: qrH - X(36) });
    const tx = M + qrH + X(4), tw = W - 2 * M - qrH - X(16);
    doc.font('enS').fontSize(X(11)).fillColor(PEACH).text('Scan, or WhatsApp ', tx, qy + X(14), { continued: true }).fillColor(YELLOW).text('business', { continued: true }).fillColor(PEACH).text(' to');
    doc.font('enB').fontSize(X(28)).fillColor('#ffffff').text(sp(bot), tx, doc.y - X(2));
    mixed('இன்றே இலவசமாக பதிவிடுங்கள்', tx, doc.y - X(2), { size: 11, bold: true, color: YELLOW, width: tw });
    mixed(`Help · உதவி: ${sp(HELP)}`, tx, doc.y + X(4), { size: 10, bold: true, color: PEACH, width: tw });
    doc.end();
  });
}

module.exports = { pdf };
