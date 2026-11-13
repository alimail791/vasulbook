// Invoice as PDF (served at /inv/<token>.pdf) and as WhatsApp text fallback.
const PDFDocument = require('pdfkit');
const cfg = require('./config');

const R = (n) => 'Rs. ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rs = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const d = (t) => new Date(t).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
const payLabel = (o) => (o.paid ? 'PAID' : o.mode === 'delivery' ? 'CASH ON DELIVERY' : 'PAY AT SHOP');

function text(o, s) {
  return `📄 *Invoice ${o.inv}*\n*${s.name}* · ${s.area || ''}\nOrder #${o.id} · ${d(o.created_at)}\nBill to: ${o.cust_name || ''} +${o.cust_phone}${o.addr ? '\n' + o.addr : ''}\n\n` +
    o.lines.map((l) => `${l.q} × ${l.name} @ ${rs(l.price)} = ${rs(l.q * l.price)}`).join('\n') +
    `\n\nSubtotal: ${rs(o.subtotal)}${o.del_fee ? `\nDelivery: ${rs(o.del_fee)}` : ''}\n*Total: ${rs(o.total)}* · ${payLabel(o)}`;
}

function pdf(o, s) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A5', margin: 36 });
    const bufs = [];
    doc.on('data', (b) => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.fontSize(16).font('Helvetica-Bold').text(s.name);
    doc.fontSize(9).font('Helvetica').fillColor('#555').text(`${s.area || ''}  ·  +${s.owner_phone}`);
    doc.moveDown(0.8).fillColor('#000').fontSize(12).font('Helvetica-Bold').text('TAX INVOICE / BILL');
    doc.fontSize(9).font('Helvetica').text(`Invoice: ${o.inv}    Order #${o.id}    Date: ${d(o.created_at)}`);
    doc.text(`Bill to: ${o.cust_name || 'Customer'}  +${o.cust_phone}`);
    if (o.addr) doc.text(`Deliver to: ${o.addr}`);
    doc.moveDown(0.6);
    const x = [36, 230, 290, 350];
    const y0 = doc.y;
    doc.font('Helvetica-Bold').text('Item', x[0], y0).text('Qty', x[1], y0).text('Rate', x[2], y0).text('Amount', x[3], y0, { width: 70, align: 'right' });
    doc.moveTo(36, doc.y + 2).lineTo(420, doc.y + 2).strokeColor('#ccc').stroke();
    doc.font('Helvetica');
    for (const l of o.lines) {
      const y = doc.y + 6;
      doc.text(l.name, x[0], y, { width: 190 }).text(String(l.q), x[1], y).text(R(l.price), x[2], y).text(R(l.q * l.price), x[3], y, { width: 70, align: 'right' });
    }
    doc.moveDown(0.8);
    const row = (k, v, b) => { const y = doc.y + 2; doc.font(b ? 'Helvetica-Bold' : 'Helvetica').text(k, 230, y).text(v, x[3], y, { width: 70, align: 'right' }); };
    row('Subtotal', R(o.subtotal));
    if (o.del_fee) row('Home delivery', R(o.del_fee));
    row('Total', R(o.total), true);
    doc.moveDown(1).font('Helvetica-Bold').fontSize(10).text(payLabel(o) + '  ·  ' + (o.mode === 'delivery' ? 'Home delivery' : 'Store pickup'), 36);
    doc.moveDown(2).font('Helvetica').fontSize(8).fillColor('#777').text(`Ordered on WhatsApp via ${cfg.BRAND}`, 36);
    doc.end();
  });
}

module.exports = { text, pdf };
