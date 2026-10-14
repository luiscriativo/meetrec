// Pipeline pós-gravação: preparar áudio → transcrever → identificar falantes → resumir (Claude Code ou Codex CLI).
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { ffmpegPath, run, probeAudio } = require('./tools');
const { transcribe, UserError } = require('./transcribe');
const { buildTranscript, transcriptToText, fmtTime } = require('./speakers');
const { readSkill } = require('./claude');
const { runAI, engineName } = require('./ai');
const { STEP_NAMES } = require('./library');
const F = require('./folders');

const FALLBACK_FORMAT = `Formato de saída: texto limpo, pronto para colar no Teams (sem Markdown: nada de #, **, - ).
📋 <NOME DA REUNIÃO EM MAIÚSCULAS>
📅 dd/mm/aaaa · hh:mm · ~N min
👥 Participantes: Nome, Nome, ...

━━━━━━━━━━━━━━━━━━━━
📝 RESUMO
━━━━━━━━━━━━━━━━━━━━

▸ <Tema 1: título descritivo>
• Bullet curto e factual (3 a 6 por tema). Destaque decisões, prazos e números no início do bullet.

━━━━━━━━━━━━━━━━━━━━
✅ ITENS DE AÇÃO
━━━━━━━━━━━━━━━━━━━━

☐ Responsável: ação concreta, com prazo se mencionado.`;

// Pedido do bloco estruturado no fim do resumo (dúvidas, contexto e histórico da pasta)
function blockRules(folder) {
  const inFolder = !!folder.name;
  const hasCtx = inFolder && !F.contextIsEmpty(folder.data.context);
  return `=== BLOCO FINAL OBRIGATÓRIO (o app lê e esconde do texto) ===
Depois do resumo, termine a resposta com um bloco exatamente neste formato (JSON válido, sem comentários):
\`\`\`meetrec
{
  "duvidas": [
    {"tipo": "termo|nome|numero|falante|trecho", "tempo": "mm:ss", "ouvido": "texto exatamente como aparece na transcrição", "sugestao": "o que você acha que é (ou vazio)", "pergunta": "pergunta curta e direta ao usuário"}
  ]${inFolder ? `,
  "contexto": ${hasCtx ? 'null ou o contexto COMPLETO atualizado, só se esta reunião trouxe informação nova e relevante (pessoa nova, papel, objetivo)' : 'o contexto da pasta deduzido desta reunião'} no formato {"resumo": "do que se trata o projeto/assunto em 1-2 frases", "participantes": [{"nome": "", "papel": "cargo ou função, se der para saber"}], "objetivos": [""], "observacoes": ""},
  "historico": "o HISTÓRICO DA PASTA atualizado com esta reunião (regras abaixo)"` : ''}
}
\`\`\`
Regras das dúvidas:
- Liste tudo de que você NÃO teve certeza por causa da transcrição: palavras/nomes/siglas que parecem mal reconhecidos, números ou datas ambíguos, falas sem sentido, quem disse algo importante quando não está claro. No máximo 10, as mais importantes primeiro.
- "ouvido" deve ser copiado literalmente da transcrição (o app usa para localizar e corrigir). Deixe vazio em dúvidas de número/trecho/falante sem palavra específica.
- Não repita dúvidas já respondidas no glossário ou nos esclarecimentos do usuário.
- Se não houver dúvidas, use "duvidas": [].
- Não escreva no texto do resumo nenhuma linha de "termos duvidosos" — as dúvidas vão só no bloco.${inFolder ? `\n${HISTORY_RULES}` : ''}`;
}

// Regras do histórico (usadas no resumo, na montagem e no "Enxugar")
const HISTORY_RULES = `Regras do histórico:
- Bullets com •: decisões em vigor e pendências em aberto (com responsável). No máximo 25 linhas e ${F.HISTORY_MAX} caracteres — seja telegráfico.
- Termine cada pendência com a data da última reunião em que ela foi mencionada, assim: (últ. menção dd/mm).
- Remova pendências que foram resolvidas e decisões que foram substituídas.
- Pendências sem menção nas últimas 3 reuniões da pasta: acrescente "(antiga)" no fim da linha, para o usuário decidir se ainda valem.`;

const SILENT_DB = -55;

function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  const small = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'para', 'com', 'no', 'na']);
  return s.toLowerCase().split(' ').map((w, i) => (i > 0 && small.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseSummary(text) {
  const lines = text.split(/\r?\n/);
  const t = lines.find((l) => l.trim().startsWith('📋'));
  const title = t ? titleCase(t.replace('📋', '').trim()) : null;
  const actions = lines.filter((l) => /^\s*[☐☑✅]\s*/.test(l) && !/ITENS DE AÇÃO/i.test(l)).map((l) => {
    const body = l.replace(/^\s*[☐☑✅]\s*/, '').trim();
    const idx = body.indexOf(':');
    return idx > 0 && idx < 60 ? { owner: body.slice(0, idx).trim(), text: body.slice(idx + 1).trim(), done: false } : { owner: '', text: body, done: false };
  }).filter((a) => a.text);
  return { title, actions };
}

// Substitui `dest` por `src`. No Windows não dá para renomear sobre um arquivo aberto
// (ex.: o player tocando a reunião); nesse caso sobrescreve o conteúdo e, se nem isso
// der, mantém o original — o arquivo corrigido só melhora a busca no player.
function replaceFile(src, dest) {
  try { fs.renameSync(src, dest); return; } catch {}
  try { fs.copyFileSync(src, dest); } catch {}
  try { fs.unlinkSync(src); } catch {}
}

class Pipeline extends EventEmitter {
  constructor(library, store) {
    super();
    this.library = library;
    this.store = store;
    this.queue = [];
    this.current = null;
    this.child = null;
    this.cancelled = false;
    this.lastWrite = 0;
    this.isRecording = () => false;
    this.lowPriority = false;
  }

  // Processos pesados (Whisper/ffmpeg) rodam com prioridade reduzida para não travar o PC;
  // durante uma gravação, caem para a prioridade mínima.
  _setChild(c) {
    this.child = c;
    this._applyPriority();
  }

  _applyPriority() {
    if (!this.child?.pid) return;
    const P = os.constants.priority;
    try { os.setPriority(this.child.pid, this.lowPriority ? P.PRIORITY_LOW : P.PRIORITY_BELOW_NORMAL); } catch {}
  }

  setLowPriority(on) {
    this.lowPriority = on;
    this._applyPriority();
  }

  // Ao cancelar, a reunião volta ao estado que já tinha (ex.: cancelar "Refazer resumo" mantém o resumo anterior)
  _statusAfterCancel(id) {
    return fs.existsSync(this.library.file(id, 'summary.md')) ? 'ready' : 'recorded';
  }

  // Chamado quando uma gravação termina: retoma a fila que estava esperando
  resume() { this._next(); }

  isBusy(id) { return this.current?.id === id || this.queue.some((j) => j.id === id); }
  status() { return { current: this.current, queued: this.queue.map((j) => j.id) }; }

  enqueue(id, from = 'audio') {
    if (this.isBusy(id) || !this.library.get(id)) return false;
    this.library.resetSteps(id, from);
    this.library.update(id, { status: 'processing', error: null });
    this.queue.push({ id, from });
    if (this.isRecording()) this.library.setStep(id, from, { message: 'Na fila — começa quando a gravação atual terminar.' });
    else if (this.current) this.library.setStep(id, from, { message: 'Na fila — aguardando a reunião anterior terminar de processar.' });
    this.emit('queued', { id, position: this.queue.length - (this.current ? 0 : 1) });
    this._next();
    return true;
  }

  cancel(id, { silent = false } = {}) {
    const qi = this.queue.findIndex((j) => j.id === id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.library.update(id, { status: this._statusAfterCancel(id), error: null });
      if (!silent) this.emit('cancelled', { id });
      return true;
    }
    if (this.current?.id === id) {
      this.cancelled = true;
      // Encerrar o processo pode levar alguns segundos (no Windows, a árvore inteira): mostra na hora
      if (this.current.step) this._step(id, this.current.step, { message: 'Cancelando…' }, true);
      try { this.child?.kill(); } catch {}
      return true;
    }
    return false;
  }

  async _next() {
    if (this.current || !this.queue.length) return;
    if (this.isRecording()) return; // não compete com uma gravação em andamento
    this.current = this.queue.shift();
    this.cancelled = false;
    const { id, from } = this.current;
    this.emit('start', { id });
    try {
      const startIdx = STEP_NAMES.indexOf(from);
      for (let i = startIdx; i < STEP_NAMES.length; i++) {
        if (this.cancelled) throw new UserError('Processamento cancelado.', 'cancelled');
        const step = STEP_NAMES[i];
        this.current.step = step;
        this._step(id, step, { state: 'running', progress: 0, message: '', startedAt: Date.now() }, true);
        const result = await this[`_${step}`](id);
        this._step(id, step, { state: result?.skipped ? 'skipped' : 'done', progress: 1, message: result?.message || '', endedAt: Date.now() }, true);
      }
      this.library.update(id, { status: 'ready' });
      this.emit('done', { id, meta: this.library.get(id) });
    } catch (e) {
      const step = this.current.step;
      if (!this.library.get(id)) {
        // A reunião foi excluída durante o processamento: não há o que reportar
      } else if (this.cancelled || e.code === 'cancelled') {
        if (step) this._step(id, step, { state: 'pending', progress: 0, message: 'Cancelado' }, true);
        this.library.update(id, { status: this._statusAfterCancel(id), error: null });
        this.emit('cancelled', { id });
      } else {
        const msg = e instanceof UserError ? e.message : `Erro inesperado: ${e.message}`;
        if (step) this._step(id, step, { state: 'error', message: msg }, true);
        this.library.update(id, { status: 'error', error: msg });
        this.emit('failed', { id, step, error: msg, code: e.code });
      }
    } finally {
      if (!this.queue.some((j) => j.id === id)) this.library.clearWork(id); // cópias locais não são mais necessárias
      this.current = null;
      this.child = null;
      this._next();
    }
  }

  _step(id, step, patch, force) {
    this.emit('progress', { id, step, ...patch });
    const now = Date.now();
    if (force || now - this.lastWrite > 1500) {
      this.lastWrite = now;
      this.library.setStep(id, step, patch);
    }
  }

  // 1) Corrige os arquivos webm (duração/busca), mede volume e duração
  async _audio(id) {
    const meta = this.library.get(id);
    const L = this.library;
    const msg = (m, p) => this._step(id, 'audio', { message: m, progress: p });
    // Arquivos pesados ficam numa pasta local; com a biblioteca no Drive, baixa o que faltar (com progresso)
    const local = (n) => L.toLocal(id, n, (p) => msg(`Baixando ${n} do ${L.isCloud() ? 'Google Drive' : 'disco'}… ${Math.round(p * 100)}%`, p * 0.2));
    const f = (n) => L.workFile(id, n);
    fs.mkdirSync(L.workDir(id), { recursive: true });
    const warnings = [];
    const info = {};

    // Importado na nuvem: o original (às vezes um vídeo enorme) não vai para o Drive, só o mix.webm.
    // Reprocessar depois (ou no outro PC) parte do mix.webm.
    const hasOriginal = meta.originalFile && (fs.existsSync(L.file(id, meta.originalFile)) || fs.existsSync(f(meta.originalFile)));
    if (meta.source === 'import' && hasOriginal) {
      const orig = await local(meta.originalFile);
      msg('Convertendo arquivo importado…', 0.2);
      const r = await run(ffmpegPath(), ['-hide_banner', '-y', '-i', orig, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', f('mix.webm')], { timeout: 3600e3, onSpawn: (c) => this._setChild(c) });
      if (r.code !== 0) throw new UserError('Não consegui ler o arquivo importado. Ele contém áudio? ' + r.err.slice(-200));
      L.publish(id, 'mix.webm');
      this.library.update(id, { tracks: { mix: true }, audioFile: 'mix.webm' });
    } else {
      const tracks = Object.entries(meta.tracks || {}).filter(([, v]) => v).map(([k]) => k);
      if (!tracks.length) throw new UserError('Nenhum áudio foi gravado nesta reunião.');
      let i = 0;
      for (const t of tracks) {
        msg(`Finalizando faixa ${t === 'mic' ? 'do microfone' : t === 'system' ? 'do sistema' : 'mixada'}…`, i++ / tracks.length * 0.5);
        if (!fs.existsSync(L.file(id, `${t}.webm`)) && !fs.existsSync(f(`${t}.webm`))) { meta.tracks[t] = false; continue; }
        const src = await local(`${t}.webm`);
        if (!fs.existsSync(src) || fs.statSync(src).size < 1000) { meta.tracks[t] = false; continue; }
        const tmp = src.replace(/\.webm$/, '.fixed.webm');
        const r = await run(ffmpegPath(), ['-hide_banner', '-y', '-i', src, '-c', 'copy', tmp], { timeout: 3600e3 });
        if (r.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) { replaceFile(tmp, src); L.publish(id, `${t}.webm`); }
        else { try { fs.unlinkSync(tmp); } catch {} }
      }
      this.library.update(id, { tracks: meta.tracks, audioFile: meta.tracks.mix ? 'mix.webm' : (meta.tracks.system ? 'system.webm' : 'mic.webm') });
    }

    const m2 = this.library.get(id);
    const tracks = Object.entries(m2.tracks).filter(([, v]) => v).map(([k]) => k);
    if (!tracks.length) throw new UserError('Os arquivos de áudio desta reunião estão vazios — nada foi gravado.');
    let i = 0;
    for (const t of tracks) {
      msg('Analisando volume e duração…', 0.5 + (i++ / tracks.length) * 0.5);
      info[t] = await probeAudio(await local(`${t}.webm`));
    }
    const duration = Math.max(...Object.values(info).map((x) => x.duration || 0), m2.duration || 0);
    if (info.mic && info.mic.maxVolume < SILENT_DB) warnings.push('O microfone ficou em silêncio durante toda a gravação. Verifique o dispositivo selecionado.');
    if (info.system && info.system.maxVolume < SILENT_DB) warnings.push('Nenhum som do computador foi captado (os outros participantes podem não ter sido gravados).');
    if (info.mix && info.mix.maxVolume < SILENT_DB && !info.mic && !info.system) throw new UserError('O áudio está em silêncio — não há nada para transcrever.');
    this.library.update(id, { duration, trackInfo: info, warnings: [...new Set([...(m2.warnings || []), ...warnings])] });
    return { message: `Áudio pronto · ${fmtTime(duration)}` };
  }

  // 2) Transcreve cada faixa com voz
  async _transcribe(id) {
    const meta = this.library.get(id);
    const { data, general } = this.folderInfo(id);
    const base = this.store.get();
    // Camada 1: termos confirmados (glossário geral + da pasta) e participantes viram vocabulário do Whisper
    const settings = { ...base, vocabulary: F.buildVocabulary(base.vocabulary, [data?.glossary || [], general.glossary], data?.context) };
    const info = meta.trackInfo || {};
    let jobs;
    if (meta.tracks.mic || meta.tracks.system) {
      jobs = ['mic', 'system'].filter((t) => meta.tracks[t] && (info[t]?.maxVolume ?? 0) >= SILENT_DB);
    } else jobs = ['mix'];
    if (!jobs.length) throw new UserError('Todas as faixas estão em silêncio — não há fala para transcrever.');

    const weights = jobs.map((t) => Math.max(1, info[t]?.duration || meta.duration || 1));
    const total = weights.reduce((a, b) => a + b, 0);
    const raw = {};
    let done = 0;
    const engineLabel = settings.engine === 'local' ? `Whisper local (${settings.localModel})` : settings.engine === 'groq' ? 'Groq Whisper' : 'OpenAI Whisper';
    for (let i = 0; i < jobs.length; i++) {
      const t = jobs[i];
      const label = t === 'mic' ? 'sua voz' : t === 'system' ? 'participantes' : 'áudio';
      const t0 = Date.now();
      let lastStatus = '';
      raw[t] = await transcribe({
        file: await this.library.toLocal(id, `${t}.webm`),
        duration: info[t]?.duration,
        settings,
        onChild: (c) => this._setChild(c),
        onStatus: (m, code) => {
          if (code !== 'segment') lastStatus = m;
          this._step(id, 'transcribe', { message: `${engineLabel} · ${label}: ${code === 'segment' ? m : lastStatus}` });
        },
        onProgress: (p) => {
          const overall = (done + p * weights[i]) / total;
          const elapsed = (Date.now() - t0) / 1000;
          const eta = p > 0.03 ? Math.round(elapsed / p - elapsed) : null;
          this._step(id, 'transcribe', { progress: overall, eta });
        },
      });
      done += weights[i];
      if (this.cancelled) throw new UserError('Processamento cancelado.', 'cancelled');
    }
    this.library.writeJson(id, 'transcript.raw.json', raw);
    const n = Object.values(raw).reduce((a, s) => a + s.length, 0);
    if (!n) throw new UserError('O Whisper não reconheceu nenhuma fala no áudio.');
    return { message: `${n} ${n === 1 ? 'trecho transcrito' : 'trechos transcritos'} com ${engineLabel}` };
  }

  // 3) Une as faixas e identifica quem falou
  async _speakers(id) {
    const meta = this.library.get(id);
    const raw = this.library.readJson(id, 'transcript.raw.json') || {};
    const events = (this.library.readText(id, 'events.jsonl') || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    this._step(id, 'speakers', { message: events.length ? `Cruzando ${events.length} eventos da extensão…` : 'Separando sua voz dos participantes…', progress: 0.3 });
    const settings = this.store.get();
    const built = buildTranscript({ mic: raw.mic, sys: raw.system, mix: raw.mix, events, userName: settings.userName });
    const { stats, participants } = built;
    // Camada 2: só correções que você confirmou (nesta reunião ou no glossário)
    const { data, general } = this.folderInfo(id);
    const fixed = F.applyCorrections(built.segments, F.correctionPairs([...(data?.glossary || []), ...general.glossary], meta.corrections));
    const segments = fixed.segments;
    this.library.writeJson(id, 'transcript.json', { segments });
    this.library.writeText(id, 'transcript.txt', transcriptToText(segments, meta.speakerNames));

    const extNames = [...new Set([...(meta.participants || []), ...stats.knownSpeakers])];
    const allPeople = [...new Set([...participants.filter((p) => p !== 'Participante'), ...extNames])];
    this.library.update(id, { participants: allPeople, speakerStats: stats });

    const parts = [];
    if (stats.named) parts.push(`${stats.named} falas identificadas por nome`);
    else if (meta.tracks.mic && meta.tracks.system) parts.push('sua voz separada dos participantes');
    if (stats.echoRemoved) parts.push(`${stats.echoRemoved} ecos removidos`);
    if (fixed.count) parts.push(`${fixed.count} ${fixed.count === 1 ? 'termo corrigido' : 'termos corrigidos'} pelo glossário`);
    if (!events.length && meta.platform === 'Teams (navegador)') parts.push('ative as legendas no Teams para nomes');
    return { message: parts.join(' · ') || 'Transcrição montada' };
  }

  buildContext(id) {
    const meta = this.library.get(id);
    const settings = this.store.get();
    const tr = this.library.readJson(id, 'transcript.json');
    const text = tr ? transcriptToText(tr.segments, meta.speakerNames) : '';
    const d = new Date(meta.createdAt);
    const lines = [
      `Título provisório: ${meta.titleAuto ? '(definir a partir do conteúdo)' : meta.title}`,
      `Data/hora: ${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
      `Duração: ~${Math.max(1, Math.round((meta.duration || 0) / 60))} min`,
    ];
    if (meta.platform) lines.push(`Plataforma: ${meta.platform}`);
    if (meta.meetingTitle) lines.push(`Título no app de reunião: ${meta.meetingTitle}`);
    const people = (meta.participants || []).map((p) => meta.speakerNames?.[p] || p);
    if (people.length) lines.push(`Participantes identificados: ${people.join(', ')}`);
    if (meta.markers?.length) lines.push('Momentos marcados como importantes pelo usuário:\n' + meta.markers.map((m) => `- [${fmtTime(m.t)}] ${m.label || 'Marcação'}`).join('\n'));
    if (meta.notes?.trim()) lines.push('Anotações do usuário durante a reunião:\n' + meta.notes.trim());
    return { meta, settings, header: lines.join('\n'), text, folder: this.folderPrompt(id, text) };
  }

  folderInfo(id) {
    const name = this.library.folderOf(id);
    return { name, data: name ? this.library.getFolder(name) : null, general: this.library.getFolder('') || F.emptyFolderData() };
  }

  // Seções do prompt com o que o app já sabe sobre a pasta e sobre esta reunião
  folderPrompt(id, transcriptText = '') {
    const { name, data, general } = this.folderInfo(id);
    const meta = this.library.get(id);
    const out = [];
    if (name) {
      const ctx = [data.description && `Descrição: ${data.description}`, F.contextToText(data.context)].filter(Boolean).join('\n');
      out.push(`=== CONTEXTO DA PASTA "${name}" (confirmado pelo usuário) ===\n${ctx || '(ainda sem contexto — esta é uma das primeiras reuniões da pasta)'}`);
      // Mesmo que o histórico tenha sido editado à mão e ficado enorme, o prompt recebe no máximo HISTORY_MAX
      if (data.history) out.push(`=== HISTÓRICO DA PASTA (reuniões anteriores) ===\n${F.capHistory(data.history).text}`);
    }
    // Só os termos que aparecem nesta reunião + os mais usados (o glossário inteiro cresce sem limite)
    const gloss = F.glossaryToText(F.relevantGlossary([...(data?.glossary || []), ...general.glossary], transcriptText));
    if (gloss) out.push(`=== GLOSSÁRIO (grafias confirmadas pelo usuário — use sempre estas) ===\n${gloss}`);
    const cl = (meta?.clarifications || []).map((c) => `- ${c.question}${c.heard ? ` (transcrição: "${c.heard}")` : ''} → ${c.answer}`).join('\n');
    if (cl) out.push(`=== ESCLARECIMENTOS DO USUÁRIO SOBRE ESTA REUNIÃO (têm prioridade sobre a transcrição) ===\n${cl}`);
    return { name, data, text: out.join('\n\n') };
  }

  // 4) Gera o resumo com o Claude Code
  async _summary(id) {
    const { meta, settings, header, text, folder } = this.buildContext(id);
    const skill = settings.useSkill ? readSkill() : null;
    const owner = settings.userName || 'Você';
    const speakerRule = (meta.tracks?.mic || meta.tracks?.system)
      ? `- "${owner}" é a pessoa que gravou (falas do microfone dela). "Participante" indica outras pessoas não identificadas por nome; se der para deduzir nomes pelo contexto, use-os.`
      : `- Este áudio foi importado: as falas não estão separadas por pessoa ("Participante" pode ser qualquer um). Deduza nomes pelo contexto quando possível e não presuma que "${owner}" participou.`;
    const prompt = `Gere o resumo de uma reunião gravada pelo app MeetRec.

=== INSTRUÇÕES DE FORMATO ${skill ? '(skill resumo-reuniao)' : ''} ===
${skill || FALLBACK_FORMAT}

=== REGRAS DESTA EXECUÇÃO (têm prioridade) ===
- Não use ferramentas, não leia nem salve arquivos: responda SOMENTE com o texto final do resumo, começando pela linha "📋", seguido do bloco final descrito abaixo.
- A transcrição já está abaixo, com horários [mm:ss] e quem falou.
${speakerRule}
- Dê atenção especial aos momentos marcados e às anotações do usuário, quando houver.
${folder.text ? '- Use o contexto, o histórico, o glossário e os esclarecimentos abaixo para entender a reunião, corrigir erros de reconhecimento de voz e escrever nomes e termos com a grafia certa. Se fizer sentido, ligue o que foi dito a pendências do histórico.\n' : ''}${settings.customInstructions ? `- Instruções adicionais do usuário: ${settings.customInstructions}\n` : ''}
${blockRules(folder)}

${folder.text ? `${folder.text}\n\n` : ''}=== DADOS DA REUNIÃO ===
${header}

=== TRANSCRIÇÃO ===
${text}
`;
    this.library.writeText(id, 'summary.prompt.txt', prompt);
    let lastEmit = 0;
    const res = await runAI({
      prompt,
      settings,
      cwd: this.library.dir(id),
      onChild: (c) => this._setChild(c),
      onStatus: (m) => this._step(id, 'summary', { message: m }),
      onText: (_d, full) => {
        const now = Date.now();
        if (now - lastEmit > 120) {
          lastEmit = now;
          const visible = F.visiblePart(full);
          this.emit('summary-stream', { id, text: visible });
          if (visible.length < full.length) this._step(id, 'summary', { message: 'Anotando os pontos de dúvida e atualizando a pasta…' });
          this._step(id, 'summary', { progress: Math.min(0.95, full.length / 3200) });
        }
      },
    });
    const parsed = F.splitSummary(res.text);
    const summaryText = parsed.summary;
    this.emit('summary-stream', { id, text: summaryText });
    if (!summaryText) throw new UserError(`O ${engineName(settings)} retornou uma resposta vazia.`);
    this.library.writeText(id, 'summary.md', summaryText);
    const { title, actions } = parseSummary(summaryText);
    const doubts = F.normalizeDoubts(parsed.data?.duvidas);
    const patch = { summary: { generatedAt: new Date().toISOString(), engine: res.engine, model: res.model, costUsd: res.costUsd, durationMs: res.durationMs, blockError: parsed.error || (parsed.data ? null : 'sem bloco') }, actions, doubts };
    if (title && this.library.get(id).titleAuto) patch.title = title;
    const m = this.library.update(id, patch);
    const folderNote = folder.name ? this._applyFolderBlock(folder.name, parsed.data, m) : '';
    const secs = res.durationMs ? ` em ${Math.round(res.durationMs / 1000)}s` : '';
    const bits = [`Resumo gerado${secs}`];
    if (actions.length) bits.push(`${actions.length} ${actions.length === 1 ? 'item de ação' : 'itens de ação'}`);
    if (doubts.length) bits.push(`${doubts.length} ${doubts.length === 1 ? 'ponto de dúvida' : 'pontos de dúvida'}`);
    if (folderNote) bits.push(folderNote);
    return { message: bits.join(' · ') };
  }

  // Guarda o histórico na hora e o contexto como rascunho para você aprovar
  _applyFolderBlock(name, data, meta) {
    if (!data || !this.library.getFolder(name)) return '';
    const notes = [];
    this.library.updateFolder(name, (d) => {
      if (typeof data.historico === 'string' && data.historico.trim()) {
        const capped = F.capHistory(data.historico);
        d.history = capped.text;
        d.historyAt = new Date().toISOString();
        notes.push(capped.cut ? 'histórico atualizado (cortado por tamanho — vale enxugar)' : 'histórico da pasta atualizado');
      }
      if (data.contexto && typeof data.contexto === 'object') {
        const c = F.normalizeContext(data.contexto);
        if (!F.contextIsEmpty(c)) {
          d.draft = { ...c, fromMeeting: meta.id, fromTitle: meta.title, at: new Date().toISOString(), kind: F.contextIsEmpty(d.context) ? 'new' : 'update' };
          notes.push(d.draft.kind === 'new' ? 'contexto da pasta montado (aguardando sua aprovação)' : 'sugestão de atualização do contexto');
        }
      }
      return d;
    });
    if (notes.some((n) => n.includes('contexto'))) this.emit('folder-draft', { name, id: meta.id, kind: this.library.getFolder(name).draft?.kind });
    return notes.join(' · ');
  }

  // Monta contexto + histórico de uma pasta a partir dos resumos que ela já tem
  async bootstrapFolder(name, onStatus) {
    const folder = this.library.getFolder(name);
    if (!name || !folder) throw new UserError('Pasta não encontrada.');
    const metas = this.library.list().filter((m) => m.folder === name && this.library.readText(m.id, 'summary.md')).slice(0, 12).reverse();
    if (!metas.length) throw new UserError('Esta pasta ainda não tem reuniões com resumo.');
    const settings = this.store.get();
    const docs = metas.map((m) => `--- ${m.title} (${new Date(m.createdAt).toLocaleDateString('pt-BR')}) ---\n${(this.library.readText(m.id, 'summary.md') || '').slice(0, 4000)}`).join('\n\n');
    const prompt = `Você vai montar a memória de uma pasta de reuniões do app MeetRec a partir dos resumos abaixo (em ordem cronológica).
Não use ferramentas. Responda SOMENTE com um bloco neste formato (JSON válido):
\`\`\`meetrec
{"contexto": {"resumo": "do que se trata o projeto/assunto em 1-2 frases", "participantes": [{"nome": "", "papel": ""}], "objetivos": [""], "observacoes": ""},
 "historico": "o histórico da pasta (regras abaixo)"}
\`\`\`
${HISTORY_RULES}

=== PASTA "${name}" ===
${folder.description ? `Descrição dada pelo usuário: ${folder.description}\n` : ''}${F.contextToText(folder.context) ? `Contexto atual:\n${F.contextToText(folder.context)}\n` : ''}
=== RESUMOS ===
${docs}`;
    onStatus?.(`Lendo ${metas.length} ${metas.length === 1 ? 'resumo' : 'resumos'}…`);
    const res = await runAI({ prompt, settings, cwd: this.library.folderDir(name), onStatus });
    const parsed = F.splitSummary(res.text.includes('```meetrec') ? res.text : '```meetrec\n' + res.text);
    if (!parsed.data) throw new UserError(`O ${engineName(settings)} não devolveu o contexto no formato esperado. Tente de novo.`);
    const last = metas[metas.length - 1];
    const note = this._applyFolderBlock(name, parsed.data, { id: last.id, title: `${metas.length} ${metas.length === 1 ? 'reunião' : 'reuniões'} da pasta` });
    return { message: note || 'Nada novo para acrescentar.' };
  }

  // "Enxugar com o Claude": propõe um histórico (e contexto) mais curto, que você aprova antes de valer
  async slimFolder(name, onStatus) {
    const folder = this.library.getFolder(name);
    if (!name || !folder) throw new UserError('Pasta não encontrada.');
    if (!folder.history && F.contextIsEmpty(folder.context)) throw new UserError('Esta pasta ainda não tem histórico nem contexto para enxugar.');
    const settings = this.store.get();
    const recent = this.library.list().filter((m) => m.folder === name && this.library.readText(m.id, 'summary.md')).slice(0, 3).reverse();
    const docs = recent.map((m) => `--- ${m.title} (${new Date(m.createdAt).toLocaleDateString('pt-BR')}) ---\n${(this.library.readText(m.id, 'summary.md') || '').slice(0, 2500)}`).join('\n\n');
    const prompt = `Você vai ENXUGAR a memória de uma pasta de reuniões do app MeetRec, para que ela continue útil e curta.
Não use ferramentas. Responda SOMENTE com um bloco neste formato (JSON válido):
\`\`\`meetrec
{"historico": "o histórico enxuto", "contexto": null ou o contexto COMPLETO enxuto no formato {"resumo": "", "participantes": [{"nome": "", "papel": ""}], "objetivos": [""], "observacoes": ""}, "removido": ["frases curtas do que você tirou e por quê"]}
\`\`\`
Como enxugar:
- Junte itens repetidos, remova decisões substituídas e pendências que as reuniões recentes mostram resolvidas.
- Pendências marcadas "(antiga)": remova as que claramente perderam o sentido; mantenha (com "(antiga)") as que ainda podem valer.
- Mire em menos de ${Math.round(F.HISTORY_MAX * 0.6)} caracteres no histórico. Não invente nada.
- Só devolva "contexto" se ele estiver longo ou com informação desatualizada; senão use null.
${HISTORY_RULES}

=== PASTA "${name}" ===
${folder.description ? `Descrição: ${folder.description}\n` : ''}
=== CONTEXTO ATUAL ===
${F.contextToText(folder.context) || '(vazio)'}

=== HISTÓRICO ATUAL ===
${folder.history || '(vazio)'}

=== RESUMOS DAS REUNIÕES MAIS RECENTES ===
${docs || '(nenhum)'}`;
    onStatus?.(`O ${engineName(settings)} está enxugando a memória da pasta…`);
    const res = await runAI({ prompt, settings, cwd: this.library.folderDir(name), onStatus });
    const parsed = F.splitSummary(res.text.includes('```meetrec') ? res.text : '```meetrec\n' + res.text);
    const h = parsed.data?.historico;
    if (typeof h !== 'string') throw new UserError(`O ${engineName(settings)} não devolveu o histórico no formato esperado. Tente de novo.`);
    const ctx = parsed.data.contexto && typeof parsed.data.contexto === 'object' ? F.normalizeContext(parsed.data.contexto) : null;
    const slim = {
      history: F.capHistory(h).text,
      context: ctx && !F.contextIsEmpty(ctx) ? ctx : null,
      removed: (Array.isArray(parsed.data.removido) ? parsed.data.removido : []).map(String).filter(Boolean).slice(0, 15),
      at: new Date().toISOString(),
    };
    this.library.updateFolder(name, { slim });
    const before = F.folderSize(folder).historyChars, after = slim.history.length;
    return { message: `Proposta pronta: histórico de ${before} para ${after} caracteres. Confira e aprove.` };
  }

  // Pergunta livre ao Claude sobre a reunião
  async ask(id, question, onText) {
    const { meta, settings, header, text, folder } = this.buildContext(id);
    const summary = this.library.readText(id, 'summary.md') || '';
    const history = (meta.chat || []).slice(-10).map((c) => `${c.role === 'user' ? 'Usuário' : 'Assistente'}: ${c.text}`).join('\n\n');
    const prompt = `Você é um assistente que responde perguntas sobre uma reunião gravada. Responda em português, de forma direta e objetiva, citando horários [mm:ss] da transcrição quando útil. Não use ferramentas. Use texto simples (listas com • são ok).

${folder.text ? `${folder.text}\n\n` : ''}=== DADOS DA REUNIÃO ===
${header}

${summary ? `=== RESUMO ===\n${summary}\n\n` : ''}=== TRANSCRIÇÃO ===
${text}

${history ? `=== CONVERSA ANTERIOR ===\n${history}\n\n` : ''}=== PERGUNTA ===
${question}`;
    this.library.update(id, (m) => { m.chat = [...(m.chat || []), { role: 'user', text: question, at: new Date().toISOString() }]; return m; });
    try {
      const res = await runAI({ prompt, settings, cwd: this.library.dir(id), onText: (_d, full) => onText?.(full) });
      this.library.update(id, (m) => { m.chat = [...(m.chat || []), { role: 'assistant', text: res.text, at: new Date().toISOString() }]; return m; });
      return res.text;
    } catch (e) {
      this.library.update(id, (m) => { m.chat = [...(m.chat || []), { role: 'error', text: e.message, at: new Date().toISOString() }]; return m; });
      throw e;
    }
  }
}

module.exports = { Pipeline, parseSummary, blockRules };
