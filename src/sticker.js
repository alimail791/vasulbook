// Shop sticker poster (PDF) to bring in advertisers. EDeal colours, Tamil + English, large type to read from a distance.
// Highlights: 15 days free, reach within 5 km, and every live category (from the database) as colour-coded chips.
// /sticker.pdf (A4) · /sticker.pdf?size=A5 · /sticker/CODE.pdf (QR carries a zone admin's referral code)
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cfg = require('./config');
const db = require('./db');
const i18n = require('./strings');

const ORANGE = '#c2410c', DEEP = '#9a3412', YELLOW = '#facc15', BROWN = '#431407', CREAM = '#fff7ed', PEACH = '#fed7aa', INK = '#1c1917';
const F = (n) => path.join(__dirname, '..', 'fonts', n);
const LOGO = path.join(__dirname, '..', 'public', 'edeal-logo.png');
const HELP = (process.env.HELP_PHONE || '9443424064').replace(/\D/g, '').slice(-10);
// group → chip colours [fill, English text, Tamil text]
const GROUPS = [
  ['shop', 'Shops & services', 'கடைகள் & சேவைகள்', [ORANGE, '#ffffff', '#fde68a']],
  ['edu', 'Education', 'கல்வி', [BROWN, '#ffffff', PEACH]],
  ['property', 'Property', 'சொத்து', [YELLOW, BROWN, DEEP]],
];
const TAMIL = /[஀-௿]/;
const RUNS = /[஀-௿]+(?:\s+[஀-௿]+)*|[^஀-௿]+/g;
const sp = (n) => `${n.slice(0, 5)} ${n.slice(5)}`;
const TA_DAYS = (d) => ({ 7: 'ஏழு நாள்', 10: 'பத்து நாள்', 14: 'பதினான்கு நாள்', 15: 'பதினைந்து நாள்', 30: 'முப்பது நாள்' }[d] || 'சில நாள்');

async function pdf({ size = 'A4', code = null } = {}) {
  const k = size === 'A5' ? 1 / 1.414 : 1; // A5 = A4 layout scaled down
  const bot = cfg.norm(process.env.BOT_PHONE || '').replace(/^91/, '');
  const link = `https://wa.me/91${bot}?text=${encodeURIComponent(code ? `business ref:${code}` : 'business')}`;
  const qr = await QRCode.toBuffer(link, { type: 'png', width: 800, margin: 1, errorCorrectionLevel: 'M', color: { dark: BROWN, light: '#ffffff' } });
  const cats = await db.all(`select name, coalesce(kind, case when edu then 'edu' else 'shop' end) kind from categories where active order by sort, name`);
  const trial = (cfg.PLANS.trial && cfg.PLANS.trial.days) || 15;

  return new Promise((resolve) => {
    const doc = new PDFDocument({ size, margin: 0 }), bufs = [];
    doc.on('data', (b) => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.registerFont('ta', F('noto-sans-tamil-tamil-400-normal.woff')); doc.registerFont('taB', F('noto-sans-tamil-tamil-700-normal.woff'));
    doc.registerFont('en', F('poppins-latin-400-normal.woff')); doc.registerFont('enS', F('poppins-latin-600-normal.woff')); doc.registerFont('enB', F('poppins-latin-800-normal.woff'));
    const W = doc.page.width, H = doc.page.height, X = (v) => v * k, M = X(24);

    const font = (r, bold) => (TAMIL.test(r) ? (bold ? 'taB' : 'ta') : (bold ? 'enS' : 'en'));
    const widthAt = (str, size, bold) => (String(str).match(RUNS) || []).reduce((t, r) => t + doc.font(font(r, bold)).fontSize(X(size)).widthOfString(r), 0);
    const fitSize = (str, max, w, bold) => { let s = max; while (s > 6 && widthAt(str, s, bold) > w) s -= 0.25; return s; };
    // One line of mixed Tamil/English drawn run by run (so digits and & show in Tamil lines). align: left | center | right
    const line = (str, x, y, w, o = {}) => {
      const size = o.fit ? fitSize(str, o.size, w, o.bold) : o.size;
      const tw = widthAt(str, size, o.bold);
      let cx = o.align === 'center' ? x + (w - tw) / 2 : o.align === 'right' ? x + w - tw : x;
      for (const r of String(str).match(RUNS) || []) {
        doc.font(font(r, o.bold)).fontSize(X(size)).fillColor(o.color || INK).text(r, cx, y, { lineBreak: false });
        cx += doc.widthOfString(r);
      }
    };
    const taName = (n) => { const t = i18n.tr('ta', n); return t && t !== n ? t : ''; };

    doc.rect(0, 0, W, H).fill(CREAM);

    // ---------------- header band
    const bandH = X(272);
    doc.rect(0, 0, W, bandH).fill(ORANGE);
    doc.save().fillOpacity(0.16).circle(W - X(20), X(260), X(130)).fill(YELLOW).restore();
    doc.save().fillOpacity(0.10).circle(X(-30), X(40), X(80)).fill('#ffffff').restore();
    doc.image(LOGO, M, X(18), { width: X(100) });
    line('FOR SHOPS · TUTORS · PROPERTY OWNERS', M + X(112), X(34), W - M - X(112) - X(170), { size: 11, bold: true, color: PEACH, fit: true });
    line('உங்கள் கடைக்கு அதிக வாடிக்கையாளர்கள்', M + X(112), X(56), W - M - X(112) - X(170), { size: 14, bold: true, color: '#ffffff', fit: true });
    const hs = fitSize('Reach every customer', 40, W - 2 * M, true);
    doc.font('enB').fontSize(X(hs)).fillColor('#ffffff').text('Reach every customer', M, X(140), { lineBreak: false });
    doc.text('within ', M, X(140) + X(hs) * 1.15, { lineBreak: false });
    doc.fillColor(YELLOW).text('5 km', M + doc.widthOfString('within '), X(140) + X(hs) * 1.15, { lineBreak: false });
    line('5 கி.மீ.-க்குள் உள்ள அனைவருக்கும் உங்கள் விளம்பரம்', M, X(236), W - 2 * M, { size: 18, bold: true, color: '#ffffff', fit: true });

    // FREE badge (big, tilted, top right)
    const bx = W - X(92), by = X(76), br = X(66);
    doc.circle(bx, by, br + X(7)).fill(DEEP);
    doc.circle(bx, by, br).fill(YELLOW);
    doc.save().rotate(-10, { origin: [bx, by] });
    line('FREE', bx - br, by - X(48), 2 * br, { size: 38, bold: true, color: BROWN, align: 'center' });
    line(`${trial} DAYS`, bx - br, by + X(2), 2 * br, { size: 19, bold: true, color: BROWN, align: 'center' });
    line(`${TA_DAYS(trial)} இலவசம்`, bx - br + X(10), by + X(28), 2 * br - X(20), { size: 11, bold: true, color: DEEP, align: 'center', fit: true });
    doc.restore();

    // ---------------- free strip
    let y = bandH + X(12);
    doc.roundedRect(M, y, W - 2 * M, X(66), X(14)).fill(YELLOW);
    line(`First ${trial} days FREE — post your ad today!`, M + X(10), y + X(7), W - 2 * M - X(20), { size: 22, bold: true, color: BROWN, align: 'center', fit: true });
    line(`முதல் ${TA_DAYS(trial)} முற்றிலும் இலவசம் · இன்றே பதிவிடுங்கள்`, M + X(10), y + X(38), W - 2 * M - X(20), { size: 15, bold: true, color: DEEP, align: 'center', fit: true });
    y += X(76);

    // ---------------- two benefits (short, big)
    const cw = (W - 2 * M - X(12)) / 2, ch = X(60);
    [['Real customer leads', 'நேரடி வாடிக்கையாளர் லீட்ஸ்'], ['No pamphlets, no printing', 'நோட்டீஸ் அச்சடிக்கத் தேவையில்லை']].forEach(([en, ta], i) => {
      const x = M + i * (cw + X(12));
      doc.roundedRect(x, y, cw, ch, X(14)).fill('#ffffff');
      doc.roundedRect(x, y, cw, ch, X(14)).lineWidth(X(2)).stroke(ORANGE);
      doc.circle(x + X(26), y + ch / 2, X(15)).fill(ORANGE);
      doc.font('enB').fontSize(X(15)).fillColor('#ffffff').text(String(i + 1), x + X(11), y + ch / 2 - X(10), { width: X(30), align: 'center', lineBreak: false });
      line(en, x + X(50), y + X(8), cw - X(60), { size: 16, bold: true, color: INK, fit: true });
      line(ta, x + X(50), y + X(34), cw - X(60), { size: 13, bold: true, color: ORANGE, fit: true });
    });
    y += ch + X(14);

    // ---------------- categories as colour-coded chips (live from the database)
    line('Advertise in any category', M, y, W, { size: 24, bold: true, color: ORANGE });
    line('எந்த வகையிலும் விளம்பரம் செய்யலாம்', M, y + X(33), W, { size: 15, bold: true, color: BROWN });
    // small colour key on the right
    let ky = y + X(4);
    for (const [, en, , [fill]] of GROUPS) {
      doc.roundedRect(W - M - X(130), ky + X(1), X(12), X(12), X(3)).fill(fill);
      line(en, W - M - X(112), ky, X(112), { size: 10.5, bold: true, color: INK, fit: true });
      ky += X(17);
    }
    y += X(62);
    const qrH = X(142), area = H - qrH - X(24) - y;
    const chips = GROUPS.flatMap(([kd, , , col]) => cats.filter((c) => c.kind === kd).map((c) => ({ ...c, col })));
    for (const c of cats) if (!GROUPS.some(([kd]) => kd === c.kind)) chips.push({ ...c, col: GROUPS[0][3] });
    // largest chip text that still fits the space
    const layout = (fe) => {
      const ft = fe * 0.82, padX = X(12), h = X(fe) * 1.35 + X(ft) * 1.45 + X(10), gap = X(8), rows = [[]];
      let rw = 0;
      for (const c of chips) {
        const w = Math.max(widthAt(c.name, fe, true), widthAt(taName(c.name), ft, true)) + 2 * padX;
        if (rw + w > W - 2 * M && rows.at(-1).length) { rows.push([]); rw = 0; }
        rows.at(-1).push({ c, w }); rw += w + gap;
      }
      return { rows, h, gap, fe, ft, total: rows.length * (h + gap) - gap };
    };
    let L = layout(17); while (L.total > area && L.fe > 8) L = layout(L.fe - 0.5);
    let cy = y + Math.max(0, (area - L.total) / 2);
    L.rows.forEach((row, ri) => {
      const last = ri === L.rows.length - 1;
      const used = row.reduce((t, r) => t + r.w, 0) + L.gap * (row.length - 1);
      const extra = last ? 0 : (W - 2 * M - used) / row.length; // full rows stretch edge to edge
      let cx = M + (last ? (W - 2 * M - used) / 2 : 0);
      for (const { c, w } of row) {
        const ww = w + extra, [fill, te, tt] = c.col;
        doc.roundedRect(cx, cy, ww, L.h, X(12)).fill(fill);
        line(c.name, cx, cy + X(5), ww, { size: L.fe, bold: true, color: te, align: 'center' });
        const t = taName(c.name); if (t) line(t, cx, cy + X(5) + X(L.fe) * 1.35, ww, { size: L.ft, bold: true, color: tt, align: 'center' });
        cx += ww + L.gap;
      }
      cy += L.h + L.gap;
    });

    // ---------------- QR + how to join + help
    const qy = H - qrH - X(12);
    doc.roundedRect(M, qy, W - 2 * M, qrH, X(18)).fill(BROWN);
    doc.roundedRect(M + X(12), qy + X(12), qrH - X(24), qrH - X(24), X(10)).fill('#ffffff');
    doc.image(qr, M + X(18), qy + X(18), { width: qrH - X(36) });
    const tx = M + qrH + X(8), tw = W - 2 * M - qrH - X(22);
    line('SCAN or WhatsApp "business" to', tx, qy + X(12), tw, { size: 14, bold: true, color: PEACH, fit: true });
    doc.font('enB').fontSize(X(40)).fillColor(YELLOW).text(sp(bot), tx, qy + X(30), { lineBreak: false });
    line('இன்றே இலவசமாக பதிவிடுங்கள்', tx, qy + X(86), tw, { size: 15, bold: true, color: '#ffffff', fit: true });
    line(`Help · உதவி  ${sp(HELP)}`, tx, qy + X(112), tw, { size: 14, bold: true, color: PEACH, fit: true });
    doc.end();
  });
}

module.exports = { pdf };
