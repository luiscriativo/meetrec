// Biblioteca de gravações: uma pasta por reunião com meta.json, áudios, transcrição e resumo.
// As reuniões podem ficar na raiz ("Sem pasta") ou dentro de pastas criadas pelo usuário,
// cada uma com _contexto/ (pasta.json + CONTEXTO.md, GLOSSARIO.md e HISTORICO.md).
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { EventEmitter } = require('events');
const F = require('./folders');

const STEP_NAMES = ['audio', 'transcribe', 'speakers', 'summary'];

function pad(n) { return String(n).padStart(2, '0'); }

function newId(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function emptySteps() {
  const s = {};
  for (const n of STEP_NAMES) s[n] = { state: 'pending', progress: 0, message: '' };
  return s;
}

class Library extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.cache = new Map();
    this.folders = new Map(); // nome -> dados da pasta ('' = raiz, só glossário geral)
    this.root = store.get('storageDir');
    fs.mkdirSync(this.root, { recursive: true });
    this.load();
    store.on('change', (c) => {
      if (c.storageDir) {
        this.root = c.storageDir;
        fs.mkdirSync(this.root, { recursive: true });
        this.load();
        this.emit('changed', null);
      }
    });
  }

  load() {
    this.cache.clear();
    this.folders.clear();
    this.folders.set('', this._readFolder(''));
    const scan = (dir, folder) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === F.CTX_DIR || e.name.startsWith('.')) continue;
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'meta.json'), 'utf8')); } catch {}
        if (meta) {
          meta.id = e.name;
          meta.folder = folder;
          if (!this.cache.has(e.name)) this.cache.set(e.name, meta);
        } else if (!folder && !F.MEETING_DIR.test(e.name) && !e.name.startsWith('_')) {
          // Subpasta da raiz sem meta.json = pasta do usuário (só um nível)
          this.folders.set(e.name, this._readFolder(e.name));
          scan(path.join(dir, e.name), e.name);
        }
      }
    };
    scan(this.root, '');
  }

  dir(id) { return path.join(this.root, this.cache.get(id)?.folder || '', id); }
  file(id, name) { return path.join(this.dir(id), name); }
  folderOf(id) { return this.cache.get(id)?.folder || ''; }

  list() {
    return [...this.cache.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  get(id) { return this.cache.get(id) || null; }

  create(fields = {}) {
    const now = new Date();
    const folder = fields.folder && this.folders.has(fields.folder) ? fields.folder : '';
    const base = this.folderDir(folder);
    let id = newId(now);
    let i = 1;
    while (this.cache.has(id) || fs.existsSync(path.join(base, id))) id = `${newId(now)}-${i++}`;
    fs.mkdirSync(path.join(base, id), { recursive: true });
    const hh = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const meta = {
      id,
      title: `Reunião ${now.toLocaleDateString('pt-BR')} ${hh}`,
      titleAuto: true,
      createdAt: now.toISOString(),
      endedAt: null,
      duration: 0,
      status: 'recording',
      source: 'record',
      platform: null,
      tracks: { mic: false, system: false, mix: false },
      audioFile: null,
      markers: [],
      notes: '',
      participants: [],
      speakerNames: {},
      steps: emptySteps(),
      summary: null,
      actions: [],
      chat: [],
      warnings: [],
      error: null,
      ...fields,
      folder,
    };
    this._write(meta);
    return meta;
  }

  update(id, patch) {
    const meta = this.get(id);
    if (!meta) return null;
    const next = typeof patch === 'function' ? patch(meta) || meta : Object.assign(meta, patch);
    this._write(next);
    return next;
  }

  setStep(id, step, patch) {
    return this.update(id, (m) => {
      m.steps = m.steps || emptySteps();
      m.steps[step] = { ...(m.steps[step] || {}), ...patch };
      return m;
    });
  }

  resetSteps(id, from = 'audio') {
    return this.update(id, (m) => {
      const idx = STEP_NAMES.indexOf(from);
      m.steps = m.steps || emptySteps();
      STEP_NAMES.forEach((n, i) => { if (i >= idx) m.steps[n] = { state: 'pending', progress: 0, message: '' }; });
      m.error = null;
      return m;
    });
  }

  _write(meta) {
    this.cache.set(meta.id, meta);
    const f = this.file(meta.id, 'meta.json');
    const tmp = f + '.tmp';
    const { folder, ...disk } = meta; // a pasta é definida pelo local no disco
    fs.writeFileSync(tmp, JSON.stringify(disk, null, 2));
    fs.renameSync(tmp, f);
    this.emit('changed', meta);
  }

  readText(id, name) {
    try { return fs.readFileSync(this.file(id, name), 'utf8'); } catch { return null; }
  }

  readJson(id, name) {
    const t = this.readText(id, name);
    try { return t ? JSON.parse(t) : null; } catch { return null; }
  }

  writeText(id, name, text) { fs.writeFileSync(this.file(id, name), text); }
  writeJson(id, name, obj) { fs.writeFileSync(this.file(id, name), JSON.stringify(obj, null, 2)); }

  async remove(id) {
    const d = this.dir(id);
    // Um arquivo pode estar momentaneamente em uso (player, ffmpeg terminando): tenta algumas vezes
    let failed = true;
    for (let i = 0; i < 4 && failed; i++) {
      try { await shell.trashItem(d); failed = false; } catch { failed = fs.existsSync(d); }
      if (failed) await new Promise((r) => setTimeout(r, 400));
    }
    if (failed) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {
        if (fs.existsSync(path.join(d, 'meta.json'))) {
          throw new Error('Alguns arquivos desta reunião estão em uso. Feche o áudio dela e tente de novo.');
        }
      }
    }
    this.cache.delete(id);
    this.emit('changed', { id, removed: true });
  }

  // ───────── Pastas ─────────
  folderDir(name) { return path.join(this.root, name || ''); }
  ctxDir(name) { return path.join(this.folderDir(name), F.CTX_DIR); }

  _readFolder(name) {
    try { return F.normalizeFolderData(JSON.parse(fs.readFileSync(path.join(this.ctxDir(name), 'pasta.json'), 'utf8'))); } catch { return F.emptyFolderData(); }
  }

  _writeFolder(name, data) {
    const dir = this.ctxDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'pasta.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(f + '.tmp', f);
    // Espelhos legíveis (para você ou para o Claude Code abrirem direto na pasta)
    try {
      fs.writeFileSync(path.join(dir, 'GLOSSARIO.md'), F.renderGlossaryMd(name, data));
      if (name) {
        fs.writeFileSync(path.join(dir, 'CONTEXTO.md'), F.renderContextMd(name, data));
        fs.writeFileSync(path.join(dir, 'HISTORICO.md'), F.renderHistoryMd(name, data));
      }
    } catch { /* os .md são só espelho */ }
    this.folders.set(name, data);
    this.emit('folders', { name });
  }

  getFolder(name) { return this.folders.get(name || '') || null; }

  updateFolder(name, patch) {
    const cur = this.getFolder(name);
    if (!cur) throw new Error('Pasta não encontrada.');
    const next = typeof patch === 'function' ? patch({ ...cur }) || cur : { ...cur, ...patch };
    this._writeFolder(name || '', next);
    return next;
  }

  listFolders() {
    const counts = {};
    for (const m of this.cache.values()) counts[m.folder || ''] = (counts[m.folder || ''] || 0) + 1;
    return [...this.folders.entries()].filter(([n]) => n).map(([name, d]) => ({
      name,
      count: counts[name] || 0,
      description: d.description,
      hasContext: !F.contextIsEmpty(d.context),
      hasDraft: !!d.draft,
      glossary: d.glossary.length,
      hasHistory: !!d.history,
      size: F.folderSize(d).level,
      hasSlim: !!d.slim,
    })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  _folderExists(name) {
    return [...this.folders.keys()].some((n) => n && n.toLowerCase() === name.toLowerCase()) || fs.existsSync(this.folderDir(name));
  }

  createFolder(raw, description = '') {
    const { name, error } = F.sanitizeFolderName(raw);
    if (error) throw new Error(error);
    if (this._folderExists(name)) throw new Error(`Já existe uma pasta chamada "${name}".`);
    fs.mkdirSync(this.folderDir(name), { recursive: true });
    this._writeFolder(name, { ...F.emptyFolderData(), description: String(description || '').trim() });
    return name;
  }

  async renameFolder(oldName, raw) {
    if (!oldName || !this.folders.has(oldName)) throw new Error('Pasta não encontrada.');
    const { name, error } = F.sanitizeFolderName(raw);
    if (error) throw new Error(error);
    if (name === oldName) return name;
    if (name.toLowerCase() !== oldName.toLowerCase() && this._folderExists(name)) throw new Error(`Já existe uma pasta chamada "${name}".`);
    await renameRetry(this.folderDir(oldName), this.folderDir(name));
    const data = this.folders.get(oldName);
    this.folders.delete(oldName);
    for (const m of this.cache.values()) if (m.folder === oldName) m.folder = name;
    this._writeFolder(name, data); // atualiza os títulos dos .md
    this.emit('changed', null);
    return name;
  }

  // Exclui a pasta: as reuniões voltam para "Sem pasta" e o contexto vai para a lixeira
  async removeFolder(name) {
    if (!name || !this.folders.has(name)) throw new Error('Pasta não encontrada.');
    for (const m of [...this.cache.values()]) if (m.folder === name) await this.move(m.id, '');
    const d = this.folderDir(name);
    try { await shell.trashItem(d); } catch { fs.rmSync(d, { recursive: true, force: true }); }
    this.folders.delete(name);
    this.emit('folders', { name, removed: true });
    this.emit('changed', null);
  }

  async move(id, folder) {
    const meta = this.get(id);
    if (!meta) throw new Error('Reunião não encontrada.');
    folder = folder || '';
    if (folder && !this.folders.has(folder)) throw new Error('Pasta não encontrada.');
    if ((meta.folder || '') === folder) return meta;
    const to = path.join(this.folderDir(folder), id);
    if (fs.existsSync(to)) throw new Error('Já existe uma reunião com o mesmo identificador na pasta de destino.');
    await renameRetry(this.dir(id), to);
    meta.folder = folder;
    this.emit('changed', meta);
    return meta;
  }

  search(q) {
    q = (q || '').toLowerCase().trim();
    if (!q) return this.list().map((m) => m.id);
    const hits = [];
    for (const m of this.list()) {
      const hay = [m.title, m.notes, (m.participants || []).join(' ')].join(' ').toLowerCase();
      if (hay.includes(q)) { hits.push(m.id); continue; }
      const t = this.readText(m.id, 'transcript.txt') || '';
      const s = this.readText(m.id, 'summary.md') || '';
      if (t.toLowerCase().includes(q) || s.toLowerCase().includes(q)) hits.push(m.id);
    }
    return hits;
  }

  // Gravações que estavam "gravando" quando o app fechou/caiu
  recoverInterrupted() {
    const out = [];
    for (const m of this.list()) {
      if (m.status === 'recording' || m.status === 'paused') {
        this.update(m.id, { status: 'interrupted', warnings: [...(m.warnings || []), 'A gravação foi interrompida (o app fechou inesperadamente). O áudio salvo até o momento foi preservado.'] });
        out.push(m.id);
      } else if (m.status === 'processing') {
        this.update(m.id, { status: 'error', error: 'O processamento foi interrompido quando o app fechou. Clique em "Processar novamente".' });
      }
    }
    return out;
  }
}

// No Windows, renomear falha enquanto algum arquivo da pasta está aberto (player, antivírus, indexador)
async function renameRetry(from, to) {
  const busy = (e) => ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code);
  let last;
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      last = e;
      if (!busy(e)) break;
      await new Promise((r) => setTimeout(r, 300 + i * 200));
    }
  }
  throw new Error(busy(last)
    ? 'Algum arquivo está em uso (áudio tocando ou aberto em outro programa). Feche-o e tente de novo.'
    : `Não consegui mover: ${last?.message}`);
}

module.exports = { Library, STEP_NAMES };
