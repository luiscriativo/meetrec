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
const { runChecks, installWhisper, downloadModel } = require('./diagnostics');
const { runClaude } = require('./claude');
const { ffmpegPath, run, resourcePath } = require('./tools');
const { fmtTime } = require('./speakers');

const isMac = process.platform === 'darwin';
const ROOT = path.join(__dirname, '..', '..');
const asset = (f) => path.join(ROOT, 'assets', f);
const page = (f) => path.join(ROOT, 'src', 'renderer', f);

if (isMac) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacCatapLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'win32') app.setAppUserModelId('com.luiscriativo.meetrec');

// Desenvolvimento: perfil separado (ex.: dados de demonstração para os prints do README)
const devProfile = !app.isPackaged && process.argv.find((a) => a.startsWith('--user-data='));
if (devProfile) app.setPath('userData', path.resolve(devProfile.slice('--user-data='.length)));

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

protocol.registerSchemesAsPrivileged([{ scheme: 'meetrec-media', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true, standard: true } }]);

let store, library, pipeline, bridge, detector, tray;
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
  const menu = Menu.buildFromTemplate([
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
  const meta = library.create({ platform, meetingTitle: opts.title || (st.inCall ? st.meetingTitle : null), participants: st.inCall ? st.participants : [] });
  if (opts.title || (st.inCall && st.meetingTitle)) library.update(meta.id, { title: opts.title || st.meetingTitle });

  rec.streams = {};
  for (const t of ['mic', 'system', 'mix']) rec.streams[t] = fs.createWriteStream(library.file(meta.id, `${t}.webm`));
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

// ───────────────────────── Importação / exportação ─────────────────────────
async function importAudio(filePath) {
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
  const meta = library.create({ source: 'import', status: 'processing', title: name, titleAuto: true, originalFile: 'original' + path.extname(filePath).toLowerCase() });
  try { fs.copyFileSync(filePath, library.file(meta.id, meta.originalFile)); } catch (e) {
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
  fs.appendFile(library.file(rec.id, 'events.jsonl'), lines, () => {});
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
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, extensionDir: resourcePath('extension'), userData: app.getPath('userData') }));
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
    };
  });
  ipcMain.handle('lib:update', (_e, id, patch) => {
    if (patch.title) patch.titleAuto = false;
    const m = library.update(id, patch);
    if (patch.speakerNames) {
      const tr = library.readJson(id, 'transcript.json');
      if (tr) library.writeText(id, 'transcript.txt', require('./speakers').transcriptToText(tr.segments, m.speakerNames));
    }
    return m;
  });
  ipcMain.handle('lib:saveSummary', (_e, id, text) => { library.writeText(id, 'summary.md', text); return true; });
  ipcMain.handle('lib:delete', async (_e, id) => {
    if (rec.id === id) return { ok: false, error: 'Pare a gravação antes de excluir.' };
    pipeline.cancel(id, { silent: true });
    try { await library.remove(id); } catch (e) { return { ok: false, error: e.message }; }
    toast('success', 'Reunião movida para a lixeira.');
    return { ok: true };
  });
  ipcMain.handle('lib:search', (_e, q) => library.search(q));
  ipcMain.handle('lib:openFolder', (_e, id) => shell.openPath(id ? library.dir(id) : library.root));
  ipcMain.handle('lib:export', (_e, id, kind) => exportItem(id, kind));
  ipcMain.handle('lib:import', (_e, p) => importAudio(p));
  ipcMain.handle('lib:mediaUrl', (_e, id) => {
    const m = library.get(id);
    return m?.audioFile ? `meetrec-media://rec/${encodeURIComponent(id)}/${encodeURIComponent(m.audioFile)}` : null;
  });

  // Pipeline
  ipcMain.handle('pipe:process', (_e, id, from) => {
    const ok = pipeline.enqueue(id, from || 'audio');
    if (!ok) toast('info', 'Esta reunião já está sendo processada.');
    return ok;
  });
  ipcMain.handle('pipe:cancel', (_e, id) => pipeline.cancel(id));
  ipcMain.handle('pipe:status', () => pipeline.status());
  ipcMain.handle('pipe:ask', async (e, id, question) => {
    try {
      const text = await pipeline.ask(id, question, (full) => e.sender.send('evt', { type: 'ask-stream', payload: { id, text: full } }));
      return { ok: true, text };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // Diagnóstico
  ipcMain.handle('diag:run', () => runChecks({ store, bridge, detector }));
  ipcMain.handle('diag:action', async (e, action) => {
    const log = (t) => e.sender.send('evt', { type: 'diag-log', payload: String(t) });
    try {
      if (action === 'install-whisper') { await installWhisper(store, log); return { ok: true, message: 'Motor local instalado!' }; }
      if (action === 'download-model') { await downloadModel(store, log); return { ok: true, message: 'Modelo baixado e pronto.' }; }
      if (action === 'open-storage') { shell.openPath(store.get('storageDir')); return { ok: true }; }
      if (action === 'open-python') { shell.openExternal('https://www.python.org/downloads/'); return { ok: true }; }
      if (action === 'open-claude-docs') { shell.openExternal('https://docs.claude.com/en/docs/claude-code/setup'); return { ok: true }; }
      if (action === 'open-extension') { showMain({ view: 'settings', tab: 'integrations' }); return { ok: true }; }
      if (action === 'test-claude') {
        log('Enviando mensagem de teste ao Claude Code…\n');
        const r = await runClaude({ prompt: 'Responda apenas: "Conexão OK ✅"', settings: store.get(), onStatus: (m) => log(m + '\n') });
        log(`Resposta: ${r.text}\n`);
        return { ok: true, message: `Claude respondeu: ${r.text}` };
      }
      if (action === 'test-cloud') {
        const s = store.get();
        const url = s.engine === 'groq' ? 'https://api.groq.com/openai/v1/models' : 'https://api.openai.com/v1/models';
        const key = s.engine === 'groq' ? s.groqKey : s.openaiKey;
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
  }
  ipcMain.handle('detector:apps', () => detector.apps);
}

// ───────────────────────── Protocolo de mídia (com suporte a Range p/ busca no player) ─────────────────────────
function setupMediaProtocol() {
  protocol.handle('meetrec-media', (req) => {
    const u = new URL(req.url);
    const [, id, file] = u.pathname.split('/').map(decodeURIComponent);
    const fp = library.file(id, path.basename(file));
    if (!fp.startsWith(library.root) || !fs.existsSync(fp)) return new Response('not found', { status: 404 });
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
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(async () => {
  store = new Store();
  library = new Library(store);
  pipeline = new Pipeline(library, store);
  bridge = new Bridge(store, app.getVersion());
  detector = new MeetingDetector();
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
  const startHidden = process.argv.includes('--hidden') || store.get('startHidden');
  createMainWindow(!startHidden);
  if (interrupted.length) setTimeout(() => toast('warn', `${interrupted.length} gravação(ões) foram interrompidas e recuperadas. Você pode processá-las agora.`, { duration: 10000, action: { label: 'Ver', route: { view: 'meeting', id: interrupted[0] } } }), 2500);

  registerShortcuts();
  bridge.start();
  if (store.get('detectMeetings')) detector.start();
  app.setLoginItemSettings({ openAtLogin: !!store.get('launchAtLogin'), args: ['--hidden'] });

  // Eventos
  library.on('changed', (m) => { send('library', m ? { id: m.id, removed: m.removed } : null); updateTrayThrottled(); });
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
  store.on('change', (c) => {
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
