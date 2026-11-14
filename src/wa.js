// WhatsApp Cloud API sender. Turns [label, id] button lists into the right
// WhatsApp format: up to 3 short labels -> reply buttons, otherwise a list.
const cfg = require('./config');

let sink = null; // tests capture outbound messages here
const setSink = (fn) => { sink = fn; };

const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function graph(path, opts = {}) {
  const r = await fetch(`https://graph.facebook.com/${cfg.WA_API_VERSION}/${path}`, {
    ...opts, headers: { Authorization: 'Bearer ' + cfg.WA_TOKEN, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({ status: r.status }));
  if (!r.ok) { const e = new Error(j.error ? j.error.message : 'HTTP ' + r.status); e.code = j.error && j.error.code; throw e; }
  return j;
}

async function api(body) {
  if (sink) return sink(body);
  if (!cfg.WA_TOKEN || !cfg.WA_PHONE_ID) { console.log('[WA dry-run]', JSON.stringify(body)); return {}; }
  return graph(`${cfg.WA_PHONE_ID}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', ...body }) });
}

function chunks(text, n = 4000) {
  const out = [];
  let t = String(text);
  while (t.length > n) { let i = t.lastIndexOf('\n', n); if (i < n / 2) i = n; out.push(t.slice(0, i)); t = t.slice(i); }
  if (t.trim()) out.push(t);
  return out;
}

async function sendText(to, text) {
  for (const c of chunks(text)) await api({ to, type: 'text', text: { body: c, preview_url: true } });
}

const fitsButtons = (buttons) => buttons.length <= 3 && buttons.every(([l]) => l.length <= 20);

// buttons: array of [label, id]; at most 10 (paging is done by the bot layer)
// image: optional public image URL shown above the text (only with ≤3 short buttons)
async function send(to, text, buttons = [], image = null) {
  text = text || '👇';
  if (!buttons.length) {
    if (image) return api({ to, type: 'image', image: { link: image, caption: cut(text, 1024) } });
    return sendText(to, text);
  }
  let body = text;
  if (body.length > 1024) { await sendText(to, body); body = 'Choose an option 👇'; }
  if (fitsButtons(buttons)) {
    const interactive = { type: 'button', body: { text: body }, action: { buttons: buttons.map(([l, id]) => ({ type: 'reply', reply: { id: cut(id, 256), title: l } })) } };
    if (image) interactive.header = { type: 'image', image: { link: image } };
    return api({ to, type: 'interactive', interactive });
  }
  if (image) await api({ to, type: 'image', image: { link: image } });
  const rows = buttons.slice(0, 10).map(([l, id]) => {
    const r = { id: cut(id, 200), title: cut(l, 24) };
    if (l.length > 24) r.description = cut(l, 72);
    return r;
  });
  return api({ to, type: 'interactive', interactive: { type: 'list', body: { text: body }, action: { button: 'Choose', sections: [{ title: 'Options', rows }] } } });
}

// "Send location" button (WhatsApp location request message)
async function askLocation(to, text) {
  return api({ to, type: 'interactive', interactive: { type: 'location_request_message', body: { text: cut(text, 1024) }, action: { name: 'send_location' } } });
}

// A map pin the user can tap to open Google Maps
async function sendLocation(to, lat, lng, name, address) {
  return api({ to, type: 'location', location: { latitude: lat, longitude: lng, name: cut(name, 100), address: cut(address || '', 200) } });
}

// Business-initiated message outside the 24h window needs an approved template.
async function sendTemplate(to, text, name = cfg.WA_TEMPLATE) {
  if (!name) throw new Error('No template configured');
  const param = cut(String(text).replace(/\s*\n+\s*/g, ' · ').replace(/\s{4,}/g, ' '), 1000);
  return api({ to, type: 'template', template: { name, language: { code: cfg.WA_TEMPLATE_LANG }, components: [{ type: 'body', parameters: [{ type: 'text', text: param }] }] } });
}

async function markRead(id) {
  if (sink || !cfg.WA_TOKEN) return;
  try { await api({ status: 'read', message_id: id }); } catch (_) { /* ignore */ }
}

// Download a photo the user sent (returns { mime, data: Buffer })
async function downloadMedia(id) {
  if (sink || !cfg.WA_TOKEN) return null;
  const meta = await graph(id);
  const r = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + cfg.WA_TOKEN } });
  if (!r.ok) throw new Error('media download ' + r.status);
  return { mime: meta.mime_type || 'image/jpeg', data: Buffer.from(await r.arrayBuffer()) };
}

module.exports = { send, sendText, askLocation, sendLocation, sendTemplate, markRead, downloadMedia, graph, setSink, cut };
