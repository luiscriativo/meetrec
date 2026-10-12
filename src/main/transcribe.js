// Motores de transcrição: local (faster-whisper) ou nuvem (Groq / OpenAI Whisper).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ffmpegPath, resourcePath, run, findPython } = require('./tools');

class UserError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

async function ffmpeg(args, label) {
  const r = await run(ffmpegPath(), ['-hide_banner', '-y', ...args], { timeout: 60 * 60 * 1000 });
  if (r.code !== 0) throw new Error(`ffmpeg falhou (${label}): ${r.err.slice(-400)}`);
}

async function transcribeLocal({ file, duration, settings, onProgress, onStatus, onChild }) {
  const py = await findPython(settings.pythonPath);
  if (!py) throw new UserError('Python 3 não encontrado. Instale o Python 3.9+ ou use um motor na nuvem (Groq/OpenAI) em Configurações.', 'no-python');

  const wav = file.replace(/\.[^.]+$/, '') + '.16k.wav';
  onStatus?.('Preparando áudio para o Whisper…');
  await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], 'wav');
  const outJson = file.replace(/\.[^.]+$/, '') + '.whisper.json';
  const script = resourcePath('python', 'transcribe.py');

  let lastError = '';
  let buf = '';
  const r = await run(py.cmd, [...py.args, '-u', script,
    '--input', wav, '--output', outJson,
    '--model', settings.localModel || 'small',
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
            ? 'O motor local (faster-whisper) não está instalado. Vá em Diagnóstico → "Instalar motor local".'
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

module.exports = { transcribe, UserError };
