// Biblioteca de gravações: uma pasta por reunião com meta.json, áudios, transcrição e resumo.
// As reuniões podem ficar na raiz ("Sem pasta") ou dentro de pastas criadas pelo usuário,
// cada uma com _contexto/ (pasta.json + CONTEXTO.md, GLOSSARIO.md e HISTORICO.md).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline: streamPipeline } = require('stream/promises');
const { shell } = require('electron');
const { EventEmitter } = require('events');
const F = require('./folders');
const S = require('./sync');

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
  constructor(store, { workRoot } = {}) {
    super();
    this.store = store;
    // Pasta de trabalho local: com a biblioteca na nuvem (Drive em "streaming"), gravação e processamento
    // acontecem aqui e só o resultado final vai para o Drive
    this.workRoot = workRoot || path.join(os.tmpdir(), 'meetrec-trabalho');
    this.cache = new Map();
    this.folders = new Map(); // nome -> dados da pasta ('' = raiz, só glossário geral)
    this.machine = { id: store.get('machineId'), name: store.get('machineName') || S.machineName() };
    this.sigs = new Map();       // id -> assinatura (mtimes) dos arquivos da reunião, para notar mudanças vindas do outro PC
    this.folderSigs = new Map(); // nome -> mtime do pasta.json
    this.presenceSig = '';
    this.isLive = () => false;   // main.js: a reunião está sendo gravada/processada neste PC agora?
    this.myPresence = null;      // reunião aberta na tela deste PC
    this.syncState = { watching: false, lastRefresh: null, conflictsMerged: 0 };
    this.root = store.get('storageDir');
    fs.mkdirSync(this.root, { recursive: true });
    this.load();
    this._watch();
    store.on('change', (c) => {
      if (c.machineName !== undefined) this.machine.name = c.machineName || S.machineName();
      if (c.storageDir) {
        this.setPresence(null);
        this.root = c.storageDir;
        fs.mkdirSync(this.root, { recursive: true });
        this.load();
        this._watch();
        this.emit('changed', null);
        this.emit('folders', null);
      }
    });
    // Sinal de vida das reuniões deste PC + presença + varredura de segurança (o Drive nem sempre avisa mudanças)
    this.timers = [
      setInterval(() => this._heartbeat(), S.HEARTBEAT_MS),
      setInterval(() => this.refresh(), 20 * 1000),
    ];
  }

  // Lê a pasta inteira do zero
  load() {
    this.cache.clear();
    this.folders.clear();
    this.sigs.clear();
    this.folderSigs.clear();
    for (const { id, folder, dir } of this._scanDirs()) {
      if (this.cache.has(id)) continue;
      const meta = this._readMeta(dir, id, folder);
      if (meta) { this.cache.set(id, meta); this.sigs.set(id, this._sig(dir)); }
    }
  }

  // Lista as pastas de reunião no disco (e registra as pastas do usuário)
  _scanDirs() {
    const out = [];
    const seenFolders = new Set(['']);
    if (!this.folders.has('')) { this.folders.set('', this._readFolder('')); this.folderSigs.set('', this._folderSig('')); }
    const scan = (dir, folder) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === F.CTX_DIR || e.name.startsWith('.')) continue;
        // "2026-10-12_012542 (1)" = cópia de conflito do Drive: a original continua valendo
        if (S.isConflictMeetingDir(e.name, F.MEETING_DIR)) continue;
        const full = path.join(dir, e.name);
        if (fs.existsSync(path.join(full, 'meta.json'))) out.push({ id: e.name, folder, dir: full });
        else if (!folder && !F.MEETING_DIR.test(e.name) && !e.name.startsWith('_')) {
          // Subpasta da raiz sem meta.json = pasta do usuário (só um nível)
          seenFolders.add(e.name);
          if (!this.folders.has(e.name)) { this.folders.set(e.name, this._readFolder(e.name)); this.folderSigs.set(e.name, this._folderSig(e.name)); }
          scan(full, e.name);
        }
      }
    };
    scan(this.root, '');
    this._seenFolders = seenFolders;
    return out;
  }

  _readMeta(dir, id, folder) {
    this._mergeConflicts(dir);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
    meta.id = id;
    meta.folder = folder;
    return meta;
  }

  // O Drive cria "meta (1).json" quando os dois PCs salvam ao mesmo tempo: junta tudo no meta.json
  _mergeConflicts(dir) {
    let copies = [];
    try { copies = fs.readdirSync(dir).filter((n) => /^meta \(\d+\)\.json$/i.test(n)); } catch { return; }
    if (!copies.length) return;
    const f = path.join(dir, 'meta.json');
    let base = null;
    try { base = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    for (const c of copies) {
      let other = null;
      try { other = JSON.parse(fs.readFileSync(path.join(dir, c), 'utf8')); } catch {}
      if (other) {
        if (!base) base = other;
        else base = (other.updatedAt || '') > (base.updatedAt || '') ? S.mergeMeta(base, other) : S.mergeMeta(other, base);
      }
      // Guarda a cópia (oculta) em vez de apagar: dá para recuperar se a junção errar
      try { fs.renameSync(path.join(dir, c), path.join(dir, `.${c}.merged`)); } catch {}
    }
    if (base) {
      try { fs.writeFileSync(f + '.tmp', JSON.stringify(base, null, 2)); fs.renameSync(f + '.tmp', f); this.syncState.conflictsMerged++; } catch {}
    }
  }

  // Assinatura dos arquivos que o outro PC pode mudar (o Drive pode trazer cada um num momento diferente)
  _sig(dir) {
    const t = ['meta.json', 'summary.md', 'transcript.json'].map((n) => { try { return fs.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } });
    if (fs.existsSync(path.join(dir, 'meta (1).json'))) t.push('conflito'); // cópia do Drive esperando ser juntada
    return t.join('|');
  }

  _folderSig(name) {
    try { return fs.statSync(path.join(this.ctxDir(name), 'pasta.json')).mtimeMs; } catch { return 0; }
  }

  _touch(id) { this.sigs.set(id, this._sig(this.dir(id))); }

  // Relê o que mudou no disco (vindo do outro PC). Barato: só stat + leitura do que mudou.
  refresh() {
    if (this._refreshing || this.syncPaused) return;
    this._refreshing = true;
    try {
      const found = this._scanDirs();
      const seen = new Set();
      const changed = [];
      for (const { id, folder, dir } of found) {
        if (seen.has(id)) continue;
        seen.add(id);
        const sig = this._sig(dir);
        const cur = this.cache.get(id);
        if (cur && this.sigs.get(id) === sig && (cur.folder || '') === folder) continue;
        const meta = this._readMeta(dir, id, folder);
        if (!meta) continue;
        this.cache.set(id, meta);
        this.sigs.set(id, this._sig(dir));
        changed.push(meta);
      }
      const removed = [...this.cache.keys()].filter((id) => !seen.has(id));
      for (const id of removed) { this.cache.delete(id); this.sigs.delete(id); }

      let foldersChanged = false;
      for (const name of [...this.folders.keys()]) {
        if (!this._seenFolders.has(name)) { this.folders.delete(name); this.folderSigs.delete(name); foldersChanged = true; continue; }
        const sig = this._folderSig(name);
        if (sig !== this.folderSigs.get(name)) { this.folders.set(name, this._readFolder(name)); this.folderSigs.set(name, sig); foldersChanged = true; }
      }

      for (const m of changed) this.emit('changed', m);
      for (const id of removed) this.emit('changed', { id, removed: true });
      if (foldersChanged) { this.emit('folders', null); if (!changed.length && !removed.length) this.emit('changed', null); }
      this._checkPresence();
      this.syncState.lastRefresh = Date.now();
    } finally { this._refreshing = false; }
  }

  // Avisos imediatos do sistema de arquivos (no Drive virtual podem não vir: a varredura periódica cobre)
  _watch() {
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
    this.syncState.watching = false;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, file) => {
        if (file && S.isJunk(file)) return;
        clearTimeout(this._watchT);
        this._watchT = setTimeout(() => this.refresh(), 700);
      });
      this.watcher.on('error', () => { this.syncState.watching = false; });
      this.syncState.watching = true;
    } catch { /* sem watch: fica só a varredura periódica */ }
  }

  close() {
    this.timers.forEach(clearInterval);
    try { this.watcher?.close(); } catch {}
    this.setPresence(null);
  }

  // ───────── Pasta de trabalho local (biblioteca na nuvem) ─────────
  isCloud() { return !!S.cloudKind(this.root); }

  // Onde gravar/processar os arquivos pesados desta reunião
  workDir(id) { return this.isCloud() ? path.join(this.workRoot, id) : this.dir(id); }
  workFile(id, name) { return path.join(this.workDir(id), name); }

  // Garante uma cópia local do arquivo (no Drive em streaming, isso baixa o áudio) e devolve o caminho
  async toLocal(id, name, onProgress) {
    const src = this.file(id, name);
    if (!this.isCloud()) return src;
    const dst = this.workFile(id, name);
    let size = 0;
    try { size = fs.statSync(src).size; } catch { return fs.existsSync(dst) ? dst : src; }
    try { if (fs.statSync(dst).size === size) return dst; } catch {}
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    let done = 0;
    const rs = fs.createReadStream(src, { highWaterMark: 1 << 20 });
    rs.on('data', (c) => { done += c.length; onProgress?.(size ? done / size : 0); });
    await streamPipeline(rs, fs.createWriteStream(dst + '.part'));
    fs.renameSync(dst + '.part', dst);
    return dst;
  }

  // Manda o arquivo pronto da pasta de trabalho para a biblioteca (o Drive sobe sozinho)
  publish(id, name) {
    if (!this.isCloud()) return;
    const src = this.workFile(id, name);
    if (!fs.existsSync(src)) return;
    const dst = this.file(id, name);
    fs.copyFileSync(src, dst + '.tmp');
    fs.renameSync(dst + '.tmp', dst);
  }

  // Leva para a biblioteca o que ficou na pasta de trabalho (ex.: gravação interrompida) e limpa
  flushWork(id, { keep = false } = {}) {
    if (!this.isCloud()) return [];
    const dir = path.join(this.workRoot, id);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /\.(webm|jsonl)$/i.test(n) && !/\.(fixed|16k)\./.test(n)); } catch { return []; }
    const moved = [];
    for (const n of names) {
      const dst = this.file(id, n);
      let same = false;
      try { same = fs.statSync(dst).size === fs.statSync(path.join(dir, n)).size; } catch {}
      if (!same && this.get(id)) { try { this.publish(id, n); moved.push(n); } catch {} }
    }
    if (!keep) this.clearWork(id);
    return moved;
  }

  // Ao abrir o app: apaga pastas de trabalho que sobraram (o que importava já foi para a biblioteca)
  cleanWork() {
    let names = [];
    try { names = fs.readdirSync(this.workRoot); } catch { return; }
    for (const n of names) {
      const m = this.get(n);
      if (m && S.isActive(m) && S.ownedHere(m, this.machine.id)) continue;
      if (m) this.flushWork(n); else { try { fs.rmSync(path.join(this.workRoot, n), { recursive: true, force: true }); } catch {} }
    }
  }

  clearWork(id) {
    if (!this.isCloud()) return;
    try { fs.rmSync(path.join(this.workRoot, id), { recursive: true, force: true }); } catch {}
  }

  // ───────── Entre computadores ─────────
  // Quem está gravando/processando esta reunião em outro PC (null = ninguém ou este PC)
  ownerOf(id) { return S.remoteOwner(this.get(id), this.machine.id); }

  _heartbeat() {
    for (const m of [...this.cache.values()]) {
      if (S.isActive(m) && m.busyBy?.id === this.machine.id && this.isLive(m.id)) this.update(m.id, {});
    }
    if (this.myPresence) this.setPresence(this.myPresence);
  }

  // Libera uma reunião que ficou travada no outro PC (ele desligou no meio)
  release(id) {
    const m = this.get(id);
    if (!m || !S.isActive(m)) return m;
    const who = m.busyBy?.name || 'outro computador';
    if (m.status === 'processing') return this.update(id, { status: 'error', error: `O processamento no ${who} parou no meio. Clique em "Tentar novamente" para processar neste computador.` });
    return this.update(id, { status: 'interrupted', warnings: [...(m.warnings || []), `A gravação no ${who} foi interrompida. O áudio que chegou pelo Drive foi preservado.`] });
  }

  _presenceDir() { return path.join(this.root, S.SYNC_DIR); }

  // Marca "esta reunião está aberta neste PC" (null = nenhuma)
  setPresence(meetingId) {
    this.myPresence = meetingId || null;
    const f = path.join(this._presenceDir(), `presence-${this.machine.id}.json`);
    try {
      if (!meetingId) { fs.rmSync(f, { force: true }); return; }
      fs.mkdirSync(this._presenceDir(), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ id: this.machine.id, name: this.machine.name, meeting: meetingId, at: new Date().toISOString() }));
    } catch {}
  }

  // Outros PCs com esta reunião aberta agora
  openElsewhere(meetingId) {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(this._presenceDir()).filter((n) => /^presence-.+\.json$/.test(n)); } catch { return out; }
    for (const n of files) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(this._presenceDir(), n), 'utf8'));
        if (p.id === this.machine.id || p.meeting !== meetingId) continue;
        if (Date.now() - (Date.parse(p.at) || 0) > S.PRESENCE_MS) continue;
        out.push({ name: p.name });
      } catch {}
    }
    return out;
  }

  _checkPresence() {
    let sig = '';
    try { sig = fs.readdirSync(this._presenceDir()).map((n) => { try { return n + fs.statSync(path.join(this._presenceDir(), n)).mtimeMs; } catch { return n; } }).join(','); } catch {}
    if (sig !== this.presenceSig) { this.presenceSig = sig; this.emit('presence'); }
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
    let meta = this.get(id);
    if (!meta) return null;
    // O outro PC pode ter salvo esta reunião desde a última leitura: parte da versão do disco
    const d = this.dir(id);
    if (this.sigs.has(id) && this.sigs.get(id) !== this._sig(d)) {
      const fresh = this._readMeta(d, id, meta.folder || '');
      if (fresh) { meta = fresh; this.cache.set(id, meta); }
    }
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
    // Dono da gravação/processamento: o PC que colocou a reunião nesse estado. Os outros só editam por cima.
    if (S.isActive(meta)) {
      if (!meta.busyBy || meta.busyBy.id === this.machine.id || meta._takeOver) {
        meta.busyBy = { id: this.machine.id, name: this.machine.name };
        meta.busyAt = new Date().toISOString();
      }
    } else { delete meta.busyBy; delete meta.busyAt; }
    delete meta._takeOver;
    meta.updatedAt = new Date().toISOString();
    meta.updatedBy = this.machine.name;
    this.cache.set(meta.id, meta);
    const f = this.file(meta.id, 'meta.json');
    const tmp = f + '.tmp';
    const { folder, ...disk } = meta; // a pasta é definida pelo local no disco
    fs.writeFileSync(tmp, JSON.stringify(disk, null, 2));
    fs.renameSync(tmp, f);
    this._touch(meta.id);
    this.emit('changed', meta);
  }

  readText(id, name) {
    try { return fs.readFileSync(this.file(id, name), 'utf8'); } catch { return null; }
  }

  readJson(id, name) {
    const t = this.readText(id, name);
    try { return t ? JSON.parse(t) : null; } catch { return null; }
  }

  writeText(id, name, text) { fs.writeFileSync(this.file(id, name), text); this._touch(id); }
  writeJson(id, name, obj) { fs.writeFileSync(this.file(id, name), JSON.stringify(obj, null, 2)); this._touch(id); }

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
    this.sigs.delete(id);
    this.clearWork(id);
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
    this.folderSigs.set(name, this._folderSig(name));
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
    this.folderSigs.delete(oldName);
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
    this.folderSigs.delete(name);
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
    this._touch(id);
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
      if (!S.ownedHere(m, this.machine.id)) continue; // ativa em outro PC: não é deste para recuperar
      if (m.status === 'recording' || m.status === 'paused') {
        this.flushWork(m.id); // o áudio estava na pasta de trabalho local: leva para a biblioteca
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
