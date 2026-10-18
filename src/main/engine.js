// Motor de transcrição local: Python + faster-whisper (o mesmo de sempre).
// Usa o Python que já tem o faster-whisper (ex.: instalado à mão) ou, se não houver, instala um
// Python só do MeetRec em <userData>/engine com o uv — sem mexer no Python do sistema nem no PATH.
// Também baixa os modelos com progresso (python/transcribe.py --download-only).
// Sem dependência obrigatória do Electron: as partes puras são testadas com node --test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { run, findPython, isWin } = require('./tools');

// uv: instalador de Python da Astral. Versão fixa, conferida por SHA-256 antes de executar.
const UV_VERSION = '0.12.20';
const UV_ASSETS = {
  'win32-x64': { file: 'uv-x86_64-pc-windows-msvc.zip', sha256: '95f9bc30fbb3574d276e28ac4a6de932d25153645853d13da8c21eec3bc88d06' },
  'darwin-arm64': { file: 'uv-aarch64-apple-darwin.tar.gz', sha256: '848fdeb602ff1a1baacd4f6c8b7bdc6cf1ad026a6d9cf59475fda17c179743ca' },
  'darwin-x64': { file: 'uv-x86_64-apple-darwin.tar.gz', sha256: 'ac54283d211fd77cdc152b67606dbaf6406ff4ab03f3af4ae99468fa8e887141' },
  'linux-x64': { file: 'uv-x86_64-unknown-linux-gnu.tar.gz', sha256: '6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f' },
  'linux-arm64': { file: 'uv-aarch64-unknown-linux-gnu.tar.gz', sha256: '8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e' },
};
UV_ASSETS['win32-arm64'] = UV_ASSETS['win32-x64']; // roda pela emulação, como o próprio app

const PYTHON_VERSION = '3.11';
// Mesmas versões que já rodam hoje (conferido: transcrição idêntica, byte a byte).
// Se o sistema não tiver alguma peça secundária nessa versão (ex.: onnxruntime no Mac Intel),
// mantém travadas as peças que transcrevem e deixa as outras escolherem a compatível.
const PACKAGES_EXACT = ['faster-whisper==1.2.1', 'ctranslate2==4.8.2', 'onnxruntime==1.27.0', 'av==18.1.0', 'tokenizers==0.23.3', 'numpy==2.4.3'];
const PACKAGES_CORE = ['faster-whisper==1.2.1', 'ctranslate2==4.8.2', 'tokenizers==0.23.3'];

// Modelos oferecidos (ids e repositórios do faster-whisper)
const MODELS = {
  tiny: { repo: 'Systran/faster-whisper-tiny', label: 'Tiny', desc: 'Muito rápido, menos preciso', size: 75e6 },
  base: { repo: 'Systran/faster-whisper-base', label: 'Base', desc: 'Rápido', size: 148e6 },
  small: { repo: 'Systran/faster-whisper-small', label: 'Small', desc: 'Equilíbrio', size: 484e6 },
  medium: { repo: 'Systran/faster-whisper-medium', label: 'Medium', desc: 'Mais preciso, mais lento', size: 1.53e9 },
  'large-v3-turbo': { repo: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo', label: 'Large v3 Turbo', desc: 'Ótima precisão', size: 1.62e9, recommended: true },
  'large-v3': { repo: 'Systran/faster-whisper-large-v3', label: 'Large v3', desc: 'Máxima precisão, bem lento em CPU', size: 3.09e9 },
};
const DEFAULT_MODEL = 'large-v3-turbo';
const modelId = (id) => (MODELS[id] ? id : DEFAULT_MODEL);

function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} GB`;
  return `${Math.round((n || 0) / 1e6)} MB`;
}

// Pasta de cache do Hugging Face, como o huggingface_hub a calcula
function hfCacheDir(env = process.env, home = os.homedir()) {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return path.join(env.HF_HOME, 'hub');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'huggingface', 'hub');
}

function modelCached(id, cacheDir = hfCacheDir()) {
  const snaps = path.join(cacheDir, `models--${MODELS[modelId(id)].repo.replace('/', '--')}`, 'snapshots');
  try { return fs.readdirSync(snaps).some((s) => fs.existsSync(path.join(snaps, s, 'model.bin'))); } catch { return false; }
}

function uvAsset(platform = process.platform, arch = process.arch) {
  return UV_ASSETS[`${platform}-${arch}`] || null;
}

// Mensagens amigáveis para falhas da instalação
function installErrorMessage(log) {
  const t = String(log || '').toLowerCase();
  if (/dns|resolve|connect|timed out|network|tls|certificate|ssl|econnreset|enotfound/.test(t))
    return 'Sem conexão com a internet (ou a rede bloqueou o download). Verifique a conexão e tente de novo.';
  if (/no space|espaço|disk full|enospc/.test(t)) return 'Sem espaço em disco para instalar o motor (precisa de ~400 MB livres).';
  if (/access is denied|permission denied|acesso negado|eacces|eperm/.test(t)) return 'Sem permissão para gravar na pasta do MeetRec. Tente de novo; se continuar, reinicie o computador.';
  return 'A instalação do motor de transcrição falhou. Veja os detalhes e tente de novo.';
}

function netFetch() {
  try { const { net } = require('electron'); if (net?.fetch) return net.fetch.bind(net); } catch { /* fora do Electron */ }
  return fetch;
}

class Engine extends EventEmitter {
  /** root: pasta do motor do app (<userData>/engine). script: python/transcribe.py */
  constructor(root, { script, fetchImpl } = {}) {
    super();
    this.root = root;
    this.script = script;
    this.fetch = fetchImpl || null;
    this.found = undefined; // cache do find()
    this.state = { phase: 'idle' }; // idle | installing | error
    this.log = '';
    this.child = null;
    this.installJob = null;
    this.models = new Map(); // id → { promise, child, status }
  }

  get venvPython() { return path.join(this.root, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python'); }
  get uvBin() { return path.join(this.root, 'uv', isWin ? 'uv.exe' : 'uv'); }

  _env() {
    return {
      UV_PYTHON_INSTALL_DIR: path.join(this.root, 'python'),
      UV_CACHE_DIR: path.join(this.root, 'cache'),
      UV_NO_CONFIG: '1',
      UV_PYTHON_PREFERENCE: 'only-managed', // nunca usa (nem altera) o Python do sistema
      UV_PYTHON_DOWNLOADS: 'automatic',
      UV_NO_PROGRESS: '1',
      NO_COLOR: '1',
    };
  }

  // Confere se um Python tem o faster-whisper; devolve versões ou null
  async _probe(cmd) {
    const code = 'import sys, faster_whisper; print(sys.executable); print(sys.version.split()[0]); print(faster_whisper.__version__)';
    const r = await run(cmd, ['-c', code], { timeout: 30000, env: { PYTHONIOENCODING: 'utf-8' } });
    const l = (r.out || '').trim().split(/\r?\n/);
    if (r.code !== 0 || l.length < 3) return null;
    return { cmd, version: `Python ${l[1]}`, fw: l[2] };
  }

  /**
   * O Python que vai transcrever. Ordem: o caminho escolhido em Configurações → o Python do app
   * → o Python do sistema que já tem o faster-whisper (quem instalou à mão continua igual).
   */
  async find(settings = {}, { fresh = false } = {}) {
    if (!fresh && this.found !== undefined && this.found?.custom === (settings.pythonPath || '')) return this.found;
    let res = null;
    if (settings.pythonPath) {
      const p = await this._probe(settings.pythonPath);
      if (p) res = { ...p, source: 'custom' };
    }
    if (!res && fs.existsSync(this.venvPython)) {
      const p = await this._probe(this.venvPython);
      if (p) res = { ...p, source: 'app' };
    }
    if (!res) {
      const sys = await findPython();
      if (sys) {
        const p = await this._probe(sys.cmd);
        if (p) res = { ...p, source: 'system' };
      }
    }
    this.found = res ? { ...res, custom: settings.pythonPath || '' } : null;
    return this.found;
  }

  forget() { this.found = undefined; }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', { ...this.state, log: this.log.slice(-6000) });
  }

  _log(t) {
    this.log = (this.log + String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')).slice(-20000);
    this.emit('state', { ...this.state, log: this.log.slice(-6000) });
  }

  busy() { return this.state.phase === 'installing'; }

  /** Instala Python + faster-whisper na pasta do app. Pedidos repetidos usam a mesma instalação. */
  install() {
    if (this.installJob) return this.installJob;
    this.installJob = this._install().finally(() => { this.installJob = null; });
    return this.installJob;
  }

  async _install() {
    const asset = uvAsset();
    if (!asset) throw new Error(`Instalação automática indisponível para ${process.platform}-${process.arch}. Use a OpenAI em Configurações → Transcrição.`);
    this.log = '';
    this.cancelled = false;
    const steps = 3;
    const step = (n, message) => this._set({ phase: 'installing', step: n, steps, message, startedAt: this.state.startedAt || Date.now(), error: null });
    this.state = { phase: 'installing', startedAt: Date.now() };
    try {
      fs.mkdirSync(this.root, { recursive: true });
      try {
        const st = fs.statfsSync(this.root);
        if (st.bavail * st.bsize < 600e6) throw Object.assign(new Error('Sem espaço em disco para instalar o motor (precisa de ~600 MB livres).'), { friendly: true });
      } catch (e) { if (e.friendly) throw e; }

      // 1) uv
      if (!fs.existsSync(this.uvBin)) {
        step(1, 'Baixando o instalador…');
        await this._fetchUv(asset);
      }
      this._check();
      // 2) Python só do app
      step(2, 'Instalando o Python do MeetRec…');
      fs.rmSync(path.join(this.root, 'venv'), { recursive: true, force: true });
      await this._uv(['venv', path.join(this.root, 'venv'), '--python', PYTHON_VERSION]);
      this._check();
      // 3) faster-whisper nas mesmas versões de sempre
      step(3, 'Instalando o motor de transcrição…');
      try {
        await this._uv(['pip', 'install', '--python', this.venvPython, ...PACKAGES_EXACT]);
      } catch (e) {
        this._check();
        this._log('\nAlgumas peças não existem nessas versões para este sistema; mantendo as que transcrevem e ajustando o resto…\n');
        await this._uv(['pip', 'install', '--python', this.venvPython, ...PACKAGES_CORE]);
      }
      this._check();
      this.forget();
      const p = await this._probe(this.venvPython);
      if (!p) throw new Error('O motor foi instalado, mas não abriu. Veja os detalhes e tente de novo.');
      this._log(`\n✓ ${p.version} · faster-whisper ${p.fw}\n`);
      this._set({ phase: 'idle', step: null, message: `Motor instalado (${p.version} · faster-whisper ${p.fw}).`, startedAt: null, error: null });
      return p;
    } catch (e) {
      const msg = this.cancelled ? 'Instalação cancelada.' : (e.friendly ? e.message : installErrorMessage(this.log + ' ' + e.message));
      this._set({ phase: this.cancelled ? 'idle' : 'error', step: null, message: msg, error: this.cancelled ? null : msg, startedAt: null });
      throw Object.assign(new Error(msg), { code: this.cancelled ? 'cancelled' : 'install' });
    } finally {
      this.child = null;
    }
  }

  _check() { if (this.cancelled) throw new Error('cancelado'); }

  async _uv(args) {
    this._log(`> uv ${args.map((a) => (a.includes(this.root) ? path.basename(a) : a)).join(' ')}\n`);
    const r = await run(this.uvBin, args, {
      env: this._env(), timeout: 20 * 60e3,
      onSpawn: (c) => { this.child = c; },
      onStdout: (d) => this._log(d), onStderr: (d) => this._log(d),
    });
    this.child = null;
    if (r.code !== 0) throw new Error(`uv terminou com código ${r.code}`);
  }

  async _fetchUv(asset) {
    const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.file}`;
    this._log(`Baixando ${asset.file} (uv ${UV_VERSION})…\n`);
    let buf;
    try {
      const res = await (this.fetch || netFetch())(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw Object.assign(new Error(`network: ${e.message}`), { friendly: false });
    }
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== asset.sha256) throw Object.assign(new Error('O instalador baixado não confere (SHA-256). Tente de novo.'), { friendly: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meetrec-uv-'));
    try {
      const archive = path.join(tmp, asset.file);
      fs.writeFileSync(archive, buf);
      // O tar do Windows 10+ abre .zip; pelo caminho completo (outro "tar" no PATH pode não abrir)
      const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const r = await run(tar, ['-xf', archive, '-C', tmp], { timeout: 120000 });
      if (r.code !== 0) throw new Error(`Não consegui extrair o instalador: ${r.err.slice(-200)}`);
      const name = isWin ? 'uv.exe' : 'uv';
      const found = [path.join(tmp, name), path.join(tmp, asset.file.replace(/\.(zip|tar\.gz)$/, ''), name)].find((p) => fs.existsSync(p));
      if (!found) throw new Error('O instalador baixado veio incompleto.');
      fs.mkdirSync(path.dirname(this.uvBin), { recursive: true });
      fs.copyFileSync(found, this.uvBin);
      if (!isWin) fs.chmodSync(this.uvBin, 0o755);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  cancel() {
    if (!this.busy()) return false;
    this.cancelled = true;
    try { this.child?.kill(); } catch {}
    return true;
  }

  // ─────────── Modelos ───────────
  modelStatus(id) {
    const m = modelId(id);
    const job = this.models.get(m);
    if (job) return { ...job.status };
    return { id: m, label: MODELS[m].label, ready: modelCached(m), downloading: false, received: 0, total: MODELS[m].size };
  }

  /** Baixa o modelo com o Python indicado (padrão: o encontrado). Pedidos repetidos usam o mesmo download. */
  ensureModel(id, py) {
    const m = modelId(id);
    if (modelCached(m)) return Promise.resolve(true);
    if (this.models.has(m)) return this.models.get(m).promise;
    const status = { id: m, label: MODELS[m].label, ready: false, downloading: true, received: 0, total: MODELS[m].size, speed: 0, eta: null, error: null };
    const job = { status, child: null, cancelled: false };
    const emit = () => this.emit('model-progress', { ...status });
    let first = null;
    job.promise = (async () => {
      try {
        const python = py || (await this.find())?.cmd;
        if (!python) throw Object.assign(new Error('O motor de transcrição ainda não está instalado.'), { code: 'no-engine' });
        let buf = '', lastErr = '';
        const r = await run(python, ['-u', this.script, '--download-only', '--model', m], {
          env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          onSpawn: (c) => { job.child = c; },
          onStdout: (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              let ev; try { ev = JSON.parse(line); } catch { continue; }
              if (ev.type === 'download') {
                if (ev.total) status.total = ev.total;
                status.received = Math.min(ev.received, status.total);
                if (first == null) first = { t: Date.now(), got: status.received }; // o que já estava no disco não conta na velocidade
                const secs = (Date.now() - first.t) / 1000;
                status.speed = secs > 1 ? (status.received - first.got) / secs : 0;
                status.eta = status.speed > 0 ? Math.round((status.total - status.received) / status.speed) : null;
                emit();
              } else if (ev.type === 'error') lastErr = ev.message;
            }
          },
        });
        if (job.cancelled) throw Object.assign(new Error('Download do modelo pausado.'), { code: 'cancelled' });
        if (r.code !== 0 || !modelCached(m)) {
          const t = (lastErr + r.err).toLowerCase();
          throw Object.assign(new Error(/connect|resolve|timed out|network|ssl|offline/.test(t)
            ? 'Sem conexão para baixar o modelo. Verifique a internet e tente de novo — ele continua de onde parou.'
            : `Falha ao baixar o modelo: ${(lastErr || r.err).slice(-200)}`), { code: 'download' });
        }
        Object.assign(status, { downloading: false, ready: true, received: status.total });
        emit();
        return true;
      } catch (e) {
        Object.assign(status, { downloading: false, error: e.code === 'cancelled' ? 'cancelled' : e.message });
        emit();
        throw e;
      } finally {
        this.models.delete(m);
      }
    })();
    this.models.set(m, job);
    emit();
    return job.promise;
  }

  cancelModel(id) {
    const job = this.models.get(modelId(id));
    if (!job) return false;
    job.cancelled = true;
    try { job.child?.kill(); } catch {}
    return true;
  }
}

module.exports = {
  Engine, MODELS, DEFAULT_MODEL, modelId, modelCached, hfCacheDir, uvAsset, installErrorMessage, fmtBytes,
  UV_VERSION, UV_ASSETS, PACKAGES_EXACT, PACKAGES_CORE, PYTHON_VERSION,
};
