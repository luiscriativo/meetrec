// Motores de transcrição: local (whisper.cpp embutido) ou nuvem (Groq / OpenAI Whisper).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ffmpegPath, run } = require('./tools');
const W = require('./whisper');

class UserError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

async function ffmpeg(args, label) {
  const r = await run(ffmpegPath(), ['-hide_banner', '-y', ...args], { timeout: 60 * 60 * 1000 });
  if (r.code !== 0) throw new Error(`ffmpeg falhou (${label}): ${r.err.slice(-400)}`);
}

// Pasta de trabalho e modelos do motor local — definidos pelo main (configureLocal)
let local = { models: null, workDir: null };
function configureLocal(opts) { local = { ...local, ...opts }; }

// Códigos de saída do Windows que pedem uma mensagem específica
const WIN_CRASH = {
  3221225501: 'O processador deste computador não é compatível com o motor local. Use Groq ou OpenAI em Configurações → Transcrição.', // 0xC000001D
  3221225781: 'Faltam arquivos do motor local nesta instalação. Reinstale o MeetRec.', // 0xC0000135
};

async function transcribeLocal({ file, duration, settings, onProgress, onStatus, onChild, isCancelled }) {
  const cancelled = () => new UserError('Transcrição cancelada.', 'cancelled');
  const bin = W.binaryPath();
  if (!bin) throw new UserError('O motor de transcrição local não foi encontrado nesta instalação. Reinstale o MeetRec ou use Groq/OpenAI em Configurações → Transcrição.', 'no-engine');
  const { models, workDir } = local;
  const m = W.modelInfo(settings.localModel);

  if (!models.isReady(m.id)) {
    const say = (st) => {
      const pct = st.total ? Math.floor((st.received / st.total) * 100) : 0;
      const eta = st.eta != null ? ` · falta${st.eta >= 90 ? 'm ~' + Math.round(st.eta / 60) + ' min' : ' menos de 2 min'}` : '';
      onStatus?.(`Baixando o modelo (só na 1ª vez): ${pct}% de ${W.fmtBytes(st.total)}${eta}`, 'downloading');
    };
    const onDl = (st) => { if (st.id === m.id && st.downloading) say(st); };
    say(models.status(m.id));
    models.on('progress', onDl);
    // Cancelar a transcrição não espera o download acabar (ele segue em segundo plano e é reaproveitado)
    let poll;
    const userCancel = new Promise((_, reject) => { poll = setInterval(() => { if (isCancelled?.()) reject(cancelled()); }, 300); });
    try { await Promise.race([models.ensure(m.id), userCancel]); } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(e.code === 'cancelled' ? 'Download do modelo cancelado.' : e.message, e.code === 'cancelled' ? 'cancelled' : 'model-download');
    } finally { clearInterval(poll); models.off('progress', onDl); }
  }

  fs.mkdirSync(workDir, { recursive: true });
  // Arquivos temporários na pasta de trabalho (fora da biblioteca, que pode estar no Google Drive),
  // com nomes ASCII: o whisper-cli recebe só caminhos relativos a ela
  const tag = crypto.randomBytes(4).toString('hex');
  const wavName = `audio-${tag}.wav`;
  const outBase = `out-${tag}`;
  const wav = path.join(workDir, wavName);
  const outJson = path.join(workDir, outBase + '.json');
  // Caminho relativo só com ASCII; se não der (outra pasta/disco com acento), usa um link do
  // arquivo dentro da pasta de trabalho (instantâneo no mesmo disco; senão, uma cópia)
  const linked = [];
  const rel = (p) => {
    const r = path.relative(workDir, p).split(path.sep).join('/');
    if (/^[\x20-\x7e]+$/.test(r) && !path.isAbsolute(r)) return r;
    const local = path.join(workDir, path.basename(p));
    try { fs.linkSync(p, local); } catch { fs.copyFileSync(p, local); }
    linked.push(local);
    return path.basename(p);
  };

  onStatus?.('Preparando áudio para o Whisper…');
  await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], 'wav');

  if (isCancelled?.()) { try { fs.unlinkSync(wav); } catch {} throw cancelled(); }
  const acp = await W.windowsAcp(run);
  const args = W.buildArgs({
    model: rel(models.file(m.id)),
    vad: rel(models.vadFile()),
    input: wavName,
    outBase,
    language: settings.language || 'pt',
    prompt: W.argText(settings.vocabulary ? `Vocabulário: ${settings.vocabulary}` : '', acp),
    // Núcleos físicos (≈ metade dos lógicos) rendem mais no Whisper e deixam folga para o resto do PC
    threads: Math.max(2, Math.floor(os.cpus().length / 2)),
  });

  onStatus?.(`Carregando o modelo ${m.label}…`, 'loading');
  let buf = '', errTail = '', stage = 'loading';
  const r = await run(bin, args, {
    cwd: workDir,
    onSpawn: onChild,
    onStderr: (d) => {
      errTail = (errTail + d).slice(-4000);
      if (stage === 'loading' && /whisper_vad/.test(d)) { stage = 'vad'; onStatus?.('Encontrando os trechos com fala…', 'vad'); }
    },
    onStdout: (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const seg = W.parseSegmentLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!seg) continue;
        if (stage !== 'transcribing') { stage = 'transcribing'; onStatus?.('Transcrevendo…', 'transcribing'); }
        if (duration) onProgress?.(Math.min(0.999, seg.end / duration));
        if (seg.text) onStatus?.(`“${seg.text.slice(0, 90)}”`, 'segment');
      }
    },
  });
  for (const f of [wav, ...linked]) { try { fs.unlinkSync(f); } catch {} }
  if (r.code !== 0 || !fs.existsSync(outJson)) {
    try { fs.unlinkSync(outJson); } catch {}
    if (r.code === null) throw new UserError('Transcrição cancelada.', 'cancelled');
    if (WIN_CRASH[r.code]) throw new UserError(WIN_CRASH[r.code], 'local-failed');
    const why = errTail.split(/\r?\n/).filter((l) => /error|failed|unable/i.test(l)).slice(-3).join(' · ') || errTail.slice(-300);
    throw new UserError(`O Whisper local falhou (código ${r.code}): ${why}`, 'local-failed');
  }
  const data = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  try { fs.unlinkSync(outJson); } catch {}
  onProgress?.(1);
  return W.segmentsFromJson(data);
}

const CLOUD = {
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3-turbo', key: 'groqKey', name: 'Groq' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1', key: 'openaiKey', name: 'OpenAI' },
};

async function transcribeCloud({ file, duration, settings, onProgress, onStatus }) {
  const cfg = CLOUD[settings.engine];
  const key = settings[cfg.key];
  if (!key) throw new UserError(`Configure a chave de API do ${cfg.name} em Configurações → Transcrição.`, 'no-key');

  const base = file.replace(/\.[^.]+$/, '');
  onStatus?.('Compactando áudio para envio…');
  const mp3 = base + '.upload.mp3';
  await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', mp3], 'mp3');

  // Limite de 25 MB por requisição: divide em blocos de 20 min quando necessário
  let chunks = [{ file: mp3, offset: 0 }];
  if (fs.statSync(mp3).size > 24 * 1024 * 1024) {
    onStatus?.('Áudio longo: dividindo em partes…');
    const pattern = base + '.part%03d.mp3';
    await ffmpeg(['-i', mp3, '-f', 'segment', '-segment_time', '1200', '-c', 'copy', pattern], 'split');
    const dir = path.dirname(base);
    const prefix = path.basename(base) + '.part';
    chunks = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort()
      .map((f, i) => ({ file: path.join(dir, f), offset: i * 1200 }));
  }

  const all = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      onStatus?.(chunks.length > 1 ? `Enviando parte ${i + 1} de ${chunks.length} para ${cfg.name}…` : `Enviando para ${cfg.name}…`);
      onProgress?.(i / chunks.length + 0.05 / chunks.length);
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(c.file)], { type: 'audio/mpeg' }), path.basename(c.file));
      fd.append('model', cfg.model);
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'segment');
      if (settings.language) fd.append('language', settings.language);
      if (settings.vocabulary) fd.append('prompt', `Vocabulário: ${settings.vocabulary}`);
      let res;
      try {
        res = await fetch(cfg.url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
      } catch (e) {
        throw new UserError(`Sem conexão com ${cfg.name}: ${e.message}`, 'network');
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401) throw new UserError(`Chave de API do ${cfg.name} inválida (401).`, 'auth');
        if (res.status === 429) throw new UserError(`${cfg.name}: limite de uso atingido (429). Tente novamente em alguns minutos.`, 'rate');
        if (res.status === 413) throw new UserError(`${cfg.name}: arquivo grande demais (413).`, 'size');
        throw new UserError(`${cfg.name} respondeu ${res.status}: ${body.slice(0, 300)}`, 'http');
      }
      const data = await res.json();
      for (const s of data.segments || []) {
        const text = (s.text || '').trim();
        if (text) all.push({ start: +(s.start + c.offset).toFixed(2), end: +(s.end + c.offset).toFixed(2), text });
      }
      onProgress?.((i + 1) / chunks.length);
    }
  } finally {
    for (const c of chunks) { try { fs.unlinkSync(c.file); } catch {} }
    try { fs.unlinkSync(mp3); } catch {}
  }
  return all;
}

function transcribe(opts) {
  return opts.settings.engine === 'local' ? transcribeLocal(opts) : transcribeCloud(opts);
}

module.exports = { transcribe, configureLocal, UserError };
