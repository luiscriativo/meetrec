// Shell da aplicação: navegação, barra lateral, eventos globais.
import { state, ctx, api } from './ctx.js';
import { $, ic, esc, toast, modal, fmtTime, prettyShortcut, debounce, confirmDialog } from './util.js';
import * as Home from './views/home.js';
import * as Meeting from './views/meeting.js';
import * as Settings from './views/settings.js';
import * as Diagnostics from './views/diagnostics.js';

const VIEWS = { home: Home, meeting: Meeting, settings: Settings, diagnostics: Diagnostics };
let current = null;

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function navigate(route) {
  if (typeof route === 'string') route = { view: route };
  current?.destroy?.();
  state.route = route;
  const V = VIEWS[route.view] || Home;
  current = V;
  const view = $('#view');
  view.scrollTop = 0;
  view.innerHTML = '';
  $('#topbar').innerHTML = V.topbar ? V.topbar(route) : '';
  V.render(view, route);
  renderNav();
}

function renderNav() {
  const r = state.route.view;
  const items = [
    ['home', 'list', 'Reuniões', state.list.length || ''],
    ['import', 'upload', 'Importar áudio', ''],
    ['sep'],
    ['diagnostics', 'activity', 'Diagnóstico', ''],
    ['settings', 'settings', 'Configurações', ''],
  ];
  $('#nav').innerHTML = items.map(([id, icn, label, count]) => id === 'sep' ? '<div class="nav-sep"></div>'
    : `<button data-v="${id}" class="${r === id || (id === 'home' && r === 'meeting') ? 'active' : ''}">${ic(icn, 17)}${label}${count ? `<span class="count">${count}</span>` : ''}</button>`).join('');
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  if (b.dataset.v === 'import') return api.lib.importFile();
  navigate({ view: b.dataset.v });
});

// ───────── Botão de gravação da barra lateral ─────────
function renderRecCta() {
  const el = $('#recCta');
  const r = state.rec;
  if (r.active) {
    el.className = `rec-cta recording ${r.paused ? 'paused' : ''}`;
    el.innerHTML = `<span class="row" style="gap:10px"><span class="live-dot"></span><span><b id="ctaTimer" style="font-variant-numeric:tabular-nums">${fmtTime(r.elapsed)}</b> <span class="muted" style="font-weight:500">${r.stopping ? 'salvando…' : r.paused ? 'pausado' : 'gravando'}</span></span></span><span class="stop-sq" title="Parar">${ic('stop', 14)}</span>`;
    el.title = 'Clique para parar a gravação';
  } else {
    el.className = 'rec-cta';
    el.innerHTML = `${ic('record', 16)} Gravar reunião`;
    el.title = `Começar a gravar — microfone + som do computador (${prettyShortcut(state.settings.shortcutToggle)})`;
  }
}

$('#recCta').addEventListener('click', async (e) => {
  if (state.rec.active) {
    if (e.target.closest('.stop-sq') || true) await api.rec.stop();
  } else {
    const r = await api.rec.start();
    if (r?.ok) navigate({ view: 'home' });
  }
});

// ───────── Status na barra lateral ─────────
function renderSideStatus() {
  const h = state.health || [];
  const find = (id) => h.find((c) => c.id === id);
  const s = state.settings;
  const rows = [];

  const busyId = Object.keys(state.progress).find((id) => { const m = state.list.find((x) => x.id === id); return m?.status === 'processing'; });
  if (busyId) {
    const p = state.progress[busyId];
    const running = Object.entries(p).find(([, v]) => v.state === 'running');
    const labels = { audio: 'Preparando áudio', transcribe: 'Transcrevendo', speakers: 'Falantes', summary: 'Resumindo' };
    rows.push(`<button class="stat" data-go="meeting" data-id="${busyId}"><span class="led busy"></span>${running ? labels[running[0]] : 'Processando'}<span class="val">${running && running[1].progress ? Math.round(running[1].progress * 100) + '%' : '…'}</span></button>`);
  }

  const claude = find('claude');
  rows.push(`<button class="stat" data-go="diagnostics"><span class="led ${claude ? claude.state : ''}"></span>Claude Code<span class="val">${claude ? (claude.state === 'ok' ? 'conectado' : 'verificar') : '…'}</span></button>`);
  const eng = find('whisper') || find('cloudkey') || find('python');
  const engName = s.engine === 'local' ? 'Whisper local' : s.engine === 'groq' ? 'Groq' : 'OpenAI';
  rows.push(`<button class="stat" data-go="diagnostics"><span class="led ${eng ? eng.state : ''}"></span>Transcrição<span class="val">${esc(engName)}</span></button>`);
  const b = state.bridge;
  rows.push(`<button class="stat" data-go="settings" data-tab="integrations"><span class="led ${b.error ? 'error' : b.connected ? 'ok' : ''}"></span>Extensão<span class="val">${b.connected ? (b.inCall ? `em chamada · ${esc(b.platform || '')}` : 'conectada') : 'desconectada'}</span></button>`);
  if (state.detectorApps.length) rows.push(`<div class="stat"><span class="led warn"></span>Mic em uso<span class="val">${esc(state.detectorApps.join(', '))}</span></div>`);
  $('#sideStatus').innerHTML = `<div class="title">Status</div>${rows.join('')}`;
}

$('#sideStatus').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (!b) return;
  navigate({ view: b.dataset.go, id: b.dataset.id, tab: b.dataset.tab });
});

// ───────── Atualização (banner no topo, no modelo do Tecius) ─────────
let updateDismissed = null; // versão cujo aviso foi fechado nesta sessão

function fmtSpeed(bps) {
  if (!bps) return '';
  return bps > 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`;
}

function renderUpdate() {
  const u = state.update || {};
  const box = $('#updateBanner');
  const hasUpdate = ['available', 'downloading', 'downloaded'].includes(u.state);
  $('#ver').innerHTML = `${hasUpdate ? '<span class="upd-dot"></span>' : ''}v${esc(state.info.version || '')}`;
  $('#ver').title = hasUpdate ? `Nova versão ${u.version} disponível` : 'Versão do app — clique para verificar atualizações';
  const show = (hasUpdate || (u.state === 'error' && u.userFacing)) && updateDismissed !== `${u.state}:${u.version}`;
  if (!show) { box.innerHTML = ''; return; }
  const notes = u.version ? `<a data-act="notes">Ver novidades</a>` : '';
  let cls = '', icn = 'download', title = '', sub = '', actions = '', bar = '';
  if (u.state === 'available') {
    title = `Nova versão disponível: v${esc(u.version)}`;
    sub = u.manual
      ? `${state.info.platform === 'darwin' ? 'No Mac, a atualização é feita baixando o novo .dmg.' : 'Esta instalação não se atualiza sozinha — baixe o novo instalador.'} · ${notes}`
      : `Você está na v${esc(u.current)}. O download é feito aqui mesmo e não interrompe nada. · ${notes}`;
    actions = `<button class="btn primary sm" data-act="download">${ic(u.manual ? 'external' : 'download', 13)} ${u.manual ? 'Baixar no site' : 'Baixar atualização'}</button>`;
  } else if (u.state === 'downloading') {
    icn = 'loader';
    title = `Baixando a versão ${esc(u.version)}… ${u.percent || 0}%`;
    sub = [u.total ? `${(u.transferred / 1e6).toFixed(1)} de ${(u.total / 1e6).toFixed(1)} MB` : '', fmtSpeed(u.bytesPerSecond)].filter(Boolean).join(' · ') || 'Iniciando o download…';
    bar = `<div class="bar"><i style="width:${u.percent || 0}%"></i></div>`;
  } else if (u.state === 'downloaded') {
    cls = 'ready'; icn = 'checkCircle';
    title = `Versão ${esc(u.version)} pronta para instalar`;
    sub = `Reinicie agora ou ela será instalada quando você fechar o MeetRec. · ${notes}`;
    actions = `<button class="btn primary sm" data-act="install">${ic('refresh', 13)} Reiniciar e instalar</button>`;
  } else if (u.state === 'error') {
    cls = 'err'; icn = 'alertCircle';
    title = 'Não foi possível atualizar';
    sub = esc(u.error || '');
    actions = `<button class="btn sm" data-act="retry">${ic('refresh', 13)} Tentar de novo</button>`;
  }
  box.innerHTML = `<div class="update-banner ${cls}">${bar}<div class="in">
    <span class="ico">${ic(icn, 16, icn === 'loader' ? 'spin' : '')}</span>
    <div class="grow"><div class="t">${title}</div><div class="s">${sub}</div></div>
    ${actions}
    ${u.state !== 'downloading' ? `<button class="btn icon sm ghost" data-act="dismiss" title="Fechar">${ic('x', 14)}</button>` : ''}
  </div></div>`;
}

$('#updateBanner').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const u = state.update;
  const act = b.dataset.act;
  if (act === 'dismiss') { updateDismissed = `${u.state}:${u.version}`; renderUpdate(); }
  else if (act === 'notes') api.open(u.notesUrl || `https://github.com/luiscriativo/meetrec/releases/tag/v${u.version}`);
  else if (act === 'download') {
    await api.update.download();
    if (u.manual) { updateDismissed = `${u.state}:${u.version}`; renderUpdate(); toast('info', 'Abri a página da nova versão no navegador.'); }
  } else if (act === 'retry') {
    state.update = { ...u, userFacing: false };
    if (u.version) await api.update.download(); else await api.update.check();
  } else if (act === 'install') {
    if (state.rec.active) return toast('warn', 'Pare a gravação antes de instalar a atualização.');
    const busy = state.list.some((m) => m.status === 'processing');
    if (busy && !(await confirmDialog('Instalar agora?', 'Uma reunião está sendo transcrita/resumida. Ao reiniciar, o processamento é interrompido e você pode refazê-lo depois.', 'Reiniciar e instalar'))) return;
    toast('info', 'Fechando o MeetRec para instalar a atualização…');
    const r = await api.update.install();
    if (!r?.ok && r?.error !== 'recording') toast('error', 'A atualização ainda não está pronta para instalar.');
  }
});

$('#ver').addEventListener('click', () => navigate({ view: 'settings', tab: 'general' }));

ctx.navigate = navigate;
ctx.refreshSidebar = () => { renderNav(); renderSideStatus(); renderRecCta(); };
ctx.reloadList = async () => { state.list = await api.lib.list(); renderNav(); renderSideStatus(); };
ctx.runHealth = async () => { state.health = await api.diag.run(); renderSideStatus(); current?.onEvent?.('health'); return state.health; };

const reloadListDebounced = debounce(async () => { await ctx.reloadList(); current?.onEvent?.('list-reloaded'); }, 200);

// ───────── Eventos do processo principal ─────────
api.on((type, p) => {
  switch (type) {
    case 'toast': {
      const opts = { duration: p.duration };
      if (p.action) opts.action = { label: p.action.label, onClick: () => p.action.route ? navigate(p.action.route) : p.action.reveal && api.reveal(p.action.reveal) };
      toast(p.kind, p.message, opts);
      break;
    }
    case 'navigate': navigate(p); break;
    case 'library': reloadListDebounced(); break;
    case 'rec-state':
      if (!p.active) state.recWarnings = [];
      state.rec = p; renderRecCta(); break;
    case 'rec-tick': {
      state.rec.elapsed = p.elapsed;
      const t = $('#ctaTimer'); if (t) t.textContent = fmtTime(p.elapsed);
      break;
    }
    case 'levels': state.levels = p; break;
    case 'rec-warning': state.recWarnings = [p, ...state.recWarnings.filter((w) => w.key !== p.key || !p.key)].slice(0, 6); break;
    case 'pipeline': {
      state.progress[p.id] = state.progress[p.id] || {};
      state.progress[p.id][p.step] = { ...(state.progress[p.id][p.step] || {}), ...p };
      renderSideStatus();
      break;
    }
    case 'pipeline-start': state.summaryStream[p.id] = ''; reloadListDebounced(); break;
    case 'pipeline-done': case 'pipeline-failed': delete state.progress[p.id]; delete state.summaryStream[p.id]; reloadListDebounced(); break;
    case 'summary-stream': state.summaryStream[p.id] = p.text; break;
    case 'bridge': state.bridge = p; renderSideStatus(); break;
    case 'detector': state.detectorApps = p.apps; renderSideStatus(); break;
    case 'settings': state.settings = p; applyTheme(); renderRecCta(); renderSideStatus(); break;
    case 'update':
      // Erros só viram banner quando o usuário pediu a ação (os da checagem automática são silenciosos)
      state.update = { ...p, userFacing: p.state === 'error' ? true : undefined };
      renderUpdate();
      break;
  }
  current?.onEvent?.(type, p);
});

// ───────── Arrastar e soltar um áudio/vídeo para importar ─────────
const MEDIA_EXT = /\.(mp3|wav|m4a|mp4|webm|ogg|opus|mkv|mov|aac|flac|wma)$/i;
document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  const media = files.map((f) => api.pathForFile(f)).filter((p) => p && MEDIA_EXT.test(p));
  if (!media.length) { toast('warn', 'Solte um arquivo de áudio ou vídeo (mp3, m4a, wav, mp4…) para importar.'); return; }
  for (const p of media) await api.lib.importFile(p);
});

// ───────── Boas-vindas (primeira execução) ─────────
function onboarding() {
  const health = state.health || [];
  const row = (c) => `<div class="onb-step"><span class="n" style="background:${c.state === 'ok' ? 'var(--ok)' : c.state === 'error' ? 'var(--rec)' : 'var(--warn)'}">${ic(c.state === 'ok' ? 'check' : c.state === 'error' ? 'x' : 'alert', 14)}</span><div class="grow"><b>${esc(c.label)}</b><div class="muted" style="font-size:12px">${esc(c.detail)}</div></div></div>`;
  const important = health.filter((c) => ['claude', 'whisper', 'python', 'cloudkey', 'sysaudio'].includes(c.id));
  modal({
    title: 'Bem-vindo ao MeetRec 👋',
    wide: true,
    body: `<p class="muted" style="line-height:1.55;margin:4px 0 14px">Grave reuniões do Teams, Meet, Zoom ou qualquer app: o MeetRec capta <b>sua voz</b> e o <b>som do computador</b>, transcreve e o <b>Claude Code</b> escreve o resumo no estilo Notion.</p>
      <label style="font-weight:600;font-size:13px">Como você quer ser chamado nas transcrições?</label>
      <input class="input" id="onbName" placeholder="Seu nome (ex.: Luis)" style="margin-top:8px" value="${esc(state.settings.userName || '')}">
      <div class="onb-steps">${important.map(row).join('')}</div>
      <p class="muted" style="font-size:12.5px;margin-top:14px">Dica: depois, veja <b>Diagnóstico</b> para instalar o que faltar com um clique, e <b>Configurações → Integrações</b> para identificar quem fala no Teams pelo navegador.</p>`,
    actions: [
      { label: `${ic('activity', 15)} Abrir diagnóstico`, onClick: async (m) => { await api.setSettings({ userName: m.querySelector('#onbName').value.trim(), onboarded: true }); navigate('diagnostics'); } },
      { label: 'Começar', kind: 'primary', onClick: async (m) => { await api.setSettings({ userName: m.querySelector('#onbName').value.trim(), onboarded: true }); toast('success', 'Tudo pronto! Clique em "Gravar reunião" quando quiser.'); } },
    ],
  });
}

// ───────── Inicialização ─────────
(async () => {
  const [settings, info, list, rec, bridge, apps, pipe, update] = await Promise.all([
    api.getSettings(), api.appInfo(), api.lib.list(), api.rec.state(), api.bridgeStatus(), api.detectorApps(), api.pipe.status(), api.update.status(),
  ]);
  Object.assign(state, { settings, info, list, rec, bridge, detectorApps: apps, update });
  if (pipe.current) state.progress[pipe.current.id] = {};
  document.documentElement.classList.add(`platform-${info.platform}`);
  $('#logo').innerHTML = ic('waves', 15);
  renderUpdate();
  applyTheme();
  renderRecCta();
  renderSideStatus();
  navigate(rec.active ? { view: 'home' } : { view: 'home' });
  await ctx.runHealth();
  if (!state.settings.onboarded) onboarding();
})();
