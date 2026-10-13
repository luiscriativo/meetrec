// Lógica pura das pastas: nomes, glossário, correções na transcrição, vocabulário do Whisper,
// bloco estruturado que o Claude devolve no fim do resumo e os arquivos .md do contexto.
// Sem dependência do Electron para poder ser testada com `node --test`.

const CTX_DIR = '_contexto';
const MEETING_DIR = /^\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const DOUBT_KINDS = ['termo', 'nome', 'numero', 'falante', 'trecho'];

// Nome de pasta válido no Windows/macOS/Linux. Retorna { name } ou { error }.
function sanitizeFolderName(raw) {
  const name = String(raw ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!name) return { error: 'Dê um nome para a pasta.' };
  if (name.length > 60) return { error: 'Use um nome com até 60 caracteres.' };
  if (/^[._]/.test(name)) return { error: 'O nome não pode começar com "." ou "_".' };
  if (RESERVED.test(name)) return { error: `"${name}" é um nome reservado pelo Windows.` };
  if (MEETING_DIR.test(name)) return { error: 'Esse nome parece o de uma reunião. Escolha outro.' };
  return { name };
}

function emptyFolderData() {
  return {
    description: '',
    context: null,      // contexto aprovado { about, participants:[{name, role}], goals:[], notes }
    contextAt: null,
    draft: null,        // sugestão do Claude aguardando aprovação { ...context, fromMeeting, fromTitle, at, kind }
    glossary: [],       // [{ term, heard:[], uses, addedAt }] — só termos que o usuário confirmou
    history: '',        // decisões e pendências, mantido pelo Claude
    historyAt: null,
    createdAt: new Date().toISOString(),
  };
}

function normalizeFolderData(d) {
  const base = emptyFolderData();
  if (!d || typeof d !== 'object') return base;
  return {
    ...base,
    ...d,
    context: d.context ? normalizeContext(d.context) : null,
    draft: d.draft ? { ...d.draft, ...normalizeContext(d.draft) } : null,
    glossary: Array.isArray(d.glossary) ? d.glossary.filter((g) => g && g.term).map((g) => ({ term: String(g.term), heard: [...new Set((g.heard || []).map(String).filter(Boolean))], uses: g.uses || 1, addedAt: g.addedAt || null })) : [],
    history: typeof d.history === 'string' ? d.history : '',
  };
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

// Aceita o formato interno (inglês) e o que o Claude devolve (português).
function normalizeContext(c) {
  if (!c || typeof c !== 'object') return { about: '', participants: [], goals: [], notes: '' };
  const parts = c.participants ?? c.participantes ?? [];
  const goals = c.goals ?? c.objetivos ?? [];
  return {
    about: str(c.about ?? c.resumo ?? c.sobre),
    participants: (Array.isArray(parts) ? parts : []).map((p) => (typeof p === 'string' ? { name: p.trim(), role: '' } : { name: str(p?.name ?? p?.nome), role: str(p?.role ?? p?.papel) })).filter((p) => p.name),
    goals: (Array.isArray(goals) ? goals : String(goals).split('\n')).map(str).filter(Boolean),
    notes: str(c.notes ?? c.observacoes ?? c.observações),
  };
}

function contextIsEmpty(c) {
  return !c || (!c.about && !c.participants?.length && !c.goals?.length && !c.notes);
}

// ───────── Glossário ─────────
const low = (s) => String(s || '').toLowerCase().trim();
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Adiciona (ou reforça) um termo confirmado pelo usuário. `heard` = como o Whisper escreveu.
function addGlossaryTerm(glossary, { term, heard }) {
  term = str(term);
  heard = str(heard);
  if (!term) return glossary;
  const list = glossary.map((g) => ({ ...g, heard: [...g.heard] }));
  let entry = list.find((g) => norm(g.term) === norm(term));
  if (!entry) {
    entry = { term, heard: [], uses: 0, addedAt: new Date().toISOString() };
    list.push(entry);
  }
  entry.uses = (entry.uses || 0) + 1;
  // Variantes comparadas sem diferenciar maiúsculas, mas com acento ("Técios" e "Tecios" são duas grafias)
  if (heard && heard !== entry.term && !entry.heard.some((h) => low(h) === low(heard))) entry.heard.push(heard);
  // Um "ouvido como" não pode ser o termo correto de outra entrada (senão as trocas se anulariam)
  for (const g of list) if (g !== entry) g.heard = g.heard.filter((h) => low(h) !== low(term));
  return list;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Troca `from` por `to` respeitando limites de palavra (inclusive letras acentuadas).
function replaceWord(text, from, to) {
  if (!from || !to || from === to) return { text, count: 0 };
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(from)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
  let count = 0;
  const out = text.replace(re, (_m, pre) => { count++; return pre + to; });
  return { text: out, count };
}

// Pares { from, to } a partir das correções da reunião e do glossário (variantes mais longas primeiro).
function correctionPairs(glossary = [], corrections = []) {
  const pairs = [];
  for (const c of corrections || []) if (c?.heard && c?.answer) pairs.push({ from: c.heard, to: c.answer });
  for (const g of glossary || []) for (const h of g.heard || []) pairs.push({ from: h, to: g.term });
  const seen = new Set();
  return pairs.filter((p) => { const k = low(p.from); if (seen.has(k) || p.from === p.to) return false; seen.add(k); return true; })
    .sort((a, b) => b.from.length - a.from.length);
}

// Camada 2: aplica as correções confirmadas na transcrição. Retorna { segments, count }.
function applyCorrections(segments, pairs) {
  let count = 0;
  const out = (segments || []).map((s) => {
    let text = s.text || '';
    for (const p of pairs) { const r = replaceWord(text, p.from, p.to); text = r.text; count += r.count; }
    return text === s.text ? s : { ...s, text };
  });
  return { segments: out, count };
}

// Camada 1: vocabulário enviado ao Whisper (o prompt dele aceita ~224 tokens).
function buildVocabulary(base, glossaries = [], context = null, maxChars = 600) {
  const terms = [];
  const push = (t) => { t = str(t); if (t && !terms.some((x) => norm(x) === norm(t))) terms.push(t); };
  String(base || '').split(/[,;\n]/).forEach(push);
  const all = glossaries.flat().filter(Boolean).sort((a, b) => (b.uses || 0) - (a.uses || 0));
  for (const g of all) push(g.term);
  for (const p of context?.participants || []) push(p.name);
  let out = '';
  for (const t of terms) {
    const next = out ? `${out}, ${t}` : t;
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
}

// ───────── Bloco estruturado no fim do resumo ─────────
const BLOCK_START = '```meetrec';

// Separa o texto do resumo do bloco ```meetrec {json}```.
function splitSummary(text) {
  const raw = String(text || '');
  const i = raw.lastIndexOf(BLOCK_START);
  if (i < 0) return { summary: raw.trim(), data: null, error: null };
  const summary = raw.slice(0, i).trim();
  let body = raw.slice(i + BLOCK_START.length);
  const end = body.indexOf('```');
  if (end >= 0) body = body.slice(0, end);
  body = body.trim();
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b < a) return { summary, data: null, error: 'bloco vazio' };
  try { return { summary, data: JSON.parse(body.slice(a, b + 1)), error: null }; } catch (e) { return { summary, data: null, error: e.message }; }
}

// Texto visível durante o streaming (esconde o bloco enquanto ele é escrito).
function visiblePart(text) {
  const raw = String(text || '');
  const i = raw.indexOf('```meet');
  if (i >= 0) return raw.slice(0, i).trimEnd();
  // Começo do bloco ainda chegando ("``", "```m"…)
  return raw.replace(/`{1,3}m?e?e?t?$/, '').trimEnd();
}

function parseTime(v) {
  if (typeof v === 'number' && isFinite(v)) return Math.max(0, v);
  const m = String(v || '').match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
}

let seq = 0;
function normalizeDoubts(list, { max = 10 } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const kind = DOUBT_KINDS.includes(norm(d.tipo ?? d.kind)) ? norm(d.tipo ?? d.kind) : 'trecho';
    const question = str(d.pergunta ?? d.question);
    const heard = str(d.ouvido ?? d.heard);
    if (!question && !heard) continue;
    out.push({
      id: `d${Date.now().toString(36)}${(seq++).toString(36)}`,
      kind,
      t: parseTime(d.tempo ?? d.t),
      heard,
      suggestion: str(d.sugestao ?? d.sugestão ?? d.suggestion),
      question: question || `"${heard}" está certo?`,
      status: 'open',
    });
    if (out.length >= max) break;
  }
  return out;
}

// ───────── Arquivos .md (espelho legível do pasta.json, úteis para abrir no Claude Code) ─────────
function contextToText(c) {
  if (contextIsEmpty(c)) return '';
  const lines = [];
  if (c.about) lines.push(`Sobre: ${c.about}`);
  if (c.participants?.length) lines.push('Participantes:\n' + c.participants.map((p) => `- ${p.name}${p.role ? ` — ${p.role}` : ''}`).join('\n'));
  if (c.goals?.length) lines.push('Objetivos:\n' + c.goals.map((g) => `- ${g}`).join('\n'));
  if (c.notes) lines.push(`Observações: ${c.notes}`);
  return lines.join('\n');
}

function glossaryToText(glossary) {
  return (glossary || []).map((g) => `- ${g.term}${g.heard?.length ? ` (a transcrição costuma escrever: ${g.heard.join(', ')})` : ''}`).join('\n');
}

function renderContextMd(name, d) {
  return `# Contexto — ${name}\n\n${d.description ? `${d.description}\n\n` : ''}${contextToText(d.context) || '_Ainda sem contexto aprovado._'}\n`;
}
function renderGlossaryMd(name, d) {
  return `# Glossário — ${name || 'geral'}\n\nTermos confirmados pelo usuário. O MeetRec corrige automaticamente as variações na transcrição.\n\n${glossaryToText(d.glossary) || '_Vazio._'}\n`;
}
function renderHistoryMd(name, d) {
  return `# Histórico — ${name}\n\n${d.history || '_Ainda sem histórico._'}\n`;
}

module.exports = {
  CTX_DIR, MEETING_DIR, DOUBT_KINDS,
  sanitizeFolderName, emptyFolderData, normalizeFolderData, normalizeContext, contextIsEmpty,
  addGlossaryTerm, replaceWord, correctionPairs, applyCorrections, buildVocabulary,
  splitSummary, visiblePart, normalizeDoubts, parseTime,
  contextToText, glossaryToText, renderContextMd, renderGlossaryMd, renderHistoryMd,
};
