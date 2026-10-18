// Configurações persistentes em JSON. Chaves de API são criptografadas com safeStorage.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SECRET_KEYS = ['openaiKey'];

function defaults() {
  return {
    userName: '',
    language: 'pt',
    storageDir: path.join(app.getPath('documents'), 'MeetRec - Reuniões'),
    machineId: crypto.randomBytes(6).toString('hex'), // identifica este PC na pasta sincronizada
    machineName: '', // '' = nome do computador

    micDeviceId: 'default',
    captureSystem: true,
    systemDeviceId: '', // Linux: dispositivo "Monitor of ..." como fonte do áudio do sistema
    echoCancellation: true,
    noiseSuppression: true,

    showOverlay: true,
    hideOverlayInShare: true,
    overlayPosition: null,
    sounds: true,
    notifications: true,

    autoProcess: true,
    engine: 'local', // local | openai
    localModel: 'large-v3-turbo', // padrão de instalações novas (quem já usa mantém o seu)
    pythonPath: '',
    openaiKey: '',
    vocabulary: '',

    aiEngine: 'claude', // motor do resumo: claude | codex
    claudePath: '',
    claudeModel: '',
    useSkill: true,
    customInstructions: '',
    codexPath: '',
    codexModel: '',
    codexEffort: '', // '' = padrão do Codex | low | medium | high
    recordFolder: '', // pasta onde novas gravações e importações são salvas ('' = Sem pasta)

    detectMeetings: true,
    autoStopSuggest: true,

    bridgePort: 47321,
    bridgeToken: crypto.randomBytes(4).toString('hex').toUpperCase(),

    launchAtLogin: false,
    startHidden: false,
    shortcutToggle: 'CommandOrControl+Shift+R',
    shortcutMarker: 'CommandOrControl+Shift+M',
    theme: 'system',
    onboarded: false,
  };
}

class Store extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const k of SECRET_KEYS) raw[k] = this._decrypt(raw[k]);
      // O Groq saiu do app: quem usava passa para a transcrição local
      if (raw.engine === 'groq') raw.engine = 'local';
      delete raw.groqKey;
      this.data = { ...this.data, ...raw };
    } catch { /* primeira execução */ }
    this.save();
  }

  _encrypt(v) {
    if (!v) return '';
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(v).toString('base64');
    return v;
  }

  _decrypt(v) {
    if (!v || typeof v !== 'string') return '';
    if (v.startsWith('enc:')) {
      try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return ''; }
    }
    return v;
  }

  get(k) { return k ? this.data[k] : { ...this.data }; }

  set(patch) {
    const changed = {};
    for (const [k, v] of Object.entries(patch)) {
      if (JSON.stringify(this.data[k]) !== JSON.stringify(v)) { this.data[k] = v; changed[k] = v; }
    }
    this.save();
    if (Object.keys(changed).length) this.emit('change', changed);
    return this.get();
  }

  save() {
    const out = { ...this.data };
    for (const k of SECRET_KEYS) out[k] = this._encrypt(out[k]);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
  }
}

module.exports = { Store };
