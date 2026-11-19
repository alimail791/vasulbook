// Printable A4 poster (PDF) and QR image for a zone admin's referral link.
// Tamil and English. Tamil uses Noto Sans Tamil (fonts/, SIL Open Font License); English uses Helvetica.
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cfg = require('./config');
const network = require('./network');

const TA = path.join(__dirname, '..', 'fonts', 'noto-sans-tamil-tamil-400-normal.woff');
const TA_B = path.join(__dirname, '..', 'fonts', 'noto-sans-tamil-tamil-700-normal.woff');

// Each line: [Tamil, English]. The Tamil font file has only Tamil letters and spaces: no digits, commas or full stops in Tamil lines.
const COPY = {
  emart: {
    color: '#166534',
    head: ['அருகிலுள்ள கடைகளில் வாட்ஸ்அப்பில் ஆர்டர் செய்யுங்கள்', 'Order from shops near you on WhatsApp'],
    points: [['மளிகை காய்கறி பால் பொருட்கள் மற்றும் பல', 'Groceries, vegetables, dairy and more'],
      ['கடையில் வாங்கலாம் அல்லது வீட்டுக்கே டெலிவரி', 'Pickup or home delivery'],
      ['யுபிஐ அல்லது ரொக்கமாக செலுத்தலாம்', 'Pay by UPI or cash, invoice in chat']],
    cta: ['ஸ்கேன் செய்து ஆர்டர் செய்யுங்கள்', 'Scan to start ordering'],
  },
  edeal: {
    color: '#ea580c',
    head: ['அருகிலுள்ள சலுகைகள் நிகழ்வுகள் மற்றும் வீடுகள்', 'Offers, events and homes near you on WhatsApp'],
    points: [['கடைகள் தங்கள் சலுகைகளை பதினைந்து நாள் இலவசமாக பதிவிடலாம்', 'Shops: post your offers, 15 days free'],
      ['டியூஷன் பள்ளிகள் நிகழ்வுகள் மற்றும் வாடகை வீடுகள்', 'Tuition, schools, events, houses for rent'],
      ['அருகில் உள்ளவர்கள் தினமும் பார்ப்பார்கள்', 'People within 2-5 km see them every day']],
    cta: ['ஸ்கேன் செய்து சலுகைகளை பாருங்கள் அல்லது விளம்பரம் செய்யுங்கள்', 'Scan to see offers or advertise'],
  },
};

const qrPng = (link) => QRCode.toBuffer(link, { type: 'png', width: 600, margin: 1, errorCorrectionLevel: 'M' });

async function pdf(zone, kind, name) {
  const c = COPY[kind], link = network.refLink(zone, kind === 'edeal' ? 'business' : 'Hi');
  const qr = await qrPng(link);
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 }), bufs = [];
    doc.on('data', (b) => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.registerFont('ta', TA); doc.registerFont('taB', TA_B);
    const W = 595.28, center = { width: W - 80, align: 'center' };
    doc.rect(0, 0, W, 130).fill(c.color);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(38).text(cfg.BRAND, 0, 34, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(15).text(`${zone.name} zone`, 0, 84, { width: W, align: 'center' });
    doc.fillColor('#111').font('taB').fontSize(22).text(c.head[0], 40, 158, center);
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#333').text(c.head[1], 40, doc.y + 6, center);
    const qy = doc.y + 16;
    doc.image(qr, (W - 230) / 2, qy, { width: 230 });
    doc.font('taB').fontSize(15).fillColor(c.color).text(c.cta[0], 40, qy + 242, center);
    doc.font('Helvetica-Bold').fontSize(13).text(c.cta[1], 40, doc.y + 2, center);
    let y = doc.y + 18;
    for (const [ta, en] of c.points) {
      doc.circle(72, y + 9, 3).fill(c.color);
      doc.fillColor('#111').font('ta').fontSize(13).text(ta, 86, y, { width: W - 150 });
      doc.fillColor('#555').font('Helvetica').fontSize(11).text(en, 86, doc.y + 1, { width: W - 150 });
      y = doc.y + 10;
    }
    const by = Math.max(y + 8, 690);
    doc.rect(40, by, W - 80, 96).lineWidth(1.5).stroke(c.color);
    doc.fillColor('#111').font('taB').fontSize(12).text('உங்கள் பகுதி நிர்வாகி', 60, by + 12);
    doc.font('Helvetica').fontSize(10).fillColor('#555').text('Your local admin', 60, doc.y);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text(`${name ? name + '  -  ' : ''}+${zone.admin_phone || ''}`, 60, doc.y + 4);
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(`Code ${zone.ref_code}`, 60, doc.y + 2);
    doc.fontSize(8).fillColor('#999').text(link, 40, 812, { width: W - 80, align: 'center', lineBreak: false });
    doc.end();
  });
}
module.exports = { pdf, qrPng };
