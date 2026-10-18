// Motor de transcrição local: whisper.cpp (binário embutido no app, sem Python) + modelos ggml
// baixados sob demanda do Hugging Face, com progresso, retomada e conferência por SHA-256.
// Sem dependência obrigatória do Electron: as partes puras são testadas com node --test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');

const isWin = process.platform === 'win32';
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

// Modelos oferecidos (ids compatíveis com as configurações antigas). Os quantizados (q5) têm
// praticamente a mesma precisão e ocupam/consomem bem menos.
const MODELS = {
  base: { file: 'ggml-base-q5_1.bin', size: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898', label: 'Básico', desc: 'Muito rápido, menos preciso. Para PCs bem simples.' },
  small: { file: 'ggml-small.bin', size: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b', label: 'Small', desc: 'Rápido, boa precisão.' },
  medium: { file: 'ggml-medium-q5_0.bin', size: 539212467, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f', label: 'Medium', desc: 'Mais preciso que o Small, mais lento.' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', label: 'Large v3 Turbo', desc: 'Ótima precisão, bom em PCs atuais.', recommended: true },
  'large-v3': { file: 'ggml-large-v3-q5_0.bin', size: 1081140203, sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1', label: 'Large v3', desc: 'Máxima precisão, bem mais lento.' },
};
const DEFAULT_MODEL = 'large-v3-turbo';
// Detector de fala (VAD): pula os silêncios — mais rápido e evita "alucinações" em trechos mudos
const VAD = { file: 'ggml-silero-v5.1.2.bin', size: 885098, sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' };

const modelId = (id) => (MODELS[id] ? id : DEFAULT_MODEL);
const modelInfo = (id) => ({ id: modelId(id), ...MODELS[modelId(id)] });

function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

// ───────────────────────── Binário ─────────────────────────
// Instalado: resources/whisper/. Desenvolvimento: vendor/whisper/ (npm run whisper).
function binaryPath() {
  const name = isWin ? 'whisper-cli.exe' : 'whisper-cli';
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'whisper'));
  dirs.push(path.join(__dirname, '..', '..', 'vendor', 'whisper'));
  for (const d of dirs) { const p = path.join(d, name); if (fs.existsSync(p)) return p; }
  return null;
}

// ───────────────────────── Argumentos ─────────────────────────
// O whisper-cli do Windows recebe os argumentos na página de código do sistema (não em UTF-8):
// caminhos com acento derrubam o programa e o vocabulário chegaria corrompido. Por isso:
// 1) caminhos são sempre relativos (ASCII) a partir de uma pasta de trabalho (cwd);
// 2) texto livre é convertido para que os bytes UTF-8 cheguem intactos.
const CP1252 = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9f: 'Ÿ' };

/** Prepara texto para a linha de comando conforme a página de código ANSI do Windows (acp). */
function argText(text, acp) {
  if (!text) return '';
  if (acp == null || acp === 65001) return text; // macOS/Linux, ou Windows já em UTF-8
  if (acp === 1252) return [...Buffer.from(text, 'utf8')].map((b) => CP1252[b] || String.fromCharCode(b)).join('');
  // Outra página de código: sem acentos é melhor que corrompido
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '');
}

let acpCache;
async function windowsAcp(run) {
  if (!isWin) return null;
  if (acpCache !== undefined) return acpCache;
  const r = await run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { timeout: 5000 });
  const m = r.out.match(/ACP\s+REG_SZ\s+(\d+)/);
  acpCache = m ? Number(m[1]) : 1252;
  return acpCache;
}

function buildArgs({ model, vad, input, outBase, language, prompt, threads }) {
  const args = ['-m', model, '-f', input, '-l', language || 'auto', '-t', String(threads || 4), '-oj', '-of', outBase,
    // Sem contexto do trecho anterior: evita que um erro se repita em cascata (como no app antigo)
    '-mc', '0'];
  if (vad) args.push('--vad', '-vm', vad, '--vad-min-silence-duration-ms', '500');
  if (prompt) args.push('--prompt', prompt);
  return args;
}

// Linha impressa pelo whisper-cli a cada trecho: [00:01:02.340 --> 00:01:05.000]  texto
const SEG_RE = /^\[(\d+):(\d{2}):(\d{2})\.(\d{3}) --> (\d+):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/;
function parseSegmentLine(line) {
  const m = SEG_RE.exec(line.trim());
  if (!m) return null;
  const t = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +ms / 1000;
  return { start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]), text: m[9].trim() };
}

function segmentsFromJson(data) {
  const out = [];
  for (const s of data?.transcription || []) {
    const text = (s.text || '').trim();
    if (!text) continue;
    out.push({ start: +(s.offsets.from / 1000).toFixed(2), end: +(s.offsets.to / 1000).toFixed(2), text });
  }
  return out;
}

// ───────────────────────── Download dos modelos ─────────────────────────
function netFetch() {
  try { const { net } = require('electron'); if (net?.fetch) return net.fetch.bind(net); } catch { /* fora do Electron */ }
  return fetch;
}

class DownloadError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

/**
 * Gerencia os modelos em <dir>. Um download por vez por modelo, compartilhado entre quem pedir
 * (assistente, Diagnóstico, Configurações e a fila de transcrição). Eventos: 'progress' (status).
 */
class ModelManager extends EventEmitter {
  constructor(dir, { fetchImpl } = {}) {
    super();
    this.dir = dir;
    this.fetch = fetchImpl || null;
    this.jobs = new Map(); // id → { promise, controller, status }
  }

  file(id) { return path.join(this.dir, modelInfo(id).file); }
  vadFile() { return path.join(this.dir, VAD.file); }

  _ok(file, size) {
    try { return fs.statSync(file).size === size; } catch { return false; }
  }

  isReady(id) {
    const m = modelInfo(id);
    return this._ok(this.file(m.id), m.size) && this._ok(this.vadFile(), VAD.size);
  }

  status(id) {
    const m = modelInfo(id);
    const job = this.jobs.get(m.id);
    if (job) return { ...job.status };
    // Parado: conta o que já está no disco (download pausado continua daí)
    const have = (file, size) => { if (this._ok(file, size)) return size; try { return fs.statSync(file + '.part').size; } catch { return 0; } };
    const received = have(this.file(m.id), m.size) + have(this.vadFile(), VAD.size);
    return { id: m.id, label: m.label, ready: this.isReady(m.id), downloading: false, total: m.size + VAD.size, received };
  }

  // Modelos baixados (para mostrar "baixado" e liberar espaço)
  downloaded() {
    return Object.keys(MODELS).filter((id) => this._ok(this.file(id), MODELS[id].size));
  }

  ensure(id) {
    const m = modelInfo(id);
    if (this.isReady(m.id)) return Promise.resolve(this.file(m.id));
    if (this.jobs.has(m.id)) return this.jobs.get(m.id).promise;
    const controller = new AbortController();
    const status = { id: m.id, label: m.label, ready: false, downloading: true, total: m.size + VAD.size, received: 0, speed: 0, eta: null, error: null };
    const job = { controller, status };
    const emit = () => this.emit('progress', { ...status });
    job.promise = (async () => {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        // Espaço livre antes de começar (sobra de 200 MB para o resto do sistema)
        try {
          const st = fs.statfsSync(this.dir);
          const free = st.bavail * st.bsize;
          const need = m.size + VAD.size + 200e6;
          if (free < need) throw new DownloadError(`Espaço insuficiente para o modelo: precisa de ${fmtBytes(need)} livres e há ${fmtBytes(free)} em ${this.dir}.`, 'disk');
        } catch (e) { if (e instanceof DownloadError) throw e; }
        let base = 0;
        const parts = [
          { url: VAD.url, file: this.vadFile(), size: VAD.size, sha256: VAD.sha256 },
          { url: HF + m.file, file: this.file(m.id), size: m.size, sha256: m.sha256 },
        ];
        const t0 = Date.now();
        let resumedFrom = 0;
        for (const p of parts) {
          if (this._ok(p.file, p.size)) { base += p.size; status.received = base; continue; }
          // O detector de fala é comum a todos os modelos: um download só, mesmo com dois modelos baixando
          if (p.file === this.vadFile()) {
            this.vadJob ||= this._download(p, controller.signal, () => {}).finally(() => { this.vadJob = null; });
            await this.vadJob;
            base += p.size;
            continue;
          }
          await this._download(p, controller.signal, (got, startedAt) => {
            if (!resumedFrom && startedAt) resumedFrom = base + startedAt;
            status.received = base + got;
            const secs = (Date.now() - t0) / 1000;
            status.speed = secs > 0.5 ? (status.received - resumedFrom) / secs : 0;
            status.eta = status.speed > 0 ? Math.round((status.total - status.received) / status.speed) : null;
            emit();
          });
          base += p.size;
        }
        status.received = status.total;
        status.downloading = false;
        status.ready = true;
        emit();
        return this.file(m.id);
      } catch (e) {
        status.downloading = false;
        status.error = controller.signal.aborted ? 'cancelled' : e.message;
        emit();
        if (controller.signal.aborted) throw new DownloadError('Download do modelo cancelado.', 'cancelled');
        throw e;
      } finally {
        this.jobs.delete(m.id);
      }
    })();
    this.jobs.set(m.id, job);
    emit();
    return job.promise;
  }

  cancel(id) {
    const job = this.jobs.get(modelId(id));
    if (job) job.controller.abort();
    return !!job;
  }

  // Apaga os modelos que não são o escolhido (libera vários GB)
  removeOthers(keepId) {
    let freed = 0;
    for (const id of this.downloaded()) {
      if (id === modelId(keepId) || this.jobs.has(id)) continue;
      try { fs.unlinkSync(this.file(id)); freed += MODELS[id].size; } catch {}
    }
    return freed;
  }

  // Baixa para <arquivo>.part (continua de onde parou) e só renomeia depois de conferir o SHA-256
  async _download({ url, file, size, sha256 }, signal, onBytes) {
    const part = file + '.part';
    let start = 0;
    try { start = fs.statSync(part).size; } catch {}
    if (start > size) { fs.rmSync(part, { force: true }); start = 0; }
    const hash = crypto.createHash('sha256');
    if (start) {
      // Retomada: o que já foi baixado entra na conta do SHA-256
      for await (const c of fs.createReadStream(part)) hash.update(c);
    }
    if (start === size) { // baixou tudo, mas o app fechou antes de renomear
      if (hash.digest('hex') === sha256) { onBytes(size, start); fs.renameSync(part, file); return; }
      fs.rmSync(part, { force: true });
      return this._download({ url, file, size, sha256 }, signal, onBytes);
    }
    let res;
    try {
      res = await (this.fetch || netFetch())(url, { signal, headers: start ? { Range: `bytes=${start}-` } : {} });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new DownloadError('Sem conexão para baixar o modelo. Verifique a internet e tente de novo — o download continua de onde parou.', 'network');
    }
    if (start && res.status !== 206) { // servidor ignorou o Range: recomeça do zero
      try { await res.body?.cancel(); } catch {}
      fs.rmSync(part, { force: true });
      return this._download({ url, file, size, sha256 }, signal, onBytes);
    }
    if (!res.ok) throw new DownloadError(`O servidor do modelo respondeu ${res.status}. Tente de novo em alguns minutos.`, 'http');
    const ws = fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
    let got = start;
    let last = 0;
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        got += buf.length;
        if (!ws.write(buf)) await once(ws, 'drain');
        const now = Date.now();
        if (now - last > 250) { last = now; onBytes(got, start); }
      }
    } catch (e) {
      if (signal.aborted) throw e;
      throw new DownloadError('A conexão caiu durante o download do modelo. Tente de novo — ele continua de onde parou.', 'network');
    } finally {
      ws.end();
      await once(ws, 'close').catch(() => {});
    }
    onBytes(got, start);
    if (got !== size) throw new DownloadError(`Download incompleto (${fmtBytes(got)} de ${fmtBytes(size)}). Tente de novo.`, 'incomplete');
    const digest = hash.digest('hex');
    if (digest !== sha256) {
      fs.rmSync(part, { force: true });
      throw new DownloadError('O arquivo do modelo veio corrompido e foi descartado. Tente baixar de novo.', 'checksum');
    }
    fs.renameSync(part, file);
  }
}

module.exports = {
  MODELS, DEFAULT_MODEL, VAD, modelId, modelInfo, fmtBytes, binaryPath,
  argText, windowsAcp, buildArgs, parseSegmentLine, segmentsFromJson,
  ModelManager, DownloadError,
};
