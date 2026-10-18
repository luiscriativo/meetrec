// Ponte segura entre as janelas e o processo principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Set();
ipcRenderer.on('evt', (_e, msg) => { for (const fn of listeners) { try { fn(msg.type, msg.payload); } catch (err) { console.error(err); } } });

const inv = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },

  appInfo: inv('app:info'),
  getSettings: inv('settings:get'),
  setSettings: inv('settings:set'),
  pickFolder: inv('dialog:pickFolder'),
  pickFile: inv('dialog:pickFile'),
  open: inv('shell:open'),
  reveal: inv('shell:reveal'),
  copy: inv('clipboard:write'),
  showMain: (route) => ipcRenderer.send('window:show-main', route),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },

  rec: {
    start: inv('rec:start'),
    stop: inv('rec:stop'),
    pause: inv('rec:pause'),
    marker: inv('rec:marker'),
    state: inv('rec:state'),
    notes: inv('rec:notes'),
  },

  lib: {
    list: inv('lib:list'),
    get: inv('lib:get'),
    update: inv('lib:update'),
    saveSummary: inv('lib:saveSummary'),
    remove: inv('lib:delete'),
    search: inv('lib:search'),
    openFolder: inv('lib:openFolder'),
    exportItem: inv('lib:export'),
    importFile: inv('lib:import'),
    mediaUrl: inv('lib:mediaUrl'),
    move: inv('lib:move'),
    resolveDoubt: inv('lib:resolveDoubt'),
    release: inv('lib:release'),
  },

  sync: {
    info: inv('sync:info'),
    migrate: inv('sync:migrate'),
    presence: inv('sync:presence'),
  },

  pipe: {
    process: inv('pipe:process'),
    cancel: inv('pipe:cancel'),
    status: inv('pipe:status'),
    ask: inv('pipe:ask'),
  },

  folders: {
    list: inv('folder:list'),
    get: inv('folder:get'),
    create: inv('folder:create'),
    rename: inv('folder:rename'),
    remove: inv('folder:delete'),
    update: inv('folder:update'),
    addTerm: inv('folder:addTerm'),
    approveDraft: inv('folder:approveDraft'),
    discardDraft: inv('folder:discardDraft'),
    bootstrap: inv('folder:bootstrap'),
    slim: inv('folder:slim'),
    approveSlim: inv('folder:approveSlim'),
    discardSlim: inv('folder:discardSlim'),
    open: inv('folder:open'),
  },

  diag: { run: inv('diag:run'), action: inv('diag:action') },
  setup: {
    catalog: inv('setup:catalog'),
    modelStatus: inv('setup:modelStatus'),
    modelDownload: inv('setup:modelDownload'),
    modelCancel: inv('setup:modelCancel'),
    modelCleanup: inv('setup:modelCleanup'),
    claudeStatus: inv('setup:claudeStatus'),
    claudeState: inv('setup:claudeState'),
    claudeInstall: inv('setup:claudeInstall'),
    claudeLogin: inv('setup:claudeLogin'),
    claudeCode: inv('setup:claudeCode'),
    claudeCancel: inv('setup:claudeCancel'),
  },
  update: { status: inv('update:status'), check: inv('update:check'), download: inv('update:download'), install: inv('update:install') },
  bridgeStatus: inv('bridge:status'),
  ext: { sync: inv('ext:sync') },
  detectorApps: inv('detector:apps'),

  // Usado pela janela de gravação (oculta)
  recorder: {
    started: (data) => ipcRenderer.send('rec:started', data),
    stopped: (seq) => ipcRenderer.send('rec:stopped', { seq }),
    chunk: (track, data) => ipcRenderer.send('rec:chunk', { track, data }),
    levels: (lv) => ipcRenderer.send('rec:levels', lv),
    warning: (w) => ipcRenderer.send('rec:warning', w),
    trackEnded: (track, message) => ipcRenderer.send('rec:track-ended', { track, message }),
  },

  dev: { capture: inv('dev:capture'), exec: inv('dev:exec'), emit: inv('dev:emit') },

  overlay: {
    action: (a) => ipcRenderer.send('overlay:action', a),
    resize: (h) => ipcRenderer.send('overlay:resize', h),
  },
});
