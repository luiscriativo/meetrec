// Mescla as faixas (você x participantes), remove eco e atribui nomes usando eventos da extensão.

function tokens(s) {
  return new Set(s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
}

// É eco quando o trecho do microfone repete o do sistema: precisa de várias palavras em comum,
// para que uma fala curta sua ("sim, concordo") não seja confundida com eco de outra pessoa.
function isEcho(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  if (inter / Math.max(A.size, B.size) >= 0.5) return true;
  return inter >= 4 && inter / Math.min(A.size, B.size) >= 0.75;
}

// Segmentos do microfone que repetem o que veio do sistema (eco de alto-falante) são descartados.
function removeEcho(mic, sys) {
  let removed = 0;
  const kept = mic.filter((m) => {
    for (const s of sys) {
      if (s.end < m.start - 1.5 || s.start > m.end + 1.5) continue;
      if (isEcho(m.text, s.text)) { removed++; return false; }
    }
    return true;
  });
  return { kept, removed };
}

// Constrói janelas de atividade por pessoa a partir dos eventos (legendas e indicador de fala)
function activityWindows(events) {
  const wins = [];
  const speakingOpen = new Map();
  const captions = new Map(); // id da legenda -> janela
  for (const ev of events) {
    if (ev.rt == null) continue;
    if (ev.type === 'speaking') {
      if (ev.on) speakingOpen.set(ev.speaker, ev.rt);
      else if (speakingOpen.has(ev.speaker)) {
        wins.push({ speaker: ev.speaker, start: speakingOpen.get(ev.speaker), end: ev.rt, w: 1 });
        speakingOpen.delete(ev.speaker);
      }
    } else if (ev.type === 'caption' && ev.speaker) {
      const key = ev.id || `${ev.speaker}:${(ev.text || '').slice(0, 20)}`;
      const c = captions.get(key);
      // Legendas chegam ~1–2 s depois da fala
      if (c) c.end = ev.rt;
      else captions.set(key, { speaker: ev.speaker, start: ev.rt - 2.5, end: ev.rt, w: 1.5 });
    }
  }
  for (const [speaker, start] of speakingOpen) wins.push({ speaker, start, end: start + 4, w: 1 });
  return [...wins, ...captions.values()];
}

function attribute(segment, wins, exclude) {
  const score = new Map();
  for (const w of wins) {
    if (exclude && w.speaker === exclude) continue;
    const ov = Math.min(segment.end + 0.5, w.end) - Math.max(segment.start - 0.5, w.start);
    if (ov > 0) score.set(w.speaker, (score.get(w.speaker) || 0) + ov * w.w);
  }
  let best = null, bestScore = 0;
  for (const [k, v] of score) if (v > bestScore) { best = k; bestScore = v; }
  return best;
}

/**
 * mic/sys/mix: listas de segmentos {start,end,text}. events: eventos da extensão com rt (tempo da gravação em s).
 * Retorna { segments, stats }.
 */
function buildTranscript({ mic = [], sys = [], mix = [], events = [], userName }) {
  const me = userName || 'Você';
  const { kept, removed } = removeEcho(mic, sys);
  const wins = activityWindows(events);
  const known = new Set(wins.map((w) => w.speaker));
  // O próprio usuário aparece nas legendas do Teams com o nome dele ou "Você/You"
  const selfAliases = new Set([me, 'Você', 'You', '(Você)', 'Eu'].map((s) => s.toLowerCase()));
  const selfName = [...known].find((n) => selfAliases.has(n.toLowerCase()) || n.toLowerCase().includes('(você)') || n.toLowerCase().includes('(you)'));

  let named = 0;
  const out = [];
  for (const s of kept) out.push({ ...s, speaker: me, source: 'mic' });
  for (const s of sys) {
    const who = wins.length ? attribute(s, wins, selfName) : null;
    if (who) named++;
    out.push({ ...s, speaker: who || 'Participante', source: 'system' });
  }
  for (const s of mix) {
    const who = wins.length ? attribute(s, wins, null) : null;
    if (who) named++;
    out.push({ ...s, speaker: who || 'Participante', source: 'mix' });
  }
  out.sort((a, b) => a.start - b.start);

  // Junta falas consecutivas da mesma pessoa com pausa curta
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 1.2 && (last.text.length + s.text.length) < 350) {
      last.end = s.end;
      last.text += ' ' + s.text;
    } else merged.push({ ...s });
  }
  const participants = [...new Set(merged.map((s) => s.speaker))];
  return {
    segments: merged,
    stats: { echoRemoved: removed, named, total: sys.length + mix.length, knownSpeakers: [...known].filter((n) => n !== selfName) },
    participants,
  };
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function transcriptToText(segments, names = {}) {
  return segments.map((s) => `[${fmtTime(s.start)}] ${names[s.speaker] || s.speaker}: ${s.text}`).join('\n');
}

module.exports = { buildTranscript, transcriptToText, fmtTime };
