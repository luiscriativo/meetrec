// Detecta quando um app de reunião começa/para de usar o microfone.
// Windows: registro CapabilityAccessManager. Linux: pactl. macOS: depende da extensão do navegador.
const { EventEmitter } = require('events');
const path = require('path');
const { run } = require('./tools');

const KNOWN = [
  [/teams/i, 'Microsoft Teams'],
  [/zoom/i, 'Zoom'],
  [/webex|ciscocollab/i, 'Webex'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/skype/i, 'Skype'],
  [/whatsapp/i, 'WhatsApp'],
  [/chrome/i, 'Google Chrome'],
  [/msedge|edge/i, 'Microsoft Edge'],
  [/firefox/i, 'Firefox'],
  [/brave/i, 'Brave'],
  [/opera/i, 'Opera'],
  [/vivaldi/i, 'Vivaldi'],
  [/[#\\/]arc\.exe$|thebrowsercompany/i, 'Arc'],
];

function friendly(key) {
  for (const [re, name] of KNOWN) if (re.test(key)) return name;
  return null;
}

class MeetingDetector extends EventEmitter {
  constructor() {
    super();
    this.apps = [];
    this.timer = null;
    this.supported = process.platform === 'win32' || process.platform === 'linux';
    const exe = path.basename(process.execPath).toLowerCase();
    this.selfPatterns = [exe, 'meetrec', 'electron.exe'];
  }

  start() {
    if (!this.supported || this.timer) return;
    this.timer = setInterval(() => this.poll(), 4000);
    this.poll();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  async poll() {
    let apps = [];
    try {
      apps = process.platform === 'win32' ? await this._windows() : await this._linux();
    } catch { return; }
    apps = apps.filter((a) => !this.selfPatterns.some((p) => a.key.toLowerCase().includes(p)));
    const names = [...new Set(apps.map((a) => a.name))].sort();
    if (names.join('|') !== this.apps.join('|')) {
      const prev = this.apps;
      this.apps = names;
      this.emit('change', { apps: names, started: names.filter((n) => !prev.includes(n)), stopped: prev.filter((n) => !names.includes(n)) });
    }
  }

  async _windows() {
    const r = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone', '/s'], { timeout: 8000 });
    if (r.code !== 0) return [];
    const out = [];
    let key = null, start = null, stop = null;
    const flush = () => {
      if (key && start && start !== '0x0' && stop === '0x0') {
        const leaf = key.split('\\').pop();
        const name = friendly(leaf);
        if (name) out.push({ key: leaf, name });
      }
    };
    for (const line of r.out.split(/\r?\n/)) {
      if (line.startsWith('HKEY_')) { flush(); key = line.trim(); start = stop = null; continue; }
      const m = line.trim().match(/^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i);
      if (m) m[1] === 'LastUsedTimeStart' ? (start = m[2]) : (stop = m[2]);
    }
    flush();
    return out;
  }

  async _linux() {
    const r = await run('pactl', ['list', 'source-outputs'], { timeout: 5000 });
    if (r.code !== 0) return [];
    const out = [];
    for (const m of r.out.matchAll(/application\.(?:name|process\.binary) = "([^"]+)"/g)) {
      const name = friendly(m[1]);
      if (name) out.push({ key: m[1], name });
    }
    return out;
  }
}

module.exports = { MeetingDetector };
