// Shop sticker poster (PDF) to bring in advertisers: EDeal colours, logo, QR to the bot,
// live category list and plan prices from the database, and the help number.
// /sticker.pdf (A5) · /sticker.pdf?size=A4 · /sticker/CODE.pdf (QR carries a zone admin's referral code)
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cfg = require('./config');
const db = require('./db');

const ORANGE = '#c2410c', YELLOW = '#facc15', BROWN = '#431407', CREAM = '#fff7ed', PEACH = '#fed7aa';
const LOGO = path.join(__dirname, '..', 'public', 'edeal-logo.png');
const TA = path.join(__dirname, '..', 'fonts', 'noto-sans-tamil-tamil-400-normal.woff');
const TA_B = path.join(__dirname, '..', 'fonts', 'noto-sans-tamil-tamil-700-normal.woff');
const HELP = (process.env.HELP_PHONE || '9443424064').replace(/\D/g, '').slice(-10);
const GROUPS = [['shop', 'Shops & services'], ['edu', 'Tuition, schools & classes'], ['property', 'Homes & property']];

// Tamil lines: Tamil letters and spaces only (the font file has no digits or punctuation)
const TXT = {
  head: ['உங்கள் கடை சலுகைகளை இங்கே பதிவிடுங்கள்', 'Post your offers here'],
  free: ['முதல் பதினைந்து நாள் இலவசம்', 'First 15 days FREE'],
  reach: ['அருகிலுள்ள மக்கள் தினமும் வாட்ஸ்அப்பில் பார்ப்பார்கள்', 'People within 2-5 km see them daily on WhatsApp'],
  scan: ['ஸ்கேன் செய்து அனுப்புங்கள்', 'Scan, then tap Send on WhatsApp'],
  cats: ['யார் விளம்பரம் செய்யலாம்', 'Who can advertise'],
  help: ['உதவிக்கு அழைக்கவும்', 'Help / call or WhatsApp'],
};

async function pdf({ size = 'A5', code = null } = {}) {
  const s = size === 'A4' ? 1.414 : 1; // A4 is the A5 layout scaled up
  const text = encodeURIComponent(code ? `business ref:${code}` : 'business');
  const link = `https://wa.me/${cfg.norm(process.env.BOT_PHONE || '')}?text=${text}`;
  const qr = await QRCode.toBuffer(link, { type: 'png', width: 700, margin: 1, errorCorrectionLevel: 'M', color: { dark: BROWN, light: '#ffffff' } });
  const cats = await db.all(`select name, coalesce(kind, case when edu then 'edu' else 'shop' end) kind from categories where active order by sort, name`);
  const P = await db.plans();
  const price = (k) => (P[k] ? `Rs ${P[k].price}` : '');

  return new Promise((resolve) => {
    const doc = new PDFDocument({ size, margin: 0 }), bufs = [];
    doc.on('data', (b) => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.registerFont('ta', TA); doc.registerFont('taB', TA_B);
    const W = doc.page.width, H = doc.page.height, m = 22 * s, X = (v) => v * s;
    const two = (ta, en, y, o) => {
      doc.font(o.taFont || 'taB').fontSize(X(o.ta)).fillColor(o.color || BROWN).text(ta, m, y, { width: W - 2 * m, align: 'center' });
      doc.font(o.enFont || 'Helvetica-Bold').fontSize(X(o.en)).fillColor(o.enColor || o.color || BROWN).text(en, m, doc.y + X(1), { width: W - 2 * m, align: 'center' });
      return doc.y;
    };

    // background + top band with logo
    doc.rect(0, 0, W, H).fill(CREAM);
    doc.rect(0, 0, W, X(92)).fill(ORANGE);
    doc.image(LOGO, (W - X(80)) / 2, X(6), { width: X(80) });
    let y = X(100);
    y = two(TXT.head[0], TXT.head[1], y, { ta: 15, en: 13 });
    // FREE ribbon
    const ry = y + X(5), rh = X(38);
    doc.roundedRect(m + X(30), ry, W - 2 * m - X(60), rh, X(10)).fill(YELLOW);
    doc.font('taB').fontSize(X(12)).fillColor(BROWN).text(TXT.free[0], m, ry + X(5), { width: W - 2 * m, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(X(12)).text(TXT.free[1], m, doc.y, { width: W - 2 * m, align: 'center' });
    y = two(TXT.reach[0], TXT.reach[1], ry + rh + X(6), { ta: 9.5, en: 9, taFont: 'ta', enFont: 'Helvetica', color: '#57534e' });

    // QR card
    const q = X(108), qy = y + X(12), qx = (W - q) / 2;
    doc.roundedRect(qx - X(8), qy - X(8), q + X(16), q + X(16), X(10)).fill('#ffffff');
    doc.roundedRect(qx - X(8), qy - X(8), q + X(16), q + X(16), X(10)).lineWidth(X(2)).stroke(ORANGE);
    doc.image(qr, qx, qy, { width: q });
    y = two(TXT.scan[0], TXT.scan[1], qy + q + X(13), { ta: 10.5, en: 9.5, color: ORANGE });

    // plans
    const plans = [['1 day', price('day')], ['7 days', price('week')], ['Month', price('month')], ['Premium', price('premium')]].filter(([, p]) => p);
    const pw = (W - 2 * m) / plans.length, py = y + X(8);
    plans.forEach(([n, p], i) => {
      const x = m + i * pw;
      doc.roundedRect(x + X(3), py, pw - X(6), X(30), X(6)).fill(i === plans.length - 1 ? BROWN : '#ffffff');
      doc.font('Helvetica-Bold').fontSize(X(10)).fillColor(i === plans.length - 1 ? YELLOW : ORANGE).text(p, x, py + X(5), { width: pw, align: 'center' });
      doc.font('Helvetica').fontSize(X(7.5)).fillColor(i === plans.length - 1 ? '#fff' : '#57534e').text(n, x, py + X(18), { width: pw, align: 'center' });
    });

    // categories (from the database, grouped)
    const helpH = X(42), cy0 = py + X(38), boxH = H - helpH - X(14) - cy0;
    doc.roundedRect(m, cy0, W - 2 * m, boxH, X(10)).fill('#ffffff');
    doc.font('taB').fontSize(X(9.5)).fillColor(BROWN).text(TXT.cats[0], m, cy0 + X(6), { width: W - 2 * m, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(X(9)).text(TXT.cats[1], m, doc.y, { width: W - 2 * m, align: 'center' });
    const groups = GROUPS.map(([k, label]) => [label, cats.filter((c) => c.kind === k).map((c) => c.name)]).filter(([, n]) => n.length);
    const other = cats.filter((c) => !GROUPS.some(([k]) => k === c.kind)).map((c) => c.name);
    if (other.length) groups.push(['More', other]);
    // shrink the type until every category fits in the box
    let fs = 8.5;
    const fit = (f) => {
      let h = 0; doc.font('Helvetica').fontSize(X(f));
      for (const [, names] of groups) h += X(f + 3) + doc.heightOfString(names.join('  ·  '), { width: W - 2 * m - X(20) }) + X(4);
      return h;
    };
    const room = cy0 + boxH - doc.y - X(8);
    while (fs > 5.5 && fit(fs) > room) fs -= 0.5;
    let gy = doc.y + X(4);
    for (const [label, names] of groups) {
      doc.font('Helvetica-Bold').fontSize(X(fs + 0.5)).fillColor(ORANGE).text(label, m + X(10), gy, { width: W - 2 * m - X(20) });
      doc.font('Helvetica').fontSize(X(fs)).fillColor('#292524').text(names.join('  ·  '), m + X(10), doc.y + X(1), { width: W - 2 * m - X(20) });
      gy = doc.y + X(4);
    }

    // help strip
    const hy = H - helpH - X(6);
    doc.roundedRect(m, hy, W - 2 * m, helpH, X(10)).fill(BROWN);
    doc.font('taB').fontSize(X(9)).fillColor(PEACH).text(TXT.help[0], m + X(14), hy + X(7));
    doc.font('Helvetica').fontSize(X(8)).fillColor(PEACH).text(TXT.help[1], m + X(14), doc.y);
    doc.font('Helvetica-Bold').fontSize(X(17)).fillColor(YELLOW).text(`${HELP.slice(0, 5)} ${HELP.slice(5)}`, m, hy + X(13), { width: W - 2 * m - X(14), align: 'right' });
    doc.end();
  });
}

module.exports = { pdf };
