// Servidor local (127.0.0.1) que recebe eventos da extensão do navegador (Teams/Meet):
// quem está falando, legendas com nome, participantes e estado da chamada.
const http = require('http');
const { EventEmitter } = require('events');

class Bridge extends EventEmitter {
  constructor(store, version) {
    super();
    this.store = store;
    this.version = version;
    this.server = null;
    this.state = this._empty();
    this.error = null;
    this.getRecording = () => false;
    setInterval(() => this._tick(), 3000);
    store.on('change', (c) => { if (c.bridgePort) this.restart(); });
  }

  _empty() {
    this.frames = new Map();
    return { connected: false, lastSeen: 0, platform: null, inCall: false, meetingTitle: null, speaking: [], participants: [], captionsActive: false, lastCaptionAt: 0, browser: null, eventsCount: 0 };
  }

  start() {
    const port = this.store.get('bridgePort');
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', (e) => {
      this.error = e.code === 'EADDRINUSE' ? `A porta ${port} já está em uso. Troque a porta em Configurações.` : e.message;
      this.emit('status', this.status());
    });
    this.server.listen(port, '127.0.0.1', () => { this.error = null; this.emit('status', this.status()); });
  }

  restart() {
    try { this.server?.close(); } catch {}
    this.start();
  }

  status() { return { ...this.state, error: this.error, port: this.store.get('bridgePort') }; }

  _tick() {
    const now = Date.now();
    const wasConnected = this.state.connected;
    this.state.connected = now - this.state.lastSeen < 12000;
    const captions = now - this.state.lastCaptionAt < 30000;
    if (this.state.connected && this._updateCall(null)) this.emit('status', this.status());
    if (!this.state.connected && this.state.inCall) {
      this.frames.clear(); this.state.inCall = false; this.state.speaking = [];
      this.emit('call', { inCall: false, platform: this.state.platform, title: this.state.meetingTitle });
      this.emit('status', this.status());
    }
    if (wasConnected !== this.state.connected || captions !== this.state.captionsActive) {
      this.state.captionsActive = captions;
      this.emit('status', this.status());
    }
  }

  _cors(req, res) {
    const origin = req.headers.origin || '';
    if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MeetRec-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    return origin;
  }

  _json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  _handle(req, res) {
    const origin = this._cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    // Só aceita chamadas de extensões (nunca de páginas web) e com o código de pareamento
    if (origin && !/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) return this._json(res, 403, { error: 'origem não permitida' });
    if ((req.headers['x-meetrec-token'] || '').toUpperCase() !== String(this.store.get('bridgeToken')).toUpperCase()) {
      return this._json(res, 401, { error: 'Código de pareamento inválido' });
    }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { return this._json(res, 400, { error: 'json inválido' }); }
      const url = req.url.split('?')[0];
      if (url === '/ping') {
        this._seen(data);
        return this._json(res, 200, { ok: true, app: 'MeetRec', version: this.version, recording: this.getRecording() });
      }
      if (url === '/events' && req.method === 'POST') {
        this._seen(data);
        this._ingest(data);
        return this._json(res, 200, { ok: true, recording: this.getRecording() });
      }
      if (url === '/command' && req.method === 'POST') {
        this._seen(data);
        this.emit('command', data);
        return this._json(res, 200, { ok: true });
      }
      this._json(res, 404, { error: 'não encontrado' });
    });
  }

  _seen(data) {
    const first = !this.state.connected;
    this.state.lastSeen = Date.now();
    this.state.connected = true;
    if (data.browser) this.state.browser = data.browser;
    // Versão da extensão instalada no navegador (as anteriores à 1.0.2 não enviam: ficam como "antiga")
    const ext = typeof data.ext === 'string' ? data.ext : 'antiga';
    if (ext !== this.state.extVersion) { this.state.extVersion = ext; if (!first) this.emit('status', this.status()); }
    if (first) this.emit('status', this.status());
  }

  // Estado da chamada somando todos os frames/abas que reportaram recentemente
  _updateCall(tab) {
    const now = Date.now();
    if (tab && tab.inCall !== undefined) {
      this.frames.set(tab.frame || 'default', { inCall: !!tab.inCall, platform: tab.platform, title: tab.title, at: now });
    }
    for (const [k, f] of this.frames) if (now - f.at > 10000) this.frames.delete(k);
    const active = [...this.frames.values()].filter((f) => f.inCall).sort((a, b) => b.at - a.at)[0];
    const st = this.state;
    let changed = false;
    const inCall = !!active;
    if (active?.platform && active.platform !== st.platform) { st.platform = active.platform; changed = true; }
    if (!active && tab?.platform && !st.platform) { st.platform = tab.platform; changed = true; }
    if (active?.title && active.title !== st.meetingTitle) { st.meetingTitle = active.title; changed = true; }
    if (inCall !== st.inCall) {
      st.inCall = inCall; changed = true;
      if (!inCall) st.speaking = [];
      this.emit('call', { inCall, platform: st.platform, title: st.meetingTitle });
    }
    return changed;
  }

  _ingest({ tab = {}, events = [] }) {
    const st = this.state;
    let changed = this._updateCall(tab);
    for (const ev of events) {
      st.eventsCount++;
      if (ev.type === 'participants' && Array.isArray(ev.names)) { st.participants = ev.names.slice(0, 200); changed = true; }
      if (ev.type === 'speaking') {
        const set = new Set(st.speaking);
        ev.on ? set.add(ev.speaker) : set.delete(ev.speaker);
        st.speaking = [...set];
        changed = true;
      }
      if (ev.type === 'caption') {
        st.lastCaptionAt = Date.now();
        if (ev.speaker && !st.speaking.includes(ev.speaker)) { st.lastCaptionSpeaker = ev.speaker; changed = true; }
        if (!st.captionsActive) { st.captionsActive = true; changed = true; }
      }
    }
    if (events.length) this.emit('events', { tab, events });
    if (changed) this.emit('status', this.status());
  }
}

module.exports = { Bridge };
