// Atualização automática pelas releases do GitHub (electron-updater), no mesmo modelo do Tecius:
//  - Windows (instalador) e Linux (AppImage): baixa dentro do app e instala ao reiniciar;
//  - macOS sem certificado da Apple, Windows portátil e Linux .deb/.rpm: o sistema não
//    deixa o app se substituir sozinho, então o aviso abre a página da release ("manual").
const { app, shell } = require('electron');
const { spawnSync } = require('child_process');
const path = require('path');
const { EventEmitter } = require('events');

const RELEASES_URL = 'https://github.com/luiscriativo/meetrec/releases';
const FIRST_CHECK_MS = 10 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

function manualReason() {
  if (process.platform === 'darwin') {
    // O instalador nativo do Mac só aceita atualizações de apps assinados com Team ID
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    const r = spawnSync('codesign', ['-dv', bundle], { encoding: 'utf8' });
    return /TeamIdentifier=(?!not set)/.test(`${r.stdout || ''}${r.stderr || ''}`) ? null : 'mac';
  }
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'linux-package';
  return null;
}

function friendlyError(err) {
  const m = String(err?.message || err || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR|socket hang up|network/i.test(m)) return 'Sem conexão com o GitHub para verificar atualizações.';
  if (/404|Cannot find latest|No published versions/i.test(m)) return 'Ainda não há versões publicadas para atualizar.';
  if (/rate limit|403/i.test(m)) return 'O GitHub limitou as consultas por agora. Tente mais tarde.';
  if (/sha512 checksum mismatch/i.test(m)) return 'O download veio corrompido. Tente baixar de novo.';
  return `Não foi possível atualizar: ${m.split('\n')[0].slice(0, 160)}`;
}

class Updater extends EventEmitter {
  constructor() {
    super();
    this.status = { state: 'idle', current: app.getVersion(), version: null, percent: 0, manual: false, error: null, checkedAt: null };
    this.updater = null;
    this.manual = null;
    this.userInitiated = false;
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  start() {
    if (!app.isPackaged) {
      this._set({ state: 'dev' }); // em desenvolvimento não há o que atualizar
      return;
    }
    this.manual = manualReason();
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); } catch (e) {
      this._set({ state: 'error', error: friendlyError(e) });
      return;
    }
    this.updater = autoUpdater;
    autoUpdater.autoDownload = false;              // o usuário decide quando baixar
    autoUpdater.autoInstallOnAppQuit = !this.manual; // já baixada: instala ao fechar o app
    autoUpdater.logger = null;
    // Teste do fluxo de atualização com um servidor local: --update-feed=http://127.0.0.1:<porta>/
    const feed = process.argv.find((a) => a.startsWith('--update-feed='))?.slice('--update-feed='.length);
    if (feed && /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(feed)) autoUpdater.setFeedURL({ provider: 'generic', url: feed });

    autoUpdater.on('checking-for-update', () => this._set({ state: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => {
      // O electron-updater repete este evento durante o download: não volta o estado
      if (['downloading', 'downloaded'].includes(this.status.state)) return;
      this._set({ state: 'available', version: info.version, manual: !!this.manual, checkedAt: Date.now(), notesUrl: `${RELEASES_URL}/tag/v${info.version}` });
      this.emit('available', this.status);
    });
    autoUpdater.on('update-not-available', () => {
      this._set({ state: 'not-available', checkedAt: Date.now() });
      if (this.userInitiated) this.emit('up-to-date', this.status);
    });
    autoUpdater.on('download-progress', (p) => {
      this._set({ state: 'downloading', percent: Math.round(p.percent || 0), bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this._set({ state: 'downloaded', version: info.version, percent: 100 });
      this.emit('downloaded', this.status);
    });
    autoUpdater.on('error', (err) => {
      const wasDownloading = this.status.state === 'downloading';
      // Falhas da verificação automática em segundo plano não incomodam o usuário
      if (!this.userInitiated && !wasDownloading) { this._set({ state: 'idle', checkedAt: Date.now() }); return; }
      this._set({ state: 'error', error: friendlyError(err) });
      this.emit('failed', this.status);
    });

    setTimeout(() => this.check(false), FIRST_CHECK_MS);
    setInterval(() => { if (!['downloading', 'downloaded'].includes(this.status.state)) this.check(false); }, INTERVAL_MS);
  }

  async check(userInitiated = true) {
    if (!this.updater) return this.status;
    if (['checking', 'downloading'].includes(this.status.state)) return this.status;
    this.userInitiated = userInitiated;
    try { await this.updater.checkForUpdates(); } catch { /* tratado no evento 'error' */ }
    return this.status;
  }

  async download() {
    if (this.status.state !== 'available' && this.status.state !== 'error') return this.status;
    if (this.manual) {
      await shell.openExternal(this.status.version ? `${RELEASES_URL}/tag/v${this.status.version}` : `${RELEASES_URL}/latest`);
      return this.status;
    }
    this.userInitiated = true;
    this._set({ state: 'downloading', percent: 0, error: null });
    try { await this.updater.downloadUpdate(); } catch { /* tratado no evento 'error' */ }
    return this.status;
  }

  install() {
    if (this.status.state !== 'downloaded' || !this.updater) return false;
    // isSilent=false (mostra o instalador do Windows), isForceRunAfter=true (reabre o app)
    this.updater.quitAndInstall(false, true);
    return true;
  }
}

module.exports = { Updater, RELEASES_URL };
