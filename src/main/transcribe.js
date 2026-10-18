// Motores de transcrição: local (faster-whisper) ou nuvem (OpenAI Whisper).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ffmpegPath, resourcePath, run } = require('./tools');
const { fmtBytes } = require('./engine');

class UserError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

async function ffmpeg(args, label) {
  const r = await run(ffmpegPath(), ['-hide_banner', '-y', ...args], { timeout: 60 * 60 * 1000 });
  if (r.code !== 0) throw new Error(`ffmpeg falhou (${label}): ${r.err.slice(-400)}`);
}

// Motor local (Python + faster-whisper) — definido pelo main (configureLocal)
let engine = null;
function configureLocal(opts) { engine = opts.engine; }

// Espera uma tarefa longa, mas desiste na hora se a pessoa cancelar (a tarefa segue em segundo plano)
async function untilCancelled(promise, isCancelled) {
  let poll;
  const cancel = new Promise((_, reject) => {
    poll = setInterval(() => { if (isCancelled?.()) reject(new UserError('Transcrição cancelada.', 'cancelled')); }, 300);
  });
  try { return await Promise.race([promise, cancel]); } finally { clearInterval(poll); }
}

async function transcribeLocal({ file, duration, settings, onProgress, onStatus, onChild, isCancelled }) {
  let py = await engine.find(settings);
  // Primeira vez: instala o motor sozinho (Python só do app + faster-whisper)
  if (!py) {
    onStatus?.('Instalando o motor de transcrição (só na primeira vez, ~1 min)…', 'installing');
    const onState = (st) => { if (st.phase === 'installing' && st.message) onStatus?.(`Instalando o motor de transcrição (só na primeira vez) · etapa ${st.step} de ${st.steps}: ${st.message}`, 'installing'); };
    engine.on('state', onState);
    try { py = await untilCancelled(engine.install(), isCancelled); } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(e.message, e.code === 'cancelled' ? 'cancelled' : 'no-python');
    } finally { engine.off('state', onState); }
  }
  // Modelo ainda não baixado: baixa antes, com progresso
  const model = settings.localModel || 'small';
  if (!engine.modelStatus(model).ready) {
    const say = (st) => {
      const pct = st.total ? Math.floor((st.received / st.total) * 100) : 0;
      const eta = st.eta != null ? ` · falta${st.eta >= 90 ? `m ~${Math.round(st.eta / 60)} min` : ' menos de 2 min'}` : '';
      onStatus?.(`Baixando o modelo (só na 1ª vez): ${pct}% de ${fmtBytes(st.total)}${eta}`, 'downloading');
    };
    const onDl = (st) => { if (st.downloading) say(st); };
    say(engine.modelStatus(model));
    engine.on('model-progress', onDl);
    try { await untilCancelled(engine.ensureModel(model, py.cmd), isCancelled); } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(e.code === 'cancelled' ? 'Download do modelo pausado.' : e.message, e.code === 'cancelled' ? 'cancelled' : 'model-download');
    } finally { engine.off('model-progress', onDl); }
  }

  const wav = file.replace(/\.[^.]+$/, '') + '.16k.wav';
  onStatus?.('Preparando áudio para o Whisper…');
  await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], 'wav');
  const outJson = file.replace(/\.[^.]+$/, '') + '.whisper.json';
  const script = resourcePath('python', 'transcribe.py');
  if (isCancelled?.()) { try { fs.unlinkSync(wav); } catch {} throw new UserError('Transcrição cancelada.', 'cancelled'); }

  let lastError = '';
  let buf = '';
  const r = await run(py.cmd, ['-u', script,
    '--input', wav, '--output', outJson,
    '--model', model,
    '--language', settings.language || 'pt',
    '--duration', String(duration || 0),
    '--prompt', settings.vocabulary ? `Vocabulário: ${settings.vocabulary}` : '',
    // Núcleos físicos (≈ metade dos lógicos) rendem mais no Whisper e deixam folga para o resto do PC
    '--threads', String(Math.max(2, Math.floor(os.cpus().length / 2))),
  ], {
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    onSpawn: onChild,
    onStdout: (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'progress') onProgress?.(ev.value);
          else if (ev.type === 'status') onStatus?.(ev.message, ev.code);
          else if (ev.type === 'segment') onStatus?.(`“${ev.text.slice(0, 90)}”`, 'segment');
          else if (ev.type === 'error') lastError = ev.code === 'missing'
            ? 'O motor de transcrição não está instalado. Vá em Diagnóstico → "Instalar motor".'
            : ev.message;
        } catch { /* linha não-JSON */ }
      }
    },
  });
  try { fs.unlinkSync(wav); } catch {}
  if (r.code !== 0 || !fs.existsSync(outJson)) {
    if (r.code === null) throw new UserError('Transcrição cancelada.', 'cancelled');
    throw new UserError(lastError || `O Whisper local falhou: ${r.err.slice(-500)}`, 'local-failed');
  }
  const data = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  try { fs.unlinkSync(outJson); } catch {}
  return data.segments || [];
}

const CLOUD = {
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
  return opts.settings.engine === 'openai' ? transcribeCloud(opts) : transcribeLocal(opts);
}

module.exports = { transcribe, configureLocal, UserError };
