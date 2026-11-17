// Languages for customers and advertisers: English, Tamil, Hindi.
// Messages are written in English in the code; just before sending, each line is translated
// using the phrase list (exact lines, or patterns with {placeholders}). Lines without a
// translation (e.g. an ad's own text) stay as they are, so nothing ever breaks.
const LANGS = { en: 'English', ta: 'தமிழ்', hi: 'हिंदी' };

const exact = { ta: new Map(), hi: new Map() };
let patterns = []; // { re, vars, ta, hi, weight }
const terms = { ta: new Map(), hi: new Map() };

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function add(list) {
  for (const [en, ta, hi] of list) {
    if (!en.includes('{')) { if (ta) exact.ta.set(en, ta); if (hi) exact.hi.set(en, hi); continue; }
    const vars = [];
    const re = new RegExp('^' + en.split(/(\{\w+\})/).map((p) => { const m = p.match(/^\{(\w+)\}$/); if (m) { vars.push(m[1]); return '(.+?)'; } return escRe(p); }).join('') + '$', 's');
    patterns.push({ re, vars, ta, hi, weight: en.replace(/\{\w+\}/g, '').length });
  }
  patterns.sort((a, b) => b.weight - a.weight);
}
// Words that may appear inside a line (category names, plan names, statuses…)
function addTerms(list) { for (const [en, ta, hi] of list) { if (ta) terms.ta.set(en, ta); if (hi) terms.hi.set(en, hi); } }
const term = (lang, s) => (lang === 'en' ? s : (terms[lang] && terms[lang].get(s)) || s);
// A captured piece of a line: translate it if it is a known phrase, a known word, or "emoji + known word"
function piece(lang, s) {
  if (exact[lang].has(s)) return exact[lang].get(s);
  if (terms[lang].has(s)) return terms[lang].get(s);
  const m = s.match(/^(\S+) (.+)$/);
  if (m && terms[lang].has(m[2])) return m[1] + ' ' + terms[lang].get(m[2]);
  return s;
}

function line(lang, s) {
  if (!s.trim()) return s;
  const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0], core = s.trim();
  const ex = exact[lang].get(core);
  if (ex) return lead + ex + trail;
  if (terms[lang].has(core)) return lead + terms[lang].get(core) + trail;
  for (const p of patterns) {
    const tpl = p[lang]; if (!tpl) continue;
    const m = core.match(p.re); if (!m) continue;
    const val = {}; p.vars.forEach((v, i) => { val[v] = m[i + 1]; });
    return lead + tpl.replace(/\{(\w+)\}/g, (_, k) => (k in val ? piece(lang, val[k]) : '')) + trail;
  }
  return s;
}
function tr(lang, text) {
  if (!text || !lang || lang === 'en' || !exact[lang]) return text;
  return String(text).split('\n').map((l) => line(lang, l)).join('\n');
}

// Guess the language from what someone typed
function detect(text) {
  const t = String(text || '');
  if (/[஀-௿]/.test(t)) return 'ta';
  if (/[ऀ-ॿ]/.test(t)) return 'hi';
  const low = t.trim().toLowerCase();
  if (/^(vanakkam|vanakam|vannakkam)\b/.test(low)) return 'ta';
  if (/^(namaste|namaskar|namasthe)\b/.test(low)) return 'hi';
  return null;
}
// Words people type in Tamil / Hindi that mean menu, stop, language
const WORDS = {
  menu: ['மெனு', 'வணக்கம்', 'ஹாய்', 'मेनू', 'नमस्ते', 'हाय', 'हेलो', 'vanakkam', 'vanakam', 'namaste', 'namaskar'],
  stop: ['நிறுத்து', 'நிறுத்தவும்', 'रोकें', 'बंद', 'बंद करें'],
  lang: ['language', 'lang', 'bhasha', 'மொழி', 'भाषा', 'tamil', 'hindi', 'english', 'தமிழ்', 'हिंदी', 'हिन्दी'],
};
const PICKER = '🌐 Choose your language\nமொழியைத் தேர்வு செய்யவும்\nअपनी भाषा चुनें';
const PICKER_BTNS = [['English', 'lang:en'], ['தமிழ்', 'lang:ta'], ['हिंदी', 'lang:hi']];

module.exports = { LANGS, add, addTerms, tr, term, detect, WORDS, PICKER, PICKER_BTNS };
