// Pipeline pós-gravação: preparar áudio → transcrever → identificar falantes → resumir (Claude Code).
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { ffmpegPath, run, probeAudio } = require('./tools');
const { transcribe, UserError } = require('./transcribe');
const { buildTranscript, transcriptToText, fmtTime } = require('./speakers');
const { runClaude, readSkill } = require('./claude');
const { STEP_NAMES } = require('./library');

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

☐ Responsável: ação concreta, com prazo se mencionado.

(*) Termos com reconhecimento de voz duvidoso: "X" (aparece como "Y"). Inclua só se houver.`;

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

  // Chamado quando uma gravação termina: retoma a fila que estava esperando
  resume() { this._next(); }

  isBusy(id) { return this.current?.id === id || this.queue.some((j) => j.id === id); }
  status() { return { current: this.current, queued: this.queue.map((j) => j.id) }; }

  enqueue(id, from = 'audio') {
    if (this.isBusy(id)) return false;
    this.library.resetSteps(id, from);
    this.library.update(id, { status: 'processing', error: null });
    this.queue.push({ id, from });
    if (this.isRecording()) this.library.setStep(id, from, { message: 'Na fila — começa quando a gravação atual terminar.' });
    else if (this.current) this.library.setStep(id, from, { message: 'Na fila — aguardando a reunião anterior terminar de processar.' });
    this.emit('queued', { id, position: this.queue.length - (this.current ? 0 : 1) });
    this._next();
    return true;
  }

  cancel(id) {
    const qi = this.queue.findIndex((j) => j.id === id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.library.update(id, { status: 'error', error: 'Processamento cancelado.' });
      return true;
    }
    if (this.current?.id === id) {
      this.cancelled = true;
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
      const msg = e instanceof UserError ? e.message : `Erro inesperado: ${e.message}`;
      if (step) this._step(id, step, { state: 'error', message: msg }, true);
      this.library.update(id, { status: 'error', error: msg });
      this.emit('failed', { id, step, error: msg, code: e.code });
    } finally {
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
    const f = (n) => this.library.file(id, n);
    const msg = (m, p) => this._step(id, 'audio', { message: m, progress: p });
    const warnings = [];
    const info = {};

    if (meta.source === 'import') {
      msg('Convertendo arquivo importado…', 0.2);
      const r = await run(ffmpegPath(), ['-hide_banner', '-y', '-i', f(meta.originalFile), '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', f('mix.webm')], { timeout: 3600e3, onSpawn: (c) => this._setChild(c) });
      if (r.code !== 0) throw new UserError('Não consegui ler o arquivo importado. Ele contém áudio? ' + r.err.slice(-200));
      this.library.update(id, { tracks: { mix: true }, audioFile: 'mix.webm' });
    } else {
      const tracks = Object.entries(meta.tracks || {}).filter(([, v]) => v).map(([k]) => k);
      if (!tracks.length) throw new UserError('Nenhum áudio foi gravado nesta reunião.');
      let i = 0;
      for (const t of tracks) {
        msg(`Finalizando faixa ${t === 'mic' ? 'do microfone' : t === 'system' ? 'do sistema' : 'mixada'}…`, i++ / tracks.length * 0.5);
        const src = f(`${t}.webm`);
        if (!fs.existsSync(src) || fs.statSync(src).size < 1000) { meta.tracks[t] = false; continue; }
        const tmp = f(`${t}.fixed.webm`);
        const r = await run(ffmpegPath(), ['-hide_banner', '-y', '-i', src, '-c', 'copy', tmp], { timeout: 3600e3 });
        if (r.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) fs.renameSync(tmp, src);
        else { try { fs.unlinkSync(tmp); } catch {} }
      }
      this.library.update(id, { tracks: meta.tracks, audioFile: meta.tracks.mix ? 'mix.webm' : (meta.tracks.system ? 'system.webm' : 'mic.webm') });
    }

    const m2 = this.library.get(id);
    const tracks = Object.entries(m2.tracks).filter(([, v]) => v).map(([k]) => k);
    let i = 0;
    for (const t of tracks) {
      msg('Analisando volume e duração…', 0.5 + (i++ / tracks.length) * 0.5);
      info[t] = await probeAudio(f(`${t}.webm`));
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
    const settings = this.store.get();
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
    const engineName = settings.engine === 'local' ? `Whisper local (${settings.localModel})` : settings.engine === 'groq' ? 'Groq Whisper' : 'OpenAI Whisper';
    for (let i = 0; i < jobs.length; i++) {
      const t = jobs[i];
      const label = t === 'mic' ? 'sua voz' : t === 'system' ? 'participantes' : 'áudio';
      const t0 = Date.now();
      let lastStatus = '';
      raw[t] = await transcribe({
        file: this.library.file(id, `${t}.webm`),
        duration: info[t]?.duration,
        settings,
        onChild: (c) => this._setChild(c),
        onStatus: (m, code) => {
          if (code !== 'segment') lastStatus = m;
          this._step(id, 'transcribe', { message: `${engineName} · ${label}: ${code === 'segment' ? m : lastStatus}` });
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
    return { message: `${n} trechos transcritos com ${engineName}` };
  }

  // 3) Une as faixas e identifica quem falou
  async _speakers(id) {
    const meta = this.library.get(id);
    const raw = this.library.readJson(id, 'transcript.raw.json') || {};
    const events = (this.library.readText(id, 'events.jsonl') || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    this._step(id, 'speakers', { message: events.length ? `Cruzando ${events.length} eventos da extensão…` : 'Separando sua voz dos participantes…', progress: 0.3 });
    const settings = this.store.get();
    const { segments, stats, participants } = buildTranscript({ mic: raw.mic, sys: raw.system, mix: raw.mix, events, userName: settings.userName });
    this.library.writeJson(id, 'transcript.json', { segments });
    this.library.writeText(id, 'transcript.txt', transcriptToText(segments, meta.speakerNames));

    const extNames = [...new Set([...(meta.participants || []), ...stats.knownSpeakers])];
    const allPeople = [...new Set([...participants.filter((p) => p !== 'Participante'), ...extNames])];
    this.library.update(id, { participants: allPeople, speakerStats: stats });

    const parts = [];
    if (stats.named) parts.push(`${stats.named} falas identificadas por nome`);
    else if (meta.tracks.mic && meta.tracks.system) parts.push('sua voz separada dos participantes');
    if (stats.echoRemoved) parts.push(`${stats.echoRemoved} ecos removidos`);
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
    return { meta, settings, header: lines.join('\n'), text };
  }

  // 4) Gera o resumo com o Claude Code
  async _summary(id) {
    const { meta, settings, header, text } = this.buildContext(id);
    const skill = settings.useSkill ? readSkill() : null;
    const owner = settings.userName || 'Você';
    const prompt = `Gere o resumo de uma reunião gravada pelo app MeetRec.

=== INSTRUÇÕES DE FORMATO ${skill ? '(skill resumo-reuniao)' : ''} ===
${skill || FALLBACK_FORMAT}

=== REGRAS DESTA EXECUÇÃO (têm prioridade) ===
- Não use ferramentas, não leia nem salve arquivos: responda SOMENTE com o texto final do resumo, começando pela linha "📋".
- A transcrição já está abaixo, com horários [mm:ss] e quem falou.
- "${owner}" é a pessoa que gravou (falas do microfone dela). "Participante" indica outras pessoas não identificadas por nome; se der para deduzir nomes pelo contexto, use-os.
- Dê atenção especial aos momentos marcados e às anotações do usuário, quando houver.
${settings.customInstructions ? `- Instruções adicionais do usuário: ${settings.customInstructions}\n` : ''}
=== DADOS DA REUNIÃO ===
${header}

=== TRANSCRIÇÃO ===
${text}
`;
    this.library.writeText(id, 'summary.prompt.txt', prompt);
    let lastEmit = 0;
    const res = await runClaude({
      prompt,
      settings,
      cwd: this.library.dir(id),
      onChild: (c) => this._setChild(c),
      onStatus: (m) => this._step(id, 'summary', { message: m }),
      onText: (_d, full) => {
        const now = Date.now();
        if (now - lastEmit > 120) {
          lastEmit = now;
          this.emit('summary-stream', { id, text: full });
          this._step(id, 'summary', { progress: Math.min(0.95, full.length / 2500) });
        }
      },
    });
    this.emit('summary-stream', { id, text: res.text });
    if (!res.text) throw new UserError('O Claude retornou uma resposta vazia.');
    this.library.writeText(id, 'summary.md', res.text);
    const { title, actions } = parseSummary(res.text);
    const patch = { summary: { generatedAt: new Date().toISOString(), model: res.model, costUsd: res.costUsd, durationMs: res.durationMs }, actions };
    if (title && this.library.get(id).titleAuto) patch.title = title;
    this.library.update(id, patch);
    const secs = res.durationMs ? ` em ${Math.round(res.durationMs / 1000)}s` : '';
    return { message: `Resumo gerado${secs}${actions.length ? ` · ${actions.length} itens de ação` : ''}` };
  }

  // Pergunta livre ao Claude sobre a reunião
  async ask(id, question, onText) {
    const { meta, settings, header, text } = this.buildContext(id);
    const summary = this.library.readText(id, 'summary.md') || '';
    const history = (meta.chat || []).slice(-10).map((c) => `${c.role === 'user' ? 'Usuário' : 'Assistente'}: ${c.text}`).join('\n\n');
    const prompt = `Você é um assistente que responde perguntas sobre uma reunião gravada. Responda em português, de forma direta e objetiva, citando horários [mm:ss] da transcrição quando útil. Não use ferramentas. Use texto simples (listas com • são ok).

=== DADOS DA REUNIÃO ===
${header}

${summary ? `=== RESUMO ===\n${summary}\n\n` : ''}=== TRANSCRIÇÃO ===
${text}

${history ? `=== CONVERSA ANTERIOR ===\n${history}\n\n` : ''}=== PERGUNTA ===
${question}`;
    this.library.update(id, (m) => { m.chat = [...(m.chat || []), { role: 'user', text: question, at: new Date().toISOString() }]; return m; });
    try {
      const res = await runClaude({ prompt, settings, cwd: this.library.dir(id), onText: (_d, full) => onText?.(full) });
      this.library.update(id, (m) => { m.chat = [...(m.chat || []), { role: 'assistant', text: res.text, at: new Date().toISOString() }]; return m; });
      return res.text;
    } catch (e) {
      this.library.update(id, (m) => { m.chat = [...(m.chat || []), { role: 'error', text: e.message, at: new Date().toISOString() }]; return m; });
      throw e;
    }
  }
}

module.exports = { Pipeline, parseSummary };
