// Printable A4 poster (PDF) and QR image for a zone admin's referral link.
// English only: the built-in PDF font has no Tamil letters.
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const cfg = require('./config');
const network = require('./network');

const COPY = {
  emart: { color: '#166534', head: 'Order from shops near you', sub: 'on WhatsApp', points: ['Groceries, vegetables, dairy and more', 'Pickup or home delivery', 'Pay by UPI or cash, invoice in chat'], cta: 'Scan to start ordering' },
  edeal: { color: '#ea580c', head: 'Offers, deals and homes near you', sub: 'on WhatsApp', points: ['Shops: post your offers - 15 days free', 'Tuition, schools, events, houses for rent', 'Customers within 2-5 km see them daily'], cta: 'Scan to see offers or advertise' },
};

const qrPng = (link) => QRCode.toBuffer(link, { type: 'png', width: 600, margin: 1, errorCorrectionLevel: 'M' });

async function pdf(zone, kind, name) {
  const c = COPY[kind], link = network.refLink(zone, kind === 'edeal' ? 'business' : 'Hi');
  const qr = await qrPng(link);
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 }), bufs = [];
    doc.on('data', (b) => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs)));
    const W = 595.28;
    doc.rect(0, 0, W, 150).fill(c.color);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(38).text(cfg.BRAND, 0, 40, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(15).text(`${zone.name} zone`, 0, 92, { width: W, align: 'center' });
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(26).text(c.head, 40, 185, { width: W - 80, align: 'center' });
    doc.font('Helvetica').fontSize(18).fillColor('#444').text(c.sub, 40, 220, { width: W - 80, align: 'center' });
    doc.image(qr, (W - 260) / 2, 265, { width: 260 });
    doc.font('Helvetica-Bold').fontSize(16).fillColor(c.color).text(c.cta, 0, 540, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(14).fillColor('#222');
    let y = 590; for (const p of c.points) { doc.text('-  ' + p, 90, y, { width: W - 180 }); y += 26; }
    doc.rect(40, 700, W - 80, 90).lineWidth(1.5).stroke(c.color);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text('Your local admin', 60, 716);
    doc.font('Helvetica').fontSize(18).text(`${name ? name + '  ·  ' : ''}+${zone.admin_phone || ''}`, 60, 738);
    doc.fontSize(11).fillColor('#555').text(`Code ${zone.ref_code}`, 60, 764);
    doc.fontSize(9).fillColor('#888').text(link, 40, 805, { width: W - 80, align: 'center' });
    doc.end();
  });
}
module.exports = { pdf, qrPng };
