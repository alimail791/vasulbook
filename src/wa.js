// WhatsApp Cloud API sender. Turns [label, id] button lists into the right
// WhatsApp format: up to 3 short labels -> reply buttons, otherwise a list.
const cfg = require('./config');

let sink = null; // tests capture outbound messages here
const setSink = (fn) => { sink = fn; };

const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function api(body) {
  if (sink) return sink(body);
  if (!cfg.WA_TOKEN || !cfg.WA_PHONE_ID) { console.log('[WA dry-run]', JSON.stringify(body)); return {}; }
  const r = await fetch(`https://graph.facebook.com/${cfg.WA_API_VERSION}/${cfg.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error ? j.error.message : 'HTTP ' + r.status);
    e.code = j.error && j.error.code;
    throw e;
  }
  return j;
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

// buttons: array of [label, id]; at most 10 here (paging is done by the bot layer)
async function send(to, text, buttons = []) {
  text = text || '👇';
  if (!buttons.length) return sendText(to, text);
  let body = text;
  if (body.length > 1024) { await sendText(to, body); body = 'Choose an option 👇'; }
  if (buttons.length <= 3 && buttons.every(([l]) => l.length <= 20)) {
    return api({
      to, type: 'interactive',
      interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.map(([l, id]) => ({ type: 'reply', reply: { id: cut(id, 256), title: l } })) } },
    });
  }
  const rows = buttons.slice(0, 10).map(([l, id]) => {
    const r = { id: cut(id, 200), title: cut(l, 24) };
    if (l.length > 24) r.description = cut(l, 72);
    return r;
  });
  return api({
    to, type: 'interactive',
    interactive: { type: 'list', body: { text: body }, action: { button: 'Choose', sections: [{ title: 'Options', rows }] } },
  });
}

async function sendDoc(to, link, filename, caption) {
  return api({ to, type: 'document', document: { link, filename, caption: cut(caption || '', 1000) } });
}

// Business-initiated message outside the 24h window needs an approved template.
async function sendTemplate(to, text) {
  if (!cfg.WA_TEMPLATE) throw new Error('No WA_NOTIFY_TEMPLATE configured');
  const param = cut(String(text).replace(/\s*\n+\s*/g, ' · ').replace(/\s{4,}/g, ' '), 1000);
  return api({
    to, type: 'template',
    template: { name: cfg.WA_TEMPLATE, language: { code: cfg.WA_TEMPLATE_LANG }, components: [{ type: 'body', parameters: [{ type: 'text', text: param }] }] },
  });
}

async function markRead(id) {
  if (sink || !cfg.WA_TOKEN) return;
  try { await api({ status: 'read', message_id: id }); } catch (_) { /* ignore */ }
}

module.exports = { send, sendText, sendDoc, sendTemplate, markRead, setSink };
