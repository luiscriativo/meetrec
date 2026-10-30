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
    slim: null,         // (legado) proposta do "Enxugar" aguardando aprovação — hoje a limpeza é automática
    archive: [],        // o que saiu da memória ativa [{ text, why, at }] — não vai para o resumo, mas não se perde
    backup: null,       // memória antes da última limpeza automática, para "Desfazer" { history, context, at }
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
    slim: d.slim && typeof d.slim.history === 'string' ? { ...d.slim, context: d.slim.context ? normalizeContext(d.slim.context) : null, removed: Array.isArray(d.slim.removed) ? d.slim.removed : [] } : null,
    archive: Array.isArray(d.archive) ? d.archive.filter((a) => a && a.text).map((a) => ({ text: String(a.text), why: str(a.why), at: a.at || null })).slice(-ARCHIVE_MAX) : [],
    backup: d.backup && typeof d.backup.history === 'string' ? { history: d.backup.history, context: d.backup.context ? normalizeContext(d.backup.context) : null, at: d.backup.at || null } : null,
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

// Glossário que vai para o Claude: os termos que aparecem nesta reunião (ou suas variantes)
// + os mais usados, para ele reconhecer variações novas. Pastas antigas não enchem o prompt.
function relevantGlossary(glossary, text, { top = 15 } = {}) {
  const hay = norm(text);
  const has = (s) => s && hay.includes(norm(s));
  const list = glossary || [];
  const present = list.filter((g) => has(g.term) || (g.heard || []).some(has));
  const extra = list.filter((g) => !present.includes(g)).sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, Math.max(0, top - present.length));
  return [...present, ...extra];
}

// ───────── Tamanho da memória da pasta ─────────
// A memória se mantém pequena sozinha: o resumo pede um histórico curto (HISTORY_TARGET), o que passa
// do limite duro (HISTORY_MAX) vai para o arquivo e, quando cresce além de SLIM_AT, o app enxuga sozinho.
const HISTORY_MAX = 3000;
const HISTORY_TARGET = 1500;
const SLIM_AT = 2000;
const CONTEXT_SLIM_AT = 1800;
const PEOPLE_MAX = 12;
const ARCHIVE_MAX = 300;

// Corta o histórico numa quebra de linha para não passar de `max` caracteres.
// As linhas que sobram voltam em `dropped` (vão para o arquivo da pasta, não se perdem).
function capHistory(text, max = HISTORY_MAX) {
  const t = String(text || '').trim();
  if (t.length <= max) return { text: t, cut: false, dropped: [] };
  const lines = t.split('\n');
  const out = [];
  let len = 0, i = 0;
  for (; i < lines.length; i++) {
    if (len + lines[i].length + 1 > max) break;
    out.push(lines[i]);
    len += lines[i].length + 1;
  }
  return { text: out.join('\n'), cut: true, dropped: lines.slice(i).map((l) => l.trim()).filter(Boolean) };
}

// Acrescenta itens ao arquivo da pasta (o mais novo no fim; guarda só os ARCHIVE_MAX últimos)
function addToArchive(archive, items, why) {
  const at = new Date().toISOString();
  const add = (items || []).map((t) => str(t).replace(/^•\s*/, '')).filter(Boolean).map((text) => ({ text, why: str(why), at }));
  return [...(archive || []), ...add].slice(-ARCHIVE_MAX);
}

const staleLines = (history) => String(history || '').split('\n').filter((l) => /\(antiga\)/i.test(l)).length;

// Quanto da pasta vai para cada resumo e se está na hora de enxugar (sozinho)
function folderSize(d) {
  const contextChars = ((d?.description || '') + contextToText(d?.context)).length;
  const historyChars = (d?.history || '').length;
  const stale = staleLines(d?.history);
  const people = d?.context?.participants?.length || 0;
  const slim = historyChars > SLIM_AT || stale >= 3 || contextChars > CONTEXT_SLIM_AT || people > PEOPLE_MAX;
  return { contextChars, historyChars, historyMax: HISTORY_MAX, historyTarget: HISTORY_TARGET, slimAt: SLIM_AT, stale, glossary: (d?.glossary || []).length, archived: (d?.archive || []).length, level: slim ? 'slim' : 'ok' };
}

const needsSlim = (d) => folderSize(d).level === 'slim';

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

// ───────── Qual pasta é esta reunião? ─────────
// Pontua cada pasta com sinais que o app já tem (título da reunião, quem participou, termos do
// glossário e o nome da pasta na conversa). Só decide sozinho quando o vencedor é claro.
const STOP = new Set('a o e de da do das dos em no na nos nas para por com sem um uma uns umas que se ao aos as os the and of to for with on in at by is are meeting reuniao reunioes call chamada projeto cliente equipe externo externa interno interna semanal diaria daily weekly mensal sync alinhamento status ponto online teams'.split(' '));
const tokens = (s) => norm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
const personKey = (s) => norm(String(s || '').replace(/\(.*?\)/g, '')).replace(/[^\p{L} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

// "Ana Souza" = "Ana Souza Lima"? Mesmo primeiro e último nome. Só o primeiro nome ("Bruno") vale
// quando um dos lados não tem sobrenome.
function samePerson(a, b) {
  if (a === b) return true;
  const A = a.split(' '), B = b.split(' ');
  if (A[0] !== B[0]) return false;
  if (A.length === 1 || B.length === 1) return true;
  return A[A.length - 1] === B[B.length - 1];
}

const hasWord = (hay, word) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(word)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(hay);

/**
 * meeting: { title, participants:[nomes], text, owner }
 * folders: [{ name, description, context, glossary, titles:[títulos de reuniões da pasta], people:[nomes que já participaram] }]
 * → { decision: 'auto'|'suggest'|'none', best: { name, score, reasons }|null, ranking }
 */
function scoreFolders(meeting, folders, { autoAt = 4, margin = 2, suggestAt = 2 } = {}) {
  const title = tokens(meeting?.title);
  const owner = personKey(meeting?.owner);
  const people = [...new Set((meeting?.participants || []).map(personKey).filter((p) => p && p !== owner && p !== 'participante'))];
  const text = norm(meeting?.text || '');
  const ranking = (folders || []).map((f) => {
    let score = 0;
    const reasons = [];
    // Nome da pasta no título da reunião ("ATLAS SEMANAL (EXTERNO)" → pasta "Atlas")
    const nameTok = tokens(f.name);
    if (nameTok.length && title.length) {
      const hit = nameTok.filter((t) => title.includes(t)).length;
      if (hit === nameTok.length) { score += 4; reasons.push('nome da pasta no título'); } else if (hit && nameTok.some((t) => t.length >= 4 && title.includes(t))) { score += 2; reasons.push('parte do nome da pasta no título'); }
    }
    // Reunião recorrente: título parecido com o de reuniões que já estão na pasta
    const sim = Math.max(0, ...(f.titles || []).map((t) => jaccard(title, tokens(t))));
    if (sim >= 0.6) { score += 4; reasons.push('mesmo título de reuniões anteriores da pasta'); } else if (sim >= 0.35) { score += 2; reasons.push('título parecido com reuniões da pasta'); }
    // Pessoas em comum
    const known = new Set([...(f.people || []), ...(f.context?.participants || []).map((p) => p.name)].map(personKey).filter(Boolean));
    const common = people.filter((p) => known.has(p) || [...known].some((k) => samePerson(k, p)));
    if (common.length) {
      score += Math.min(3, common.length);
      if (common.length >= 2 && common.length / people.length >= 0.5) score += 1;
      reasons.push(`${common.length} ${common.length === 1 ? 'participante' : 'participantes'} em comum`);
    }
    // Termos do glossário e o nome da pasta ditos na reunião
    if (text) {
      const terms = (f.glossary || []).map((g) => g.term).filter((t) => t && t.length >= 4 && !STOP.has(norm(t)));
      const hits = terms.filter((t) => hasWord(text, norm(t))).length;
      if (hits) { score += Math.min(2, hits * 0.5); reasons.push(`${hits} ${hits === 1 ? 'termo' : 'termos'} do glossário`); }
      const spoken = nameTok.filter((t) => t.length >= 4).some((t) => (text.match(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}(?=$|[^\\p{L}\\p{N}])`, 'giu')) || []).length >= 2);
      if (spoken) { score += 1; reasons.push('nome da pasta citado na conversa'); }
    }
    return { name: f.name, score, reasons };
  }).sort((a, b) => b.score - a.score);
  const [best, second] = ranking;
  if (!best || best.score < suggestAt) return { decision: 'none', best: null, ranking };
  const clear = best.score >= autoAt && best.score - (second?.score || 0) >= margin;
  return { decision: clear ? 'auto' : 'suggest', best, ranking };
}

module.exports = {
  CTX_DIR, MEETING_DIR, DOUBT_KINDS,
  sanitizeFolderName, emptyFolderData, normalizeFolderData, normalizeContext, contextIsEmpty,
  addGlossaryTerm, replaceWord, correctionPairs, applyCorrections, buildVocabulary,
  relevantGlossary, capHistory, addToArchive, folderSize, needsSlim, staleLines, scoreFolders,
  HISTORY_MAX, HISTORY_TARGET, SLIM_AT, PEOPLE_MAX,
  splitSummary, visiblePart, normalizeDoubts, parseTime,
  contextToText, glossaryToText, renderContextMd, renderGlossaryMd, renderHistoryMd,
};
