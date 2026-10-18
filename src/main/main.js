// MeetRec — processo principal: janelas, bandeja, gravação, atalhos, IPC.
const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, session, desktopCapturer,
  globalShortcut, Notification, dialog, shell, clipboard, protocol, systemPreferences, nativeTheme,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const { Store } = require('./store');
const { Library } = require('./library');
const { Pipeline } = require('./pipeline');
const { Bridge } = require('./bridge');
const { MeetingDetector } = require('./detector');
const { Updater } = require('./updater');
const { runChecks } = require('./diagnostics');
const { Engine, modelId, MODELS, DEFAULT_MODEL } = require('./engine');
const { configureLocal } = require('./transcribe');
const { CliSetup, CLIS } = require('./ai-setup');
const { runAI, engineOf, ENGINES } = require('./ai');
const { ffmpegPath, run, resourcePath, clearCache } = require('./tools');
const { fmtTime, transcriptToText } = require('./speakers');
const F = require('./folders');
const S = require('./sync');
const { migrateLibrary, countMeetings } = require('./migrate');
const { FOLDER_NAME: EXT_FOLDER, syncExtension } = require('./extension');

let extInfo = { dir: null, version: null };
function syncExtensionCopy() {
  const r = syncExtension(resourcePath('extension'), path.join(app.getPath('documents'), EXT_FOLDER));
  if (r.error) console.warn('Extensão: não consegui copiar para Documentos:', r.error);
  return r;
}

const isMac = process.platform === 'darwin';
const ROOT = path.join(__dirname, '..', '..');
const asset = (f) => path.join(ROOT, 'assets', f);
const page = (f) => path.join(ROOT, 'src', 'renderer', f);

if (isMac) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacCatapLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Identidade do app no Windows: precisa ser igual ao appId do electron-builder (é o que o instalador grava
// nos atalhos). Assim a barra de tarefas e as notificações usam o ícone e o nome do MeetRec. A versão de
// desenvolvimento (electron.exe) usa outra identidade para não misturar o ícone do Electron com o do app.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'io.github.luiscriativo.meetrec' : 'io.github.luiscriativo.meetrec.dev');

// Desenvolvimento: perfil separado (ex.: dados de demonstração para os prints do README)
const devProfile = !app.isPackaged && process.argv.find((a) => a.startsWith('--user-data='));
if (devProfile) app.setPath('userData', path.resolve(devProfile.slice('--user-data='.length)));
// Desenvolvimento: simula situações do Claude Code sem mexer na instalação real
//   --claude-config=<pasta>  conta não conectada (configuração vazia)
//   --hide-claude / --hide-codex   "não instalado"
//   --fake-claude-install    instalador de mentira (progresso + log, não instala nada)
//   --hide-python            simula um PC sem Python (o app instala o motor próprio)
//   --hf-home=<pasta>        cache de modelos separado (não mexe no do usuário)
if (!app.isPackaged) {
  if (process.argv.includes('--hide-python')) process.env.MEETREC_DEV_HIDE_PYTHON = '1';
  const hf = process.argv.find((a) => a.startsWith('--hf-home='));
  if (hf) process.env.HF_HOME = path.resolve(hf.slice('--hf-home='.length));
  const cfg = process.argv.find((a) => a.startsWith('--claude-config='));
  if (cfg) process.env.CLAUDE_CONFIG_DIR = path.resolve(cfg.slice('--claude-config='.length));
  const cxh = process.argv.find((a) => a.startsWith('--codex-home='));
  if (cxh) process.env.CODEX_HOME = path.resolve(cxh.slice('--codex-home='.length)); // Codex sem login, isolado
  if (process.argv.includes('--hide-claude')) process.env.MEETREC_DEV_HIDE_CLAUDE = '1';
  if (process.argv.includes('--hide-codex')) process.env.MEETREC_DEV_HIDE_CODEX = '1';
  if (process.argv.includes('--fake-claude-install')) process.env.MEETREC_DEV_FAKE_INSTALL = '1';
}

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

protocol.registerSchemesAsPrivileged([{ scheme: 'meetrec-media', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true, standard: true } }]);

let store, library, pipeline, bridge, detector, updater, tray, engine, aiSetup;
let mainWin = null, overlayWin = null, recorderWin = null;
let quitting = false;
let hiddenHintShown = false;

// ───────────────────────── Estado da gravação ─────────────────────────
const rec = {
  active: false, id: null, paused: false, startedAt: 0, pausedTotal: 0, pauseStart: 0,
  streams: {}, tracks: {}, stopping: false, levels: { mic: 0, system: 0 },
};

function recTime() {
  if (!rec.active) return 0;
  const now = rec.paused ? rec.pauseStart : Date.now();
  return (now - rec.startedAt - rec.pausedTotal) / 1000;
}

function recState() {
  return {
    active: rec.active, id: rec.id, paused: rec.paused, stopping: rec.stopping, starting: rec.phase === 'starting',
    elapsed: recTime(), tracks: rec.tracks,
    title: rec.id ? library.get(rec.id)?.title : null,
    startedAt: rec.startedAt,
  };
}

// ───────────────────────── Broadcast ─────────────────────────
function send(type, payload) {
  for (const w of [mainWin, overlayWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('evt', { type, payload });
  }
}

function notify(title, body, onClick) {
  if (!store.get('notifications') || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: asset('icon.png'), silent: true });
  // Mantém a referência: sem isso o coletor de lixo descarta a notificação e o clique não funciona
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on('click', () => { release(); onClick ? onClick() : showMain(); });
  n.on('close', release);
  n.show();
}
const liveNotifications = new Set();

function toast(kind, message, opts = {}) { send('toast', { kind, message, ...opts }); }

// ───────────────────────── Janelas ─────────────────────────
function createMainWindow(show = true) {
  const dark = nativeTheme.shouldUseDarkColors;
  mainWin = new BrowserWindow({
    width: 1240, height: 800, minWidth: 920, minHeight: 600, show: false,
    title: 'MeetRec',
    icon: asset('icon.png'),
    backgroundColor: dark ? '#0F0F14' : '#F7F7FA',
    titleBarStyle: 'hidden',
    titleBarOverlay: isMac ? undefined : { color: '#00000000', symbolColor: dark ? '#C9C9D6' : '#3A3A48', height: 40 },
    trafficLightPosition: { x: 16, y: 13 },
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWin.loadFile(page('app/index.html'));
  mainWin.once('ready-to-show', () => { if (show) mainWin.show(); });
  mainWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin.hide();
    if (!hiddenHintShown) {
      hiddenHintShown = true;
      notify('O MeetRec continua ativo', 'Ele fica na bandeja do sistema. Use o ícone para gravar ou abrir.');
    }
  });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  lockNavigation(mainWin);
  nativeTheme.on('updated', () => {
    if (!mainWin || isMac) return;
    try { mainWin.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#C9C9D6' : '#3A3A48', height: 40 }); } catch {}
  });
}

// Impede que a janela troque de página (ex.: soltar um arquivo nela abriria o arquivo no lugar do app)
function lockNavigation(win) {
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

function showMain(route) {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow(true);
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  if (route) mainWin.webContents.send('evt', { type: 'navigate', payload: route });
}

function createRecorderWindow() {
  recorderWin = new BrowserWindow({
    show: false, width: 300, height: 200, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, backgroundThrottling: false, sandbox: false },
  });
  recorderWin.loadFile(page('recorder/recorder.html'));
  recorderWin.webContents.on('render-process-gone', () => {
    if (rec.active) {
      toast('error', 'O módulo de gravação travou. O áudio salvo até agora foi preservado.');
      finishRecording({ crashed: true });
    }
    recorderWin = null;
    setTimeout(createRecorderWindow, 500);
  });
}

const OVERLAY_W = 480, OVERLAY_H = 76;
function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const pos = store.get('overlayPosition');
  const wa = screen.getPrimaryDisplay().workArea;
  let x = Math.round(wa.x + (wa.width - OVERLAY_W) / 2), y = wa.y + 12;
  if (pos && screen.getAllDisplays().some((d) => pos.x >= d.bounds.x && pos.x < d.bounds.x + d.bounds.width && pos.y >= d.bounds.y && pos.y < d.bounds.y + d.bounds.height)) ({ x, y } = pos);
  overlayWin = new BrowserWindow({
    x, y, width: OVERLAY_W, height: OVERLAY_H, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false, focusable: true, fullscreenable: false,
    maximizable: false, minimizable: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, sandbox: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setContentProtection(!!store.get('hideOverlayInShare'));
  overlayWin.loadFile(page('overlay/overlay.html'));
  lockNavigation(overlayWin);
  let moveTimer;
  overlayWin.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { if (overlayWin && !overlayWin.isDestroyed()) { const [ox, oy] = overlayWin.getPosition(); store.set({ overlayPosition: { x: ox, y: oy } }); } }, 300);
  });
  overlayWin.on('closed', () => { overlayWin = null; });
  return overlayWin;
}

let overlayHideTimer = null;
function showOverlay(mode, data = {}, autoHideMs = 0) {
  if (!store.get('showOverlay') && mode !== 'suggest' && mode !== 'suggest-stop') return;
  const w = createOverlay();
  clearTimeout(overlayHideTimer);
  const doShow = () => {
    w.webContents.send('evt', { type: 'overlay-mode', payload: { mode, ...data, rec: recState() } });
    if (!w.isVisible()) w.showInactive();
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', doShow); else doShow();
  if (autoHideMs) overlayHideTimer = setTimeout(hideOverlay, autoHideMs);
}

function hideOverlay() {
  clearTimeout(overlayHideTimer);
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

// ───────────────────────── Bandeja ─────────────────────────
function trayImage(kind) {
  const img = nativeImage.createFromPath(asset(`tray-${kind}.png`));
  const img2 = nativeImage.createFromPath(asset(`tray-${kind}@2x.png`));
  if (!img2.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: img2.toPNG() });
  return img;
}

function updateTray() {
  if (!tray) return;
  const busy = pipeline?.current;
  const kind = rec.active ? (rec.paused ? 'paused' : 'recording') : busy ? 'processing' : 'idle';
  tray.setImage(trayImage(kind));
  let status = 'Pronto para gravar';
  if (rec.active) status = `${rec.paused ? '⏸ Pausado' : '● Gravando'} · ${fmtTime(recTime())}`;
  else if (busy) {
    const m = library.get(busy.id);
    const labels = { audio: 'Preparando áudio', transcribe: 'Transcrevendo', speakers: 'Identificando falantes', summary: 'Gerando resumo' };
    const p = m?.steps?.[busy.step]?.progress;
    status = `${labels[busy.step] || 'Processando'}${p ? ` ${Math.round(p * 100)}%` : ''}…`;
  }
  tray.setToolTip(`MeetRec — ${status}`);
  const recent = library.list().slice(0, 5);
  const up = updater?.status || {};
  const updateItems = up.state === 'downloaded'
    ? [{ label: `↻ Reiniciar e instalar a versão ${up.version}`, click: () => installUpdate() }, { type: 'separator' }]
    : up.state === 'available'
      ? [{ label: up.manual ? `⬇ Nova versão ${up.version} — baixar no site` : `⬇ Baixar a versão ${up.version}`, click: () => { updater.download(); if (!up.manual) showMain(); } }, { type: 'separator' }]
      : up.state === 'downloading'
        ? [{ label: `Baixando atualização… ${up.percent || 0}%`, enabled: false }, { type: 'separator' }]
        : [];
  const menu = Menu.buildFromTemplate([
    ...updateItems,
    { label: status, enabled: false },
    { type: 'separator' },
    rec.active
      ? { label: 'Parar gravação', accelerator: store.get('shortcutToggle'), click: () => stopRecording() }
      : { label: 'Iniciar gravação', accelerator: store.get('shortcutToggle'), click: () => startRecording() },
    ...(rec.active ? [
      { label: rec.paused ? 'Retomar' : 'Pausar', click: () => togglePause() },
      { label: 'Marcar momento importante', accelerator: store.get('shortcutMarker'), click: () => addMarker() },
    ] : []),
    { type: 'separator' },
    { label: 'Abrir MeetRec', click: () => showMain() },
    { label: 'Reuniões recentes', submenu: recent.length ? recent.map((m) => ({ label: `${m.title} · ${fmtTime(m.duration || 0)}`, click: () => showMain({ view: 'meeting', id: m.id }) })) : [{ label: 'Nenhuma ainda', enabled: false }] },
    { label: 'Importar áudio…', click: () => importAudio() },
    { label: 'Configurações', click: () => showMain({ view: 'settings' }) },
    { type: 'separator' },
    { label: 'Sair', click: () => { quitApp(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(trayImage('idle'));
  tray.on('click', () => { if (isMac) return; showMain(); });
  tray.on('double-click', () => showMain());
  updateTray();
}

// ───────────────────────── Gravação ─────────────────────────
// Espera a resposta do gravador para a sessão `seq` (ignora respostas atrasadas de tentativas anteriores)
function waitFor(channel, seq, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const h = (_e, data) => {
      if (data && data.seq !== undefined && data.seq !== seq) return;
      clearTimeout(t); ipcMain.removeListener(channel, h); resolve(data || {});
    };
    const t = setTimeout(() => { ipcMain.removeListener(channel, h); reject(new Error('timeout')); }, timeout);
    ipcMain.on(channel, h);
  });
}
let recSeq = 0;

async function startRecording(opts = {}) {
  if (rec.active) { toast('info', 'Já existe uma gravação em andamento.'); return { ok: false, error: 'already' }; }
  if (!recorderWin || recorderWin.webContents.isLoading()) {
    toast('error', 'O módulo de gravação ainda está carregando. Tente novamente em instantes.');
    return { ok: false, error: 'not-ready' };
  }
  if (isMac) {
    const ok = await systemPreferences.askForMediaAccess('microphone');
    if (!ok) { toast('error', 'Permissão de microfone negada. Libere em Ajustes do Sistema → Privacidade → Microfone.'); return { ok: false, error: 'mic-denied' }; }
  }
  const s = store.get();
  const st = bridge.status();
  const platform = opts.platform || (st.inCall ? st.platform : null) || (detector.apps.find((a) => !/Chrome|Edge|Firefox|Brave|Opera|Vivaldi|Arc/.test(a)) || null);
  const meta = library.create({ folder: targetFolder(opts.folder), platform, meetingTitle: opts.title || (st.inCall ? st.meetingTitle : null), participants: st.inCall ? st.participants : [] });
  if (opts.title || (st.inCall && st.meetingTitle)) library.update(meta.id, { title: opts.title || st.meetingTitle });

  rec.streams = {};
  // Com a biblioteca no Drive, grava numa pasta local e só manda o áudio pronto no fim (ver finishRecording)
  fs.mkdirSync(library.workDir(meta.id), { recursive: true });
  for (const t of ['mic', 'system', 'mix']) rec.streams[t] = fs.createWriteStream(library.workFile(meta.id, `${t}.webm`));
  const seq = ++recSeq;
  Object.assign(rec, { active: true, phase: 'starting', seq, stopRequested: false, id: meta.id, paused: false, startedAt: Date.now(), pausedTotal: 0, pauseStart: 0, tracks: {}, stopping: false });

  send('rec-state', recState());
  showOverlay('starting');
  updateTray();

  recorderWin.webContents.send('evt', { type: 'recorder-start', payload: {
    seq, micDeviceId: s.micDeviceId, captureSystem: s.captureSystem, systemDeviceId: s.systemDeviceId,
    echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, platform: process.platform, sounds: s.sounds,
  } });

  let started;
  try { started = await waitFor('rec:started', seq, 25000); } catch {
    started = { ok: false, error: 'O módulo de gravação não respondeu (tempo esgotado).' };
    recorderWin?.webContents.send('evt', { type: 'recorder-stop', payload: { seq } }); // garante que nada fique gravando escondido
  }
  if (!started.ok) {
    rec.phase = null;
    await closeStreams();
    rec.active = false;
    pipeline.setLowPriority(false);
    pipeline.resume();
    library.update(meta.id, { status: 'error', error: started.error });
    try { await library.remove(meta.id); } catch {}
    send('rec-state', recState());
    showOverlay('error', { message: started.error }, 6000);
    toast('error', `Não foi possível gravar: ${started.error}`, { duration: 9000 });
    updateTray();
    return { ok: false, error: started.error };
  }
  rec.startedAt = Date.now();
  rec.phase = 'recording';
  rec.tracks = started.tracks;
  if (pipeline.current) {
    pipeline.setLowPriority(true);
    toast('info', 'A transcrição da reunião anterior continua em prioridade mínima para não pesar na chamada.');
  }
  library.update(meta.id, { tracks: { mic: !!started.tracks.mic, system: !!started.tracks.system, mix: true }, warnings: started.warnings || [], startedAt: new Date(rec.startedAt).toISOString() });
  for (const w of started.warnings || []) toast('warn', w, { duration: 9000 });

  send('rec-state', recState());
  showOverlay('recording');
  updateTray();
  const what = [started.tracks.mic && 'microfone', started.tracks.system && 'som do computador'].filter(Boolean).join(' + ');
  toast('success', `Gravação iniciada — capturando ${what}.`);
  notify('Gravando reunião', `Capturando ${what}. ${store.get('shortcutToggle').replace('CommandOrControl', isMac ? '⌘' : 'Ctrl')} para parar.`);
  // Pediram para parar enquanto ainda iniciava: para agora que o gravador está pronto
  if (rec.stopRequested) setTimeout(() => stopRecording(), 0);
  return { ok: true, id: meta.id };
}

async function closeStreams() {
  await Promise.all(Object.values(rec.streams).map((s) => new Promise((r) => { try { s.end(r); } catch { r(); } })));
  rec.streams = {};
}

async function stopRecording() {
  if (!rec.active || rec.stopping) return;
  if (rec.phase === 'starting') {
    rec.stopRequested = true;
    toast('info', 'A gravação ainda está iniciando — ela será encerrada assim que estiver pronta.');
    return;
  }
  rec.stopping = true;
  send('rec-state', recState());
  showOverlay('saving');
  recorderWin?.webContents.send('evt', { type: 'recorder-stop', payload: { seq: rec.seq } });
  try { await waitFor('rec:stopped', rec.seq, 15000); } catch { /* segue com o que já foi salvo */ }
  await finishRecording();
}

async function finishRecording({ crashed } = {}) {
  const id = rec.id;
  const duration = recTime();
  if (rec.paused) rec.pausedTotal += Date.now() - rec.pauseStart;
  await closeStreams();
  rec.active = false;
  rec.phase = null;
  rec.stopping = false;
  rec.paused = false;
  rec.id = null;
  send('rec-state', recState());
  updateTray();
  pipeline.setLowPriority(false);
  if (!id) { pipeline.resume(); return; }

  // Leva o áudio da pasta de trabalho local para a biblioteca (no Drive, ele sobe em segundo plano).
  // A cópia local fica para o processamento não precisar baixar de volta.
  try { library.flushWork(id, { keep: true }); } catch (e) { toast('error', `Não consegui copiar o áudio para a pasta das gravações: ${e.message}. Ele continua salvo em ${library.workDir(id)}.`, { duration: 15000 }); }
  library.update(id, { status: 'recorded', endedAt: new Date().toISOString(), duration });
  if (duration < 3) {
    // Provavelmente um clique sem querer: descarta para não poluir a biblioteca
    const m = library.get(id);
    if (!m?.markers?.length && !m?.notes?.trim()) await library.remove(id).catch(() => {});
    toast('warn', 'Gravação muito curta (menos de 3 s) — descartada.');
    showOverlay('saved', { message: 'Gravação muito curta — descartada' }, 3500);
    pipeline.resume();
    return;
  }
  const auto = store.get('autoProcess');
  showOverlay('saved', { id, duration, processing: auto }, 5000);
  toast('success', `Gravação salva (${fmtTime(duration)}).${auto ? ' Iniciando transcrição…' : ''}`, { action: { label: 'Abrir', route: { view: 'meeting', id } } });
  notify('Gravação salva', `${fmtTime(duration)} de áudio.${auto ? ' Transcrevendo e resumindo em segundo plano…' : ''}`, () => showMain({ view: 'meeting', id }));
  if (auto && !crashed) pipeline.enqueue(id);
  pipeline.resume();
}

function togglePause() {
  if (!rec.active || rec.stopping || rec.phase !== 'recording') return;
  if (!rec.paused) {
    rec.paused = true; rec.pauseStart = Date.now();
    recorderWin?.webContents.send('evt', { type: 'recorder-pause' });
    toast('info', 'Gravação pausada.');
  } else {
    rec.pausedTotal += Date.now() - rec.pauseStart; rec.paused = false;
    recorderWin?.webContents.send('evt', { type: 'recorder-resume' });
    toast('info', 'Gravação retomada.');
  }
  send('rec-state', recState());
  showOverlay('recording');
  updateTray();
}

function addMarker(label) {
  if (!rec.active || rec.phase !== 'recording') return;
  const t = recTime();
  library.update(rec.id, (m) => { m.markers = [...(m.markers || []), { t, label: label || '' }]; return m; });
  recorderWin?.webContents.send('evt', { type: 'play-sound', payload: 'marker' });
  send('marker-added', { id: rec.id, t, label });
  toast('success', `Momento marcado em ${fmtTime(t)}.`);
}

// ───────────────────────── Atualização ─────────────────────────
function installUpdate() {
  if (rec.active) {
    toast('warn', 'Há uma gravação em andamento. Pare a gravação para instalar a atualização.');
    showMain();
    return { ok: false, error: 'recording' };
  }
  quitting = true; // libera o before-quit; o instalador reabre o app no fim
  if (!updater.install()) { quitting = false; return { ok: false, error: 'not-ready' }; }
  return { ok: true };
}

// ───────────────────────── Atalhos ─────────────────────────
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const fails = [];
  const reg = (acc, fn) => { if (!acc) return; try { if (!globalShortcut.register(acc, fn)) fails.push(acc); } catch { fails.push(acc); } };
  reg(store.get('shortcutToggle'), () => (rec.active ? stopRecording() : startRecording()));
  reg(store.get('shortcutMarker'), () => addMarker());
  if (fails.length) setTimeout(() => toast('warn', `Atalho indisponível (em uso por outro app): ${fails.join(', ')}`), 2500);
  return fails;
}

// Pasta onde a próxima gravação/importação é salva (a escolhida em "Salvar em")
function targetFolder(explicit) {
  const f = explicit !== undefined && explicit !== null ? explicit : store.get('recordFolder');
  return f && library.getFolder(f) ? f : '';
}

// ───────────────────────── Pastas e pontos de dúvida ─────────────────────────
function folderBusy(name) {
  return library.list().some((m) => m.folder === name && (pipeline.isBusy(m.id) || rec.id === m.id));
}

const hasSummary = (m) => fs.existsSync(library.file(m.id, 'summary.md'));

function folderPayload(name) {
  const d = library.getFolder(name);
  if (!d) return null;
  const meetings = library.list().filter((m) => (m.folder || '') === (name || ''));
  return { name: name || '', ...d, dir: library.folderDir(name), count: meetings.length, summarized: meetings.filter(hasSummary).length, size: F.folderSize(d) };
}

// Reunião sendo gravada/processada no outro PC (e ainda dando sinal de vida): não mexe nos arquivos dela
function busyElsewhere(id, what) {
  const o = library.ownerOf(id);
  if (!o || o.stale) return null;
  const doing = library.get(id)?.status === 'processing' ? 'sendo processada' : 'sendo gravada';
  return `Esta reunião está ${doing} no ${o.name}. Aguarde terminar para ${what}.`;
}

async function moveMeeting(id, folder) {
  if (rec.id === id) throw new Error('Pare a gravação antes de mover esta reunião.');
  const other = busyElsewhere(id, 'movê-la');
  if (other) throw new Error(other);
  if (pipeline.isBusy(id)) throw new Error('Aguarde o processamento desta reunião terminar para movê-la.');
  const before = library.get(id)?.folder || '';
  const m = await library.move(id, folder);
  const dest = folder ? `"${folder}"` : '"Sem pasta"';
  const d = folder ? library.getFolder(folder) : null;
  const offerBootstrap = folder && F.contextIsEmpty(d?.context) && !d?.draft && hasSummary(m);
  if (before !== (folder || '')) {
    toast('success', `Reunião movida para ${dest}.`, offerBootstrap
      ? { duration: 9000, action: { label: 'Montar contexto da pasta', route: { view: 'folder', name: folder, bootstrap: true } } }
      : {});
  }
  return m;
}

// Aplica a sua resposta a um ponto de dúvida: corrige a transcrição, guarda o esclarecimento
// para o próximo resumo e (se pedido) lembra o termo no glossário da pasta.
function resolveDoubt(id, doubtId, { action, answer, remember }) {
  const meta = library.get(id);
  const d = meta?.doubts?.find((x) => x.id === doubtId);
  if (!d) throw new Error('Ponto de dúvida não encontrado.');
  answer = String(answer || '').trim();
  const folder = meta.folder || '';
  let replaced = 0, remembered = false;
  const clarify = (text) => library.update(id, (m) => {
    m.clarifications = [...(m.clarifications || []).filter((c) => c.doubtId !== doubtId), { doubtId, question: d.question, heard: d.heard, answer: text, t: d.t }];
    return m;
  });

  if (action === 'fix') {
    if (!answer) throw new Error('Escreva a correção.');
    // Só troca na transcrição em dúvidas de termo/nome e quando a resposta é a grafia certa (curta), não uma explicação
    const isSpelling = (d.kind === 'termo' || d.kind === 'nome') && d.heard && answer !== d.heard && !/\n/.test(answer) && answer.length <= Math.max(40, d.heard.length * 3);
    if (isSpelling) {
      const tr = library.readJson(id, 'transcript.json');
      if (tr?.segments) {
        const r = F.applyCorrections(tr.segments, [{ from: d.heard, to: answer }]);
        replaced = r.count;
        if (r.count) {
          library.writeJson(id, 'transcript.json', { ...tr, segments: r.segments });
          library.writeText(id, 'transcript.txt', transcriptToText(r.segments, meta.speakerNames));
        }
      }
      library.update(id, (m) => { m.corrections = [...(m.corrections || []).filter((c) => c.heard !== d.heard), { heard: d.heard, answer }]; return m; });
      if (remember) { library.updateFolder(folder, (f) => ({ ...f, glossary: F.addGlossaryTerm(f.glossary, { term: answer, heard: d.heard }) })); remembered = true; }
    } else if (remember && (d.kind === 'nome' || d.kind === 'termo') && answer.length <= 40 && !/\n/.test(answer)) {
      library.updateFolder(folder, (f) => ({ ...f, glossary: F.addGlossaryTerm(f.glossary, { term: answer }) }));
      remembered = true;
    }
    clarify(answer);
  } else if (action === 'ok') {
    clarify(d.heard ? `"${d.heard}" está correto` : 'está correto como foi transcrito');
    if (remember && (d.kind === 'termo' || d.kind === 'nome') && d.heard && d.heard.length <= 40) { library.updateFolder(folder, (f) => ({ ...f, glossary: F.addGlossaryTerm(f.glossary, { term: d.heard }) })); remembered = true; }
  } else if (action !== 'ignore') throw new Error('Ação inválida.');

  const updated = library.update(id, (m) => {
    m.doubts = (m.doubts || []).map((x) => (x.id === doubtId ? { ...x, status: action === 'fix' ? 'fixed' : action === 'ignore' ? 'ignored' : 'ok', answer: action === 'fix' ? answer : undefined, replaced, remembered, resolvedAt: new Date().toISOString() } : x));
    return m;
  });
  return { meta: updated, replaced, remembered };
}

// ───────────────────────── Importação / exportação ─────────────────────────
async function importAudio(filePath, folder) {
  if (!filePath) {
    const r = await dialog.showOpenDialog(mainWin && mainWin.isVisible() ? mainWin : undefined, {
      title: 'Importar áudio ou vídeo de reunião',
      properties: ['openFile'],
      filters: [{ name: 'Áudio/Vídeo', extensions: ['mp3', 'wav', 'm4a', 'mp4', 'webm', 'ogg', 'opus', 'mkv', 'mov', 'aac', 'flac', 'wma'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    filePath = r.filePaths[0];
  }
  const name = path.basename(filePath, path.extname(filePath));
  const meta = library.create({ folder: targetFolder(folder), source: 'import', status: 'processing', title: name, titleAuto: true, originalFile: 'original' + path.extname(filePath).toLowerCase() });
  // Na nuvem, o original fica só na pasta de trabalho local: ao Drive vai apenas o áudio convertido
  try { fs.mkdirSync(library.workDir(meta.id), { recursive: true }); fs.copyFileSync(filePath, library.workFile(meta.id, meta.originalFile)); } catch (e) {
    library.update(meta.id, { status: 'error', error: `Falha ao copiar: ${e.message}` });
    toast('error', `Não consegui importar: ${e.message}`);
    return null;
  }
  try { const st = fs.statSync(filePath); library.update(meta.id, { createdAt: new Date(st.mtime).toISOString() }); } catch {}
  toast('success', `"${name}" importado. Processando…`);
  pipeline.enqueue(meta.id);
  showMain({ view: 'meeting', id: meta.id });
  return meta.id;
}

async function exportItem(id, kind) {
  const meta = library.get(id);
  if (!meta) return { ok: false };
  const safe = meta.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
  const date = meta.createdAt.slice(0, 10);
  const defs = {
    summary: { name: `Resumo - ${safe} - ${date}.md`, filters: [{ name: 'Markdown/Texto', extensions: ['md', 'txt'] }] },
    transcript: { name: `Transcrição - ${safe} - ${date}.txt`, filters: [{ name: 'Texto', extensions: ['txt'] }] },
    mp3: { name: `${safe} - ${date}.mp3`, filters: [{ name: 'MP3', extensions: ['mp3'] }] },
  };
  const d = defs[kind];
  const r = await dialog.showSaveDialog(mainWin, { defaultPath: path.join(app.getPath('documents'), d.name), filters: d.filters });
  if (r.canceled || !r.filePath) return { ok: false };
  if (kind === 'summary') fs.writeFileSync(r.filePath, library.readText(id, 'summary.md') || '');
  else if (kind === 'transcript') fs.writeFileSync(r.filePath, library.readText(id, 'transcript.txt') || '');
  else {
    toast('info', 'Convertendo para MP3…');
    const res = await run(ffmpegPath(), ['-hide_banner', '-y', '-i', library.file(id, meta.audioFile || 'mix.webm'), '-vn', '-c:a', 'libmp3lame', '-b:a', '96k', r.filePath], { timeout: 3600e3 });
    if (res.code !== 0) { toast('error', 'Falha ao converter para MP3.'); return { ok: false }; }
  }
  toast('success', 'Exportado com sucesso.', { action: { label: 'Mostrar', reveal: r.filePath } });
  return { ok: true, path: r.filePath };
}

// ───────────────────────── Detector de reunião e extensão ─────────────────────────
let stopSuggestTimer = null;
function onMeetingAppsChange({ apps, started, stopped }) {
  send('detector', { apps });
  if (!store.get('detectMeetings')) return;
  if (!rec.active && started.length) {
    const appName = started.find((a) => !/Chrome|Edge|Firefox|Brave|Opera|Vivaldi|Arc/.test(a)) || started[0];
    const isBrowser = /Chrome|Edge|Firefox|Brave|Opera|Vivaldi|Arc/.test(appName);
    showOverlay('suggest', { app: appName, text: isBrowser ? `${appName} está usando o microfone` : `Reunião detectada no ${appName}` }, 30000);
  }
  if (rec.active && stopped.length && !apps.length && store.get('autoStopSuggest')) {
    clearTimeout(stopSuggestTimer);
    stopSuggestTimer = setTimeout(() => {
      if (rec.active && !detector.apps.length) showOverlay('suggest-stop', { text: `${stopped[0]} parou de usar o microfone` });
    }, 8000);
  }
}

function onBridgeEvents({ tab, events }) {
  if (!rec.active || rec.paused) return;
  const rt = recTime();
  const lines = events.map((e) => JSON.stringify({ ...e, rt: e.at ? Math.max(0, rt - (Date.now() - e.at) / 1000) : rt })).join('\n') + '\n';
  fs.appendFile(library.workFile(rec.id, 'events.jsonl'), lines, () => {});
  const m = library.get(rec.id);
  const patch = {};
  if (tab.platform && !m.platform) patch.platform = tab.platform;
  if (tab.title && !m.meetingTitle) { patch.meetingTitle = tab.title; if (m.titleAuto) patch.title = tab.title; }
  const names = new Set(m.participants || []);
  let grew = false;
  for (const e of events) {
    const add = (n) => { if (n && !names.has(n)) { names.add(n); grew = true; } };
    if (e.type === 'participants') (e.names || []).forEach(add);
    if (e.speaker) add(e.speaker);
  }
  if (grew) patch.participants = [...names];
  if (Object.keys(patch).length) library.update(rec.id, patch);
}

// ───────────────────────── IPC ─────────────────────────
function setupIpc() {
  // Gravador (janela oculta)
  ipcMain.on('rec:chunk', (_e, { track, data }) => {
    const s = rec.streams[track];
    if (s && !s.destroyed) s.write(Buffer.from(data));
  });
  ipcMain.on('rec:levels', (_e, lv) => {
    rec.levels = lv;
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) overlayWin.webContents.send('evt', { type: 'levels', payload: lv });
    if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) mainWin.webContents.send('evt', { type: 'levels', payload: lv });
  });
  ipcMain.on('rec:warning', (_e, w) => {
    if (!rec.active) return;
    send('rec-warning', w);
    if (w.persist) library.update(rec.id, (m) => { m.warnings = [...new Set([...(m.warnings || []), w.message])]; return m; });
    if (w.level === 'error') notify('Atenção na gravação', w.message);
  });
  ipcMain.on('rec:track-ended', (_e, { track, message }) => {
    rec.tracks = { ...rec.tracks, [track]: false };
    send('rec-state', recState());
    send('rec-warning', { message, level: 'error', key: `ended-${track}` });
    notify('Atenção na gravação', message);
  });

  // App
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, extensionDir: extInfo.dir, extensionVersion: extInfo.version, extensionError: extInfo.error || null, userData: app.getPath('userData') }));
  // Extensão do navegador: recopia antes de abrir (caso a pasta tenha sido apagada)
  ipcMain.handle('ext:sync', () => { extInfo = syncExtensionCopy(); return extInfo; });
  ipcMain.handle('settings:get', () => store.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    patch = { ...patch };
    if (patch.storageDir !== undefined && rec.active) {
      delete patch.storageDir;
      toast('warn', 'Pare a gravação antes de trocar a pasta das gravações.');
    }
    if (patch.bridgePort !== undefined) {
      const port = Math.round(Number(patch.bridgePort));
      if (!(port >= 1024 && port <= 65535)) {
        delete patch.bridgePort;
        toast('error', 'Porta inválida: use um número entre 1024 e 65535.');
      } else patch.bridgePort = port;
    }
    return store.set(patch);
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickFile', async () => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('shell:open', (_e, target) => {
    if (/^https?:\/\//.test(target)) return shell.openExternal(target);
    return shell.openPath(target);
  });
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(text); return true; });
  ipcMain.on('window:show-main', (_e, route) => showMain(route));

  // Gravação
  ipcMain.handle('rec:start', (_e, opts) => startRecording(opts));
  ipcMain.handle('rec:stop', () => stopRecording());
  ipcMain.handle('rec:pause', () => togglePause());
  ipcMain.handle('rec:marker', (_e, label) => addMarker(label));
  ipcMain.handle('rec:state', () => recState());
  ipcMain.handle('rec:notes', (_e, notes) => { if (rec.id) library.update(rec.id, { notes }); });

  // Overlay
  ipcMain.on('overlay:action', (_e, action) => {
    if (action === 'stop') stopRecording();
    else if (action === 'pause') togglePause();
    else if (action === 'marker') addMarker();
    else if (action === 'open') showMain(rec.id ? { view: 'meeting', id: rec.id } : null);
    else if (action === 'start') { hideOverlay(); startRecording(); }
    else if (action === 'dismiss') { if (rec.active) showOverlay('recording'); else hideOverlay(); }
    else if (action === 'hide') hideOverlay();
    else if (action === 'open-last' && library.list()[0]) showMain({ view: 'meeting', id: library.list()[0].id });
  });
  ipcMain.on('overlay:resize', (_e, h) => {
    if (overlayWin && !overlayWin.isDestroyed()) { const [w] = overlayWin.getSize(); overlayWin.setSize(w, Math.max(OVERLAY_H, Math.min(220, Math.round(h)))); }
  });

  // Biblioteca
  ipcMain.handle('lib:list', () => library.list());
  ipcMain.handle('lib:get', (_e, id) => {
    const meta = library.get(id);
    if (!meta) return null;
    return {
      meta,
      transcript: library.readJson(id, 'transcript.json'),
      summary: library.readText(id, 'summary.md'),
      dir: library.dir(id),
      busy: pipeline.isBusy(id),
      owner: library.ownerOf(id),
      openElsewhere: library.openElsewhere(id),
    };
  });
  ipcMain.handle('lib:update', (_e, id, patch) => {
    patch = { ...patch };
    delete patch.folder; // mudar de pasta só por lib:move (move os arquivos)
    if (patch.title) patch.titleAuto = false;
    const m = library.update(id, patch);
    if (patch.speakerNames) {
      const tr = library.readJson(id, 'transcript.json');
      if (tr) library.writeText(id, 'transcript.txt', transcriptToText(tr.segments, m.speakerNames));
    }
    return m;
  });
  ipcMain.handle('lib:saveSummary', (_e, id, text) => { library.writeText(id, 'summary.md', text); return true; });
  ipcMain.handle('lib:delete', async (_e, id) => {
    if (rec.id === id) return { ok: false, error: 'Pare a gravação antes de excluir.' };
    const other = busyElsewhere(id, 'excluí-la');
    if (other) return { ok: false, error: other };
    pipeline.cancel(id, { silent: true });
    try { await library.remove(id); } catch (e) { return { ok: false, error: e.message }; }
    toast('success', 'Reunião movida para a lixeira.');
    return { ok: true };
  });
  ipcMain.handle('lib:search', (_e, q) => library.search(q));
  ipcMain.handle('lib:openFolder', (_e, id) => shell.openPath(id ? library.dir(id) : library.root));
  ipcMain.handle('lib:export', (_e, id, kind) => exportItem(id, kind));
  ipcMain.handle('lib:import', (_e, p, folder) => importAudio(p, folder));
  ipcMain.handle('lib:move', async (_e, id, folder) => {
    try { await moveMeeting(id, folder); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('lib:resolveDoubt', (_e, id, doubtId, opts) => {
    try { return { ok: true, ...resolveDoubt(id, doubtId, opts || {}) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  // Pastas
  const wrap = (fn) => async (...a) => { try { return { ok: true, ...(await fn(...a)) }; } catch (e) { return { ok: false, error: e.message }; } };
  ipcMain.handle('folder:list', () => library.listFolders());
  ipcMain.handle('folder:get', (_e, name) => folderPayload(name));
  ipcMain.handle('folder:create', wrap((_e, name, description) => ({ name: library.createFolder(name, description) })));
  ipcMain.handle('folder:rename', wrap(async (_e, oldName, newName) => {
    if (folderBusy(oldName)) throw new Error('Há uma reunião desta pasta gravando ou sendo processada. Aguarde terminar para renomear.');
    const name = await library.renameFolder(oldName, newName);
    if (store.get('recordFolder') === oldName) store.set({ recordFolder: name });
    return { name };
  }));
  ipcMain.handle('folder:delete', wrap(async (_e, name) => {
    if (folderBusy(name)) throw new Error('Há uma reunião desta pasta gravando ou sendo processada. Aguarde terminar para excluir.');
    await library.removeFolder(name);
    if (store.get('recordFolder') === name) store.set({ recordFolder: '' });
    return {};
  }));
  ipcMain.handle('folder:update', wrap((_e, name, patch) => {
    // Só os campos que a tela edita; o resto (rascunho, histórico) passa pelas ações próprias
    const p = {};
    if (patch.description !== undefined) p.description = String(patch.description).trim();
    if (patch.context !== undefined) { p.context = F.normalizeContext(patch.context); p.contextAt = new Date().toISOString(); }
    if (patch.history !== undefined) { p.history = String(patch.history).trim(); p.historyAt = new Date().toISOString(); }
    if (patch.glossary !== undefined) p.glossary = F.normalizeFolderData({ glossary: patch.glossary }).glossary;
    library.updateFolder(name, p);
    return {};
  }));
  ipcMain.handle('folder:addTerm', wrap((_e, name, term, heard) => {
    if (!String(term || '').trim()) throw new Error('Escreva o termo.');
    library.updateFolder(name, (f) => ({ ...f, glossary: F.addGlossaryTerm(f.glossary, { term, heard }) }));
    return {};
  }));
  ipcMain.handle('folder:approveDraft', wrap((_e, name, edited) => {
    const f = library.getFolder(name);
    if (!f?.draft && !edited) throw new Error('Não há sugestão para aprovar.');
    library.updateFolder(name, { context: F.normalizeContext(edited || f.draft), contextAt: new Date().toISOString(), draft: null });
    return {};
  }));
  ipcMain.handle('folder:discardDraft', wrap((_e, name) => { library.updateFolder(name, { draft: null }); return {}; }));
  ipcMain.handle('folder:bootstrap', wrap(async (e, name) => {
    const r = await pipeline.bootstrapFolder(name, (m) => e.sender.send('evt', { type: 'folder-status', payload: { name, message: m } }));
    return r;
  }));
  ipcMain.handle('folder:slim', wrap(async (e, name) => {
    const r = await pipeline.slimFolder(name, (m) => e.sender.send('evt', { type: 'folder-status', payload: { name, message: m } }));
    return r;
  }));
  ipcMain.handle('folder:approveSlim', wrap((_e, name) => {
    const f = library.getFolder(name);
    if (!f?.slim) throw new Error('Não há proposta para aprovar.');
    const p = { history: f.slim.history, historyAt: new Date().toISOString(), slim: null };
    if (f.slim.context) { p.context = f.slim.context; p.contextAt = new Date().toISOString(); }
    library.updateFolder(name, p);
    return {};
  }));
  ipcMain.handle('folder:discardSlim', wrap((_e, name) => { library.updateFolder(name, { slim: null }); return {}; }));
  ipcMain.handle('folder:open', (_e, name) => {
    const d = library.ctxDir(name);
    fs.mkdirSync(d, { recursive: true });
    return shell.openPath(name ? library.folderDir(name) : d);
  });
  ipcMain.handle('lib:mediaUrl', (_e, id) => {
    const m = library.get(id);
    return m?.audioFile ? `meetrec-media://rec/${encodeURIComponent(id)}/${encodeURIComponent(m.audioFile)}` : null;
  });

  // Pipeline
  ipcMain.handle('pipe:process', (_e, id, from) => {
    const other = busyElsewhere(id, 'processar aqui');
    if (other) { toast('info', other); return false; }
    if (library.ownerOf(id)?.stale) library.release(id); // o outro PC parou no meio: assume aqui
    const ok = pipeline.enqueue(id, from || 'audio');
    if (!ok) toast('info', 'Esta reunião já está sendo processada.');
    return ok;
  });
  ipcMain.handle('pipe:cancel', (_e, id) => pipeline.cancel(id));
  ipcMain.handle('lib:release', (_e, id) => {
    const o = library.ownerOf(id);
    if (!o) return { ok: true };
    library.release(id);
    toast('success', `Reunião liberada. Ela não depende mais do ${o.name}.`);
    return { ok: true };
  });

  // Sincronização entre computadores (pasta no Google Drive)
  ipcMain.handle('sync:presence', (_e, id) => library.setPresence(id));
  ipcMain.handle('sync:info', () => {
    const drive = S.findGoogleDrive();
    const driveTarget = drive ? path.join(drive, 'MeetRec - Reuniões') : null;
    return {
      root: library.root,
      cloud: S.cloudKind(library.root),
      drive,
      driveInstalled: !!drive || S.googleDriveInstalled(),
      driveTarget,
      driveCount: driveTarget && fs.existsSync(driveTarget) ? countMeetings(driveTarget) : 0,
      localCount: library.list().length,
      machine: library.machine.name,
      hostname: S.machineName(),
      ...library.syncState,
    };
  });
  ipcMain.handle('sync:migrate', async (_e, target, mode) => {
    if (rec.active) return { ok: false, error: 'Pare a gravação antes de trocar a pasta das gravações.' };
    if (pipeline.current || pipeline.queue.length) return { ok: false, error: 'Aguarde o processamento terminar antes de trocar a pasta das gravações.' };
    const from = library.root;
    library.syncPaused = true; // não relê a pasta antiga enquanto as reuniões estão saindo dela
    try {
      library.setPresence(null);
      const res = await migrateLibrary(from, target, mode, ({ done, total }) => send('sync-progress', { done, total }));
      store.set({ storageDir: target });
      // Regrava o contexto das pastas juntadas (atualiza GLOSSARIO.md/CONTEXTO.md com o conteúdo somado)
      for (const name of res.mergedFolders) { try { library.updateFolder(name, {}); } catch {} }
      return { ok: true, ...res };
    } catch (e) {
      // Algo deu errado no meio: o que já foi levado continua no destino; relê a pasta antiga
      library.load();
      library.emit('changed', null);
      return { ok: false, error: e.message };
    } finally { library.syncPaused = false; }
  });
  ipcMain.handle('pipe:status', () => pipeline.status());
  ipcMain.handle('pipe:ask', async (e, id, question) => {
    try {
      const text = await pipeline.ask(id, question, (full) => e.sender.send('evt', { type: 'ask-stream', payload: { id, text: full } }));
      return { ok: true, text };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // Diagnóstico
  ipcMain.handle('diag:run', () => runChecks({ store, bridge, detector, engine }));
  ipcMain.handle('diag:action', async (e, action) => {
    const log = (t) => e.sender.send('evt', { type: 'diag-log', payload: String(t) });
    try {
      if (action === 'install-engine') { const p = await engine.install(); return { ok: true, message: `Motor de transcrição instalado (${p.version} · faster-whisper ${p.fw}).` }; }
      if (action === 'download-model') {
        const py = await engine.find(store.get());
        if (!py) throw new Error('Instale o motor de transcrição primeiro.');
        await engine.ensureModel(store.get('localModel'), py.cmd);
        return { ok: true, message: 'Modelo baixado e pronto.' };
      }
      const setupAct = action.match(/^(install|login)-(claude|codex)$/);
      if (setupAct) {
        const [, what, eng] = setupAct;
        const custom = store.get(eng === 'codex' ? 'codexPath' : 'claudePath');
        if (what === 'install') {
          const st = await aiSetup[eng].install(custom);
          return { ok: true, message: `${CLIS[eng].name} ${st.version} instalado! Agora clique em "Entrar na conta".` };
        }
        const st = await aiSetup[eng].login(custom);
        return { ok: true, message: st.email ? `Conectado como ${st.email} ✅` : `Conta ${CLIS[eng].account} conectada ✅` };
      }
      if (action === 'open-storage') { shell.openPath(store.get('storageDir')); return { ok: true }; }
      const docs = action.match(/^open-(claude|codex)-docs$/);
      if (docs) { shell.openExternal(ENGINES[docs[1]].docs); return { ok: true }; }
      if (action === 'open-extension') { showMain({ view: 'settings', tab: 'integrations' }); return { ok: true }; }
      // Testa um motor específico (mesmo que não seja o escolhido); 'test-ai' testa o escolhido
      const test = action.match(/^test-(claude|codex|ai)$/);
      if (test) {
        const eng = test[1] === 'ai' ? engineOf(store.get()) : test[1];
        const E = ENGINES[eng];
        clearCache(); // pega um CLI instalado depois que o app abriu
        log(`Enviando mensagem de teste ao ${E.cli}…\n`);
        const r = await runAI({ prompt: 'Responda apenas: "Conexão OK ✅"', settings: { ...store.get(), aiEngine: eng }, onStatus: (m) => log(m + '\n') });
        log(`Resposta: ${r.text}\n`);
        return { ok: true, message: `${E.name} respondeu: ${r.text}` };
      }
      if (action === 'test-cloud') {
        const s = store.get();
        const url = 'https://api.openai.com/v1/models';
        const key = s.openaiKey;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
        if (!r.ok) throw new Error(r.status === 401 ? 'Chave inválida (401).' : `Resposta ${r.status}`);
        return { ok: true, message: 'Chave válida ✅' };
      }
      return { ok: false, message: 'Ação desconhecida' };
    } catch (err) {
      log(`\nErro: ${err.message}\n`);
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('bridge:status', () => bridge.status());

  // Primeiro uso sem terminal: motor de transcrição (Python + faster-whisper), modelo e Claude Code
  const modelOf = (id) => modelId(id || store.get('localModel'));
  ipcMain.handle('setup:catalog', () => ({ models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, desc: m.desc, size: m.size, recommended: !!m.recommended })), defaultModel: DEFAULT_MODEL }));
  ipcMain.handle('setup:engineStatus', async () => ({ found: await engine.find(store.get()), state: { ...engine.state, log: engine.log.slice(-6000) } }));
  ipcMain.handle('setup:engineInstall', async () => {
    try { return { ok: true, found: await engine.install() }; } catch (err) { return { ok: false, error: err.message, code: err.code }; }
  });
  ipcMain.handle('setup:engineCancel', () => engine.cancel());
  ipcMain.handle('setup:modelStatus', (_e, id) => engine.modelStatus(modelOf(id)));
  ipcMain.handle('setup:modelDownload', async (_e, id) => {
    try {
      const py = await engine.find(store.get());
      if (!py) return { ok: false, code: 'no-engine', error: 'Instale o motor de transcrição primeiro.' };
      await engine.ensureModel(modelOf(id), py.cmd);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message, code: err.code }; }
  });
  ipcMain.handle('setup:modelCancel', (_e, id) => engine.cancelModel(modelOf(id)));
  // Claude Code e Codex: mesmos canais, com o motor como primeiro argumento
  const cli = (eng) => aiSetup[eng === 'codex' ? 'codex' : 'claude'];
  const cliPath = (eng) => store.get(eng === 'codex' ? 'codexPath' : 'claudePath');
  ipcMain.handle('setup:aiStatus', (_e, eng) => cli(eng).status(cliPath(eng)));
  ipcMain.handle('setup:aiState', (_e, eng) => ({ engine: cli(eng).engine, ...cli(eng).state, log: cli(eng).log.slice(-6000) }));
  ipcMain.handle('setup:aiInstall', async (_e, eng) => {
    try { return { ok: true, status: await cli(eng).install(cliPath(eng)) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('setup:aiLogin', async (_e, eng) => {
    try { return { ok: true, auth: await cli(eng).login(cliPath(eng)) }; } catch (err) { return { ok: false, error: err.message, cancelled: !!err.cancelled }; }
  });
  ipcMain.handle('setup:aiCode', (_e, eng, code) => cli(eng).sendCode(code));
  ipcMain.handle('setup:aiCancel', (_e, eng) => cli(eng).cancel());

  // Atualização
  ipcMain.handle('update:status', () => updater.status);
  ipcMain.handle('update:check', () => updater.check(true));
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', () => installUpdate());

  // Somente desenvolvimento: captura de tela das janelas (apenas fora do instalador)
  if (!app.isPackaged) {
    ipcMain.handle('dev:capture', async (_e, which, file) => {
      const w = which === 'overlay' ? overlayWin : mainWin;
      if (which !== 'overlay') showMain();
      const img = await w.webContents.capturePage();
      fs.writeFileSync(file, img.toPNG());
      return file;
    });
    ipcMain.handle('dev:exec', (_e, code) => mainWin.webContents.executeJavaScript(code));
    ipcMain.handle('dev:emit', (_e, type, payload) => send(type, payload));
  }
  ipcMain.handle('detector:apps', () => detector.apps);
}

// ───────────────────────── Motor local (Python + faster-whisper) e Claude Code ─────────────────────────
function setupLocalEngine() {
  engine = new Engine(path.join(app.getPath('userData'), 'engine'), { script: resourcePath('python', 'transcribe.py') });
  configureLocal({ engine });
  aiSetup = { claude: new CliSetup('claude'), codex: new CliSetup('codex') };
  engine.on('state', (st) => send('engine-setup', st));
  engine.on('model-progress', (st) => send('model-progress', st));
  for (const s of Object.values(aiSetup)) s.on('state', (st) => send('ai-setup', st));
}

// ───────────────────────── Protocolo de mídia (com suporte a Range p/ busca no player) ─────────────────────────
function setupMediaProtocol() {
  protocol.handle('meetrec-media', (req) => {
    const u = new URL(req.url);
    const [, id, file] = u.pathname.split('/').map(decodeURIComponent);
    const fp = path.resolve(library.file(id, path.basename(file)));
    // Compara caminhos normalizados (a pasta pode estar salva com "/" ou "\")
    if (!fp.startsWith(path.resolve(library.root) + path.sep) || !fs.existsSync(fp)) return new Response('not found', { status: 404 });
    const size = fs.statSync(fp).size;
    const type = fp.endsWith('.webm') ? 'audio/webm' : fp.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream';
    const range = req.headers.get('range');
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      return new Response(Readable.toWeb(fs.createReadStream(fp, { start, end })), {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(fp)), { headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  });
}

// ───────────────────────── Ciclo de vida ─────────────────────────
async function quitApp() {
  if (rec.active) {
    const r = await dialog.showMessageBox({
      type: 'warning', buttons: ['Parar, salvar e sair', 'Cancelar'], defaultId: 0, cancelId: 1,
      title: 'Gravação em andamento', message: 'Há uma gravação em andamento.', detail: 'Ela será salva antes de fechar. O processamento continuará na próxima vez que você abrir o app.',
    });
    if (r.response !== 0) return;
    await stopRecording();
  } else if (pipeline.current) {
    const r = await dialog.showMessageBox({
      type: 'question', buttons: ['Sair mesmo assim', 'Cancelar'], defaultId: 1, cancelId: 1,
      title: 'Processamento em andamento', message: 'Uma reunião ainda está sendo transcrita/resumida.', detail: 'Se sair agora, você poderá processá-la novamente depois.',
    });
    if (r.response !== 0) return;
  }
  quitting = true;
  app.quit();
}

app.on('second-instance', (_e, argv) => showMain());
app.on('before-quit', (e) => {
  if (!quitting) { e.preventDefault(); quitApp(); }
});
app.on('activate', () => showMain());
app.on('window-all-closed', (e) => { /* fica na bandeja */ });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Deixa claro para o outro PC que nada mais está rodando aqui (senão ele espera o sinal de vida expirar)
  try { library?.recoverInterrupted(); library?.close(); } catch {}
  try { aiSetup?.claude.cancel(); aiSetup?.codex.cancel(); engine?.cancel(); } catch {}
});

app.whenReady().then(async () => {
  store = new Store();
  setupLocalEngine();
  extInfo = syncExtensionCopy();
  library = new Library(store, { workRoot: path.join(app.getPath('userData'), 'trabalho') });
  pipeline = new Pipeline(library, store);
  library.isLive = (id) => rec.id === id || pipeline.isBusy(id);
  bridge = new Bridge(store, app.getVersion());
  detector = new MeetingDetector();
  updater = new Updater();
  bridge.getRecording = () => rec.active;
  pipeline.isRecording = () => rec.active;

  // Permissões de mídia só para as janelas do próprio app
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture', 'clipboard-sanitized-write', 'notifications'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'display-capture', 'clipboard-sanitized-write'].includes(perm));
  // Áudio do sistema: getDisplayMedia → loopback (sem diálogo de seleção)
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return cb({});
      cb({ video: sources[0], audio: 'loopback' });
    }).catch(() => cb({}));
  }, { useSystemPicker: false });

  setupMediaProtocol();
  setupIpc();
  createTray();
  createRecorderWindow();
  createOverlay();

  const interrupted = library.recoverInterrupted();
  library.cleanWork();
  const startHidden = process.argv.includes('--hidden') || store.get('startHidden');
  createMainWindow(!startHidden);
  if (interrupted.length) {
    // Espera a janela terminar de carregar: um aviso enviado antes disso se perde
    const n = interrupted.length;
    const msg = n === 1 ? 'Uma gravação foi interrompida (o app fechou no meio) e o áudio foi recuperado. Você pode processá-la agora.' : `${n} gravações foram interrompidas (o app fechou no meio) e o áudio foi recuperado. Você pode processá-las agora.`;
    const show = () => setTimeout(() => toast('warn', msg, { duration: 15000, action: { label: 'Ver', route: { view: 'meeting', id: interrupted[0] } } }), 1200);
    if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', show); else show();
  }

  registerShortcuts();
  bridge.start();
  if (store.get('detectMeetings')) detector.start();
  app.setLoginItemSettings({ openAtLogin: !!store.get('launchAtLogin'), args: ['--hidden'] });

  // Eventos
  library.on('changed', (m) => { send('library', m ? { id: m.id, removed: m.removed } : null); updateTrayThrottled(); });
  library.on('folders', (p) => send('folders', p));
  library.on('presence', () => send('presence', null));
  pipeline.on('folder-draft', ({ name, kind }) => {
    toast('info', kind === 'new' ? `Montei o contexto da pasta "${name}" a partir da reunião. Confere?` : `O ${ENGINES[engineOf(store.get())].name} sugeriu atualizar o contexto da pasta "${name}".`,
      { duration: 12000, action: { label: 'Conferir', route: { view: 'folder', name } } });
  });
  pipeline.on('progress', (p) => { send('pipeline', p); updateTrayThrottled(); });
  pipeline.on('summary-stream', (p) => send('summary-stream', p));
  pipeline.on('start', ({ id }) => { send('pipeline-start', { id }); updateTray(); });
  pipeline.on('done', ({ id, meta }) => {
    send('pipeline-done', { id });
    toast('success', `Resumo pronto: ${meta.title}`, { action: { label: 'Abrir', route: { view: 'meeting', id } }, duration: 8000 });
    notify('Resumo pronto ✨', meta.title, () => showMain({ view: 'meeting', id }));
    if (overlayWin?.isVisible() && !rec.active) showOverlay('ready', { id, title: meta.title }, 6000);
    updateTray();
  });
  pipeline.on('failed', ({ id, error }) => {
    send('pipeline-failed', { id, error });
    toast('error', error, { duration: 12000, action: { label: 'Ver', route: { view: 'meeting', id } } });
    notify('Falha ao processar reunião', error, () => showMain({ view: 'meeting', id }));
    updateTray();
  });
  pipeline.on('cancelled', ({ id }) => {
    send('pipeline-failed', { id });
    toast('info', 'Processamento cancelado. A gravação continua salva — processe quando quiser.');
    updateTray();
  });
  bridge.on('status', (s) => send('bridge', s));
  bridge.on('events', onBridgeEvents);
  bridge.on('call', ({ inCall, platform, title }) => {
    if (!store.get('detectMeetings')) return;
    if (inCall && !rec.active) showOverlay('suggest', { app: platform, text: `Chamada detectada no ${platform}${title ? ` · ${title}` : ''}` }, 30000);
    if (!inCall && rec.active && store.get('autoStopSuggest')) showOverlay('suggest-stop', { text: `A chamada no ${platform} terminou` });
  });
  bridge.on('command', ({ action }) => {
    if (action === 'start') startRecording();
    else if (action === 'stop') stopRecording();
    else if (action === 'marker') addMarker();
    else if (action === 'toggle') (rec.active ? stopRecording() : startRecording());
  });
  detector.on('change', onMeetingAppsChange);
  updater.on('status', (st) => { send('update', st); updateTrayThrottled(); });
  updater.on('available', (st) => notify(`Nova versão do MeetRec: ${st.version}`,
    st.manual ? 'Clique para ver e baixar a nova versão.' : 'Clique para baixar e instalar — leva só um instante.',
    () => showMain()));
  updater.on('downloaded', (st) => {
    notify('Atualização pronta para instalar', `A versão ${st.version} será instalada ao reiniciar o MeetRec (ou quando você fechar o app).`, () => showMain());
    updateTray();
  });
  updater.on('up-to-date', (st) => toast('success', `Você está na versão mais recente (v${st.current}).`));
  updater.on('failed', (st) => toast('error', st.error, { duration: 9000 }));
  updater.start();
  store.on('change', (c) => {
    if (c.pythonPath !== undefined) engine.forget(); // procura o Python de novo
    send('settings', store.get());
    if (c.shortcutToggle !== undefined || c.shortcutMarker !== undefined) { const f = registerShortcuts(); if (!f.length) toast('success', 'Atalhos atualizados.'); }
    if (c.detectMeetings !== undefined) c.detectMeetings ? detector.start() : detector.stop();
    if (c.launchAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: !!c.launchAtLogin, args: ['--hidden'] });
    if (c.hideOverlayInShare !== undefined && overlayWin) overlayWin.setContentProtection(!!c.hideOverlayInShare);
    updateTray();
  });

  // Relógio do tray/overlay
  setInterval(() => { if (rec.active) { send('rec-tick', { elapsed: recTime(), paused: rec.paused }); updateTrayThrottled(); } }, 1000);
});

let trayTimer = null;
function updateTrayThrottled() {
  if (trayTimer) return;
  trayTimer = setTimeout(() => { trayTimer = null; updateTray(); }, 1000);
}
