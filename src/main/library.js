// Biblioteca de gravações: uma pasta por reunião com meta.json, áudios, transcrição e resumo.
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { EventEmitter } = require('events');

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
    let entries = [];
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(this.root, e.name, 'meta.json');
      try {
        const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
        meta.id = e.name;
        this.cache.set(e.name, meta);
      } catch { /* pasta sem meta: ignora */ }
    }
  }

  dir(id) { return path.join(this.root, id); }
  file(id, name) { return path.join(this.root, id, name); }

  list() {
    return [...this.cache.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  get(id) { return this.cache.get(id) || null; }

  create(fields = {}) {
    const now = new Date();
    let id = newId(now);
    let i = 1;
    while (fs.existsSync(this.dir(id))) id = `${newId(now)}-${i++}`;
    fs.mkdirSync(this.dir(id), { recursive: true });
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
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
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

module.exports = { Library, STEP_NAMES };
