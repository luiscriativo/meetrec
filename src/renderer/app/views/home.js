// Tela inicial: gravação ao vivo (ou botão de gravar) + biblioteca de reuniões.
import { state, ctx, api } from '../ctx.js';
import { $, $$, ic, esc, fmtTime, fmtDuration, fmtDate, dayGroup, prettyShortcut, colorFor, initials, debounce, toast } from '../util.js';

let root = null;
let filterIds = null;
let query = '';
let hist = { mic: [], system: [] };
let raf = null;
let markers = [];
let devices = { mic: null };
let folder; // undefined = todas · '' = sem pasta · nome da pasta

const STEP_LABEL = { audio: 'Preparando áudio', transcribe: 'Transcrevendo', speakers: 'Identificando falantes', summary: 'Gerando resumo' };
const DRAG_TYPE = 'application/x-meetrec-id';

const folderLabel = (f) => (f === undefined ? 'Reuniões' : f === '' ? 'Sem pasta' : f);

export function topbar(route = {}) {
  const f = route.folder;
  return `${f !== undefined ? `<span class="crumb" id="crumbAll">${ic('chevronLeft', 16)} Reuniões</span><span class="muted">/</span>` : ''}<h1>${f ? ic('folder', 16) : ''}${esc(folderLabel(f))}</h1>
    <div class="grow"></div>
    <div class="search no-drag" style="width:280px">${ic('search', 15)}<input class="input" id="q" placeholder="${f ? `Buscar em “${esc(f)}”…` : 'Buscar em títulos, transcrições e resumos…'}" value="${esc(query)}"></div>
    <button class="btn no-drag" id="impBtn" title="Transcrever um arquivo de áudio/vídeo existente${f ? ` (vai para a pasta “${esc(f)}”)` : ''}">${ic('upload', 15)} Importar</button>`;
}

export function render(el, route = {}) {
  root = el;
  folder = route.folder;
  // A pasta que você está vendo é onde a próxima gravação será salva
  if (folder !== undefined && (state.settings.recordFolder || '') !== folder) api.setSettings({ recordFolder: folder });
  el.innerHTML = `<div class="view-inner"><div id="folderArea"></div><div id="liveArea"></div><div id="listArea"></div></div>`;
  $('#q').oninput = debounce(async (e) => {
    query = e.target.value;
    filterIds = query.trim() ? new Set(await api.lib.search(query)) : null;
    renderList();
  }, 250);
  $('#impBtn').onclick = () => api.lib.importFile(null, folder);
  if ($('#crumbAll')) $('#crumbAll').onclick = () => ctx.navigate({ view: 'home' });
  loadDevices();
  renderFolderHead();
  renderLive();
  renderList();
}

// ───────── Cabeçalho da pasta (contexto, glossário, histórico) ─────────
function renderFolderHead() {
  const area = $('#folderArea');
  if (!area) return;
  const f = folder ? state.folders.find((x) => x.name === folder) : null;
  if (!f) { area.innerHTML = ''; return; }
  const status = f.hasDraft
    ? `<span class="chip warn">${ic('sparkles', 11)} Contexto sugerido — confira</span>`
    : f.hasContext ? `<span class="chip ok">${ic('check', 11)} Contexto aprovado</span>`
      : `<span class="chip">${ic('clock', 11)} Contexto será montado após a 1ª reunião</span>`;
  area.innerHTML = `<div class="card folder-head ${f.hasDraft ? 'attn' : ''}">
    <div class="fh-ico">${ic('folder', 22)}</div>
    <div class="grow">
      <div class="fh-desc">${f.description ? esc(f.description) : '<span class="muted">Reuniões desta pasta compartilham contexto, glossário e histórico.</span>'}</div>
      <div class="fh-meta">${status}
        <span class="chip">${ic('book', 11)} ${f.glossary} ${f.glossary === 1 ? 'termo' : 'termos'} no glossário</span>
        ${f.hasHistory ? `<span class="chip">${ic('history', 11)} Histórico ativo</span>` : ''}
      </div>
    </div>
    <button class="btn ${f.hasDraft ? 'primary' : ''}" id="openCtx">${ic(f.hasDraft ? 'sparkles' : 'brain', 15)} ${f.hasDraft ? 'Conferir contexto' : 'Contexto da pasta'}</button>
  </div>`;
  $('#openCtx').onclick = () => ctx.navigate({ view: 'folder', name: folder });
}

function folderSelectHtml() {
  const cur = state.settings.recordFolder || '';
  const valid = !cur || state.folders.some((f) => f.name === cur);
  return `<label class="save-in" title="Pasta onde a gravação será salva — o Claude usa o contexto dela no resumo">${ic('folder', 13)} Salvar em
    <select class="select" id="saveIn"><option value="" ${!cur || !valid ? 'selected' : ''}>Sem pasta</option>${state.folders.map((f) => `<option value="${esc(f.name)}" ${f.name === cur ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}<option value="__new">+ Nova pasta…</option></select></label>`;
}

function bindFolderSelect() {
  const s = $('#saveIn');
  if (!s) return;
  s.onchange = async () => {
    let v = s.value;
    if (v === '__new') {
      const { createFolderDialog } = await import('../folders-ui.js');
      v = await createFolderDialog();
      if (v == null) { s.value = state.settings.recordFolder || ''; return; }
    }
    await api.setSettings({ recordFolder: v });
    toast('info', v ? `As próximas gravações vão para a pasta “${v}”.` : 'As próximas gravações ficam em “Sem pasta”.');
  };
}

export function destroy() { cancelAnimationFrame(raf); raf = null; root = null; }

async function loadDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const mics = list.filter((d) => d.kind === 'audioinput');
    const sel = mics.find((d) => d.deviceId === state.settings.micDeviceId) || mics.find((d) => d.deviceId === 'default') || mics[0];
    devices.mic = sel ? (sel.label || 'Microfone padrão').replace(/^Padrão - |^Default - /, '') : null;
    devices.count = mics.length;
  } catch { devices.mic = null; }
  if (!state.rec.active) renderLive();
}

// ───────── Área de gravação ─────────
async function renderLive() {
  const area = $('#liveArea');
  if (!area) return;
  const r = state.rec;
  cancelAnimationFrame(raf); raf = null;
  if (!r.active) {
    const s = state.settings;
    const health = state.health || [];
    const claude = health.find((c) => c.id === 'claude');
    const engName = s.engine === 'local' ? `Whisper local · ${s.localModel}` : s.engine === 'groq' ? 'Groq Whisper' : 'OpenAI Whisper';
    const sugg = suggestionHtml();
    area.innerHTML = `
      <div class="card hero">
        <div style="z-index:1">
          <h2>Pronto para gravar</h2>
          <p>O MeetRec grava <b>sua voz</b> e <b>tudo que toca no computador</b> (as pessoas da reunião), seja no navegador, no Teams, Zoom ou Meet. Ao parar, transcreve e o Claude Code gera o resumo.</p>
          <div class="sources">
            <span class="chip ${devices.mic ? 'accent' : 'err'}" title="Microfone">${ic('mic', 13)} ${esc(devices.mic || 'Nenhum microfone')}</span>
            <span class="chip ${s.captureSystem ? 'ok' : ''}" title="Som do computador">${ic('speaker', 13)} ${s.captureSystem ? 'Som do PC ativado' : 'Som do PC desativado'}</span>
            <span class="chip">${ic('waves', 13)} ${esc(engName)}</span>
            <span class="chip ${claude ? (claude.state === 'ok' ? 'ok' : 'err') : ''}">${ic('sparkles', 13)} Claude ${claude ? (claude.state === 'ok' ? 'pronto' : 'indisponível') : '…'}</span>
          </div>
          ${folderSelectHtml()}
          <div id="sugg">${sugg}</div>
        </div>
        <div class="hero-side">
          <button class="big-rec" id="bigRec" title="Começar a gravar">${ic('mic', 36)}</button>
          <span class="muted" style="font-size:12px">ou <span class="kbd">${esc(prettyShortcut(s.shortcutToggle))}</span></span>
        </div>
      </div>`;
    $('#bigRec').onclick = () => api.rec.start();
    bindSugg();
    bindFolderSelect();
    return;
  }

  const meta = r.id ? (await api.lib.get(r.id))?.meta : null;
  markers = meta?.markers || [];
  const started = r.startedAt ? new Date(r.startedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  area.innerHTML = `
    <div class="card live">
      <div class="live-head ${r.paused ? 'paused' : ''}" id="liveHead">
        <span class="big-dot"></span>
        <div class="live-timer" id="liveTimer">${fmtTime(r.elapsed)}</div>
        <div class="grow" style="margin-left:6px">
          <input class="live-title" id="liveTitle" value="${esc(meta?.title || 'Reunião')}" title="Clique para renomear">
          <div class="muted" style="font-size:12.5px;display:flex;gap:10px;flex-wrap:wrap;margin-top:2px">
            <span>${r.starting ? 'Iniciando — conectando ao microfone e ao som do PC…' : `${r.stopping ? 'Salvando…' : r.paused ? 'Pausado' : 'Gravando'} desde ${started}`}</span>
            ${meta?.platform ? `<span>· ${esc(meta.platform)}</span>` : ''}
            ${meta?.folder ? `<span title="O resumo vai usar o contexto desta pasta">· ${ic('folder', 12)} ${esc(meta.folder)}</span>` : ''}
            <span class="chip ${r.tracks?.mic ? 'accent' : 'err'}" style="height:20px">${ic(r.tracks?.mic ? 'mic' : 'micOff', 12)} ${r.tracks?.mic ? 'Microfone' : 'Sem microfone'}</span>
            <span class="chip ${r.tracks?.system ? 'ok' : 'err'}" style="height:20px">${ic('speaker', 12)} ${r.tracks?.system ? 'Som do PC' : 'Sem som do PC'}</span>
          </div>
        </div>
        <div class="live-actions">
          <button class="btn" id="lvMarker" ${r.starting ? 'disabled' : ''} title="Marcar momento importante (${esc(prettyShortcut(state.settings.shortcutMarker))})">${ic('flag', 15)} Marcar</button>
          <button class="btn" id="lvPause" ${r.starting ? 'disabled' : ''}>${ic(r.paused ? 'play' : 'pause', 15)} ${r.paused ? 'Retomar' : 'Pausar'}</button>
          <button class="btn rec" id="lvStop" ${r.stopping ? 'disabled' : ''}>${ic('stop', 14)} Parar e resumir</button>
        </div>
      </div>
      <div id="speakingNow" style="margin-top:12px"></div>
      <canvas class="wave" id="wave"></canvas>
      <div class="legend">
        <span><i style="background:#8B6DFF"></i>Você (microfone)${r.tracks?.micLabel ? ` · <span class="muted">${esc(r.tracks.micLabel)}</span>` : ''}</span>
        <span><i style="background:#34D399"></i>Participantes (som do computador)</span>
      </div>
      <div id="liveWarnings" style="margin-top:12px"></div>
      <div class="live-grid">
        <div>
          <div class="section-title" style="margin-top:0">${ic('note', 14)} Anotações <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">— o Claude considera no resumo</span></div>
          <textarea class="textarea" id="liveNotes" rows="6" placeholder="Ex.: decidir orçamento até sexta; perguntar à Ana sobre o contrato…">${esc(meta?.notes || '')}</textarea>
          <div class="muted" id="notesSaved" style="font-size:11.5px;margin-top:4px;height:14px"></div>
        </div>
        <div>
          <div class="section-title" style="margin-top:0">${ic('flag', 14)} Momentos marcados</div>
          <div class="marker-list" id="markers"></div>
          <div class="row" style="margin-top:8px"><input class="input" id="markerLabel" placeholder="Descreva o momento (opcional)" style="height:32px"><button class="btn sm" id="markerAdd">${ic('flag', 13)}</button></div>
        </div>
      </div>
    </div>`;
  renderMarkers();
  renderSpeaking();
  renderWarnings();
  $('#lvStop').onclick = () => api.rec.stop();
  $('#lvPause').onclick = () => api.rec.pause();
  $('#lvMarker').onclick = () => api.rec.marker('');
  const addMarker = () => { const i = $('#markerLabel'); api.rec.marker(i.value.trim()); i.value = ''; };
  $('#markerAdd').onclick = addMarker;
  $('#markerLabel').onkeydown = (e) => { if (e.key === 'Enter') addMarker(); };
  $('#liveTitle').onchange = (e) => { if (r.id && e.target.value.trim()) api.lib.update(r.id, { title: e.target.value.trim() }).then(() => toast('success', 'Título atualizado.')); };
  const saveNotes = debounce(async (v) => { await api.rec.notes(v); const s = $('#notesSaved'); if (s) s.textContent = 'Salvo ✓'; }, 600);
  $('#liveNotes').oninput = (e) => { const s = $('#notesSaved'); if (s) s.textContent = 'Salvando…'; saveNotes(e.target.value); };
  startWave();
}

function suggestionHtml() {
  const b = state.bridge;
  if (b.connected && b.inCall) return `<div class="suggest">${ic('users', 18)}<div class="grow"><b>Chamada em andamento no ${esc(b.platform)}</b>${b.meetingTitle ? `<div class="muted" style="font-size:12.5px">${esc(b.meetingTitle)}</div>` : ''}</div><button class="btn primary sm" data-rec>${ic('record', 11)} Gravar agora</button></div>`;
  if (state.detectorApps.length) return `<div class="suggest">${ic('mic', 18)}<div class="grow"><b>${esc(state.detectorApps.join(', '))}</b> está usando o microfone agora. É uma reunião?</div><button class="btn primary sm" data-rec>${ic('record', 11)} Gravar agora</button></div>`;
  return '';
}

function bindSugg() { $$('[data-rec]').forEach((b) => (b.onclick = () => api.rec.start())); }

function renderMarkers() {
  const el = $('#markers');
  if (!el) return;
  el.innerHTML = markers.length ? markers.map((m) => `<div class="marker-item"><span class="t">${fmtTime(m.t)}</span>${esc(m.label || 'Momento importante')}</div>`).join('')
    : `<div class="muted" style="font-size:12.5px">Nenhum ainda. Use <span class="kbd">${esc(prettyShortcut(state.settings.shortcutMarker))}</span> a qualquer momento.</div>`;
}

function renderSpeaking() {
  const el = $('#speakingNow');
  if (!el) return;
  const b = state.bridge;
  if (b.connected && b.inCall && b.speaking?.length) {
    el.innerHTML = `<span class="speaking-now"><span class="eq"><i></i><i></i><i></i></span>${esc(b.speaking.join(', '))} falando</span>`;
  } else if (b.connected && b.inCall) {
    el.innerHTML = `<span class="chip ok">${ic('plug', 12)} ${esc(b.platform)} conectado${b.captionsActive ? ' · legendas ativas ✓' : ' · ative as legendas para identificar nomes'}</span>`;
  } else el.innerHTML = '';
}

function renderWarnings() {
  const el = $('#liveWarnings');
  if (!el) return;
  el.innerHTML = state.recWarnings.filter((w) => w.level !== 'ok').slice(0, 3).map((w) => `<div class="banner ${w.level === 'error' ? 'err' : w.level === 'info' ? 'info' : 'warn'}">${ic(w.level === 'error' ? 'alertCircle' : 'alert', 16)}<span>${esc(w.message)}</span></div>`).join('');
}

function startWave() {
  const cv = $('#wave');
  if (!cv) return;
  const draw = () => {
    if (!root || !cv.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const bw = 3, gap = 2, n = Math.floor(w / (bw + gap));
    const mid = h / 2;
    const draw1 = (arr, color, dir) => {
      g.fillStyle = color;
      const start = Math.max(0, arr.length - n);
      for (let i = start; i < arr.length; i++) {
        const x = (i - start) * (bw + gap) + (n - (arr.length - start)) * (bw + gap);
        const v = Math.max(0.03, arr[i]);
        const bh = Math.max(1.5, v * (mid - 6));
        g.globalAlpha = 0.35 + 0.65 * ((i - start) / Math.max(1, arr.length - start));
        if (dir < 0) g.fillRect(x, mid - bh - 1, bw, bh); else g.fillRect(x, mid + 1, bw, bh);
      }
      g.globalAlpha = 1;
    };
    draw1(hist.mic, '#8B6DFF', -1);
    draw1(hist.system, '#34D399', 1);
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
}

// ───────── Lista ─────────
function statusInfo(m) {
  const prog = state.progress[m.id];
  if (m.status === 'recording' || (state.rec.active && state.rec.id === m.id)) return { av: 'rec', icon: 'mic', chip: `<span class="chip rec"><span class="d"></span>Gravando</span>` };
  if (m.status === 'processing') {
    const steps = { ...(m.steps || {}), ...(prog || {}) };
    const running = Object.entries(steps).find(([, v]) => v.state === 'running');
    if (!running) return { av: 'busy', icon: 'clock', chip: `<span class="chip info">Na fila</span>` };
    const p = running[1].progress || 0;
    return { av: 'busy', icon: 'loader', spin: true, chip: `<span class="chip info">${STEP_LABEL[running[0]]}${p ? ` ${Math.round(p * 100)}%` : '…'}</span>`, progress: running[0] === 'summary' && !p ? null : p, step: running[0] };
  }
  if (m.status === 'ready') return { av: 'ok', icon: 'sparkles', chip: m.actions?.length ? `<span class="chip ok">${ic('check', 11)} ${m.actions.length} ${m.actions.length === 1 ? 'ação' : 'ações'}</span>` : `<span class="chip ok">Resumo pronto</span>` };
  if (m.status === 'error') return { av: 'err', icon: 'alertCircle', chip: `<span class="chip err">Falhou</span>` };
  if (m.status === 'interrupted') return { av: 'err', icon: 'alert', chip: `<span class="chip warn">Interrompida</span>` };
  return { av: '', icon: 'fileText', chip: `<span class="chip">Não processada</span>` };
}

function renderList() {
  const area = $('#listArea');
  if (!area) return;
  const scope = folder === undefined ? state.list : state.list.filter((m) => (m.folder || '') === folder);
  let list = scope;
  if (filterIds) list = list.filter((m) => filterIds.has(m.id));
  if (!scope.length) {
    area.innerHTML = folder
      ? `<div class="empty"><div class="big">${ic('folder', 30)}</div><h3>Pasta vazia</h3><div>Grave com <b>Salvar em: ${esc(folder)}</b> selecionado, importe um áudio aqui ou arraste reuniões da lista para esta pasta na barra lateral.</div></div>`
      : folder === '' ? `<div class="empty"><div class="big">${ic('checkCircle', 30)}</div><h3>Tudo organizado</h3><div>Todas as reuniões estão em pastas.</div></div>`
        : `<div class="empty"><div class="big">${ic('waves', 30)}</div><h3>Nenhuma reunião gravada ainda</h3><div>Clique em <b>Gravar reunião</b> quando a próxima começar, ou importe um áudio existente.</div></div>`;
    return;
  }
  const pending = scope.filter((m) => m.status === 'recorded' || m.status === 'interrupted');
  const groups = new Map();
  for (const m of list) {
    const g = dayGroup(m.createdAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  const item = (m) => {
    const st = statusInfo(m);
    const people = (m.participants || []).slice(0, 4);
    const canDrag = m.status !== 'recording' && m.status !== 'processing';
    const openDoubts = (m.doubts || []).filter((d) => d.status === 'open').length;
    return `<div class="mt" data-id="${m.id}" draggable="${canDrag}" title="${canDrag && state.folders.length ? 'Arraste para uma pasta na barra lateral para organizar' : ''}">
      <div class="avatar ${st.av}">${ic(st.icon, 19, st.spin ? 'spin' : '')}</div>
      <div style="min-width:0">
        <div class="t">${esc(m.title)}</div>
        <div class="s">
          ${folder === undefined && m.folder ? `<span class="in-folder">${ic('folder', 12)} ${esc(m.folder)}</span>` : ''}
          ${openDoubts ? `<span class="has-doubts" title="Pontos de dúvida do Claude esperando sua confirmação">${ic('help', 12)} ${openDoubts}</span>` : ''}
          <span>${ic('calendar', 12)} ${fmtDate(m.createdAt)}</span>
          ${m.duration ? `<span>${ic('clock', 12)} ${fmtDuration(m.duration)}</span>` : ''}
          ${m.platform ? `<span>${ic('globe', 12)} ${esc(m.platform)}</span>` : ''}
          ${m.markers?.length ? `<span>${ic('flag', 12)} ${m.markers.length}</span>` : ''}
          ${m.source === 'import' ? `<span>${ic('upload', 12)} importado</span>` : ''}
        </div>
      </div>
      <div class="right">
        ${st.chip}
        ${st.progress != null && st.av === 'busy' ? `<div class="progress mini-progress ${st.progress ? '' : 'indet'}"><i style="width:${Math.round((st.progress || 0) * 100)}%"></i></div>`
          : people.length ? `<div class="people">${people.map((p) => `<span class="pp" style="background:${colorFor(p)}" title="${esc(p)}">${esc(initials(p))}</span>`).join('')}${m.participants.length > 4 ? `<span class="pp" style="background:var(--surface-3);color:var(--text-2)">+${m.participants.length - 4}</span>` : ''}</div>` : ''}
      </div>
    </div>`;
  };
  area.innerHTML = `<div class="list-head"><h3>${filterIds ? `Resultados para “${esc(query)}”` : folder ? 'Reuniões da pasta' : 'Suas reuniões'}</h3><span class="muted">${list.length}</span><div class="grow"></div>${pending.length ? `<button class="btn sm primary" id="procPending" title="Transcreve e resume, uma por vez, as gravações ainda não processadas">${ic('sparkles', 13)} Processar pendentes (${pending.length})</button>` : ''}<button class="btn ghost sm" id="openRoot">${ic('folder', 14)} Abrir no explorador</button></div>`
    + (list.length ? [...groups].map(([g, ms]) => `<div class="group-label">${esc(g)}</div><div class="meetings">${ms.map(item).join('')}</div>`).join('')
      : `<div class="empty"><h3>Nada encontrado</h3><div>Tente outra palavra.</div></div>`);
  $('#openRoot').onclick = () => (folder ? api.folders.open(folder) : api.lib.openFolder());
  if ($('#procPending')) $('#procPending').onclick = async () => {
    for (const m of pending) await api.pipe.process(m.id, 'audio');
    toast('success', `${pending.length} reunião(ões) na fila. Elas serão processadas uma de cada vez, em segundo plano.`);
  };
  $$('.mt', area).forEach((el) => {
    el.onclick = () => ctx.navigate({ view: 'meeting', id: el.dataset.id });
    el.ondragstart = (e) => {
      e.dataTransfer.setData(DRAG_TYPE, el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
      document.body.classList.add('dragging-meeting');
    };
    el.ondragend = () => { el.classList.remove('dragging'); document.body.classList.remove('dragging-meeting'); };
  });
}

const renderListThrottled = (() => { let t = null; return () => { if (t) return; t = setTimeout(() => { t = null; renderList(); }, 500); }; })();

export function onEvent(type, p) {
  if (!root) return;
  if (type === 'rec-state') { if (!p.active) hist = { mic: [], system: [] }; renderLive(); renderList(); }
  else if (type === 'rec-tick') { const t = $('#liveTimer'); if (t) t.textContent = fmtTime(p.elapsed); }
  else if (type === 'levels') {
    hist.mic.push(p.mic); hist.system.push(p.system);
    if (hist.mic.length > 600) { hist.mic.splice(0, 200); hist.system.splice(0, 200); }
  }
  else if (type === 'list-reloaded' || type === 'pipeline-done' || type === 'pipeline-failed') { renderList(); renderFolderHead(); }
  else if (type === 'folders-reloaded') {
    // A pasta aberta foi renomeada/excluída em outro lugar: volta para todas
    if (folder && !state.folders.some((f) => f.name === folder)) return ctx.navigate({ view: 'home' });
    renderFolderHead(); renderList();
    if (!state.rec.active) renderLive();
  }
  else if (type === 'pipeline') renderListThrottled();
  else if (type === 'bridge') { renderSpeaking(); if (!state.rec.active) { const s = $('#sugg'); if (s) { s.innerHTML = suggestionHtml(); bindSugg(); } } }
  else if (type === 'detector') { if (!state.rec.active) { const s = $('#sugg'); if (s) { s.innerHTML = suggestionHtml(); bindSugg(); } } }
  else if (type === 'rec-warning') renderWarnings();
  else if (type === 'marker-added') { markers.push({ t: p.t, label: p.label }); renderMarkers(); }
  else if (type === 'health' || type === 'settings') { if (!state.rec.active) { loadDevices(); } }
}
