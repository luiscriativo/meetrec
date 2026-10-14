// Tela de uma reunião: status do processamento, player, resumo, transcrição, ações, chat com a IA e notas.
import { state, ctx, api, aiName } from '../ctx.js';
import { $, $$, ic, esc, fmtTime, fmtDuration, fmtDate, colorFor, initials, toast, confirmDialog, promptDialog, popMenu, debounce } from '../util.js';
import { pickFolderDialog, moveMeeting } from '../folders-ui.js';

let root = null, id = null, data = null, tab = 'summary';
let editing = false, follow = true, tFilter = '', sig = '', asking = false, askText = '';
const audio = () => $('#audio');

// Solta o arquivo de áudio (no Windows, um arquivo aberto no player não pode ser apagado nem substituído)
function releaseAudio() {
  const a = audio();
  if (!a) return;
  a.pause();
  a.removeAttribute('src');
  delete a.dataset.src;
  a.load();
}

const STEPS = [
  ['audio', 'Preparar áudio', 'waves'],
  ['transcribe', 'Transcrever', 'fileText'],
  ['speakers', 'Identificar falantes', 'users'],
  ['summary', 'Resumo com IA', 'sparkles'],
];

export function topbar(route) {
  const m = state.list.find((x) => x.id === route.id);
  return `<span class="crumb" id="back">${ic('chevronLeft', 16)} ${m?.folder ? `${ic('folder', 14)} ${esc(m.folder)}` : 'Reuniões'}</span><span class="muted">/</span><h1 style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m?.title || 'Reunião')}</h1>`;
}

function bindBack() {
  $('#back').onclick = () => {
    const f = data?.meta?.folder ?? state.list.find((x) => x.id === id)?.folder;
    ctx.navigate(f ? { view: 'home', folder: f } : 'home');
  };
}

export async function render(el, route) {
  root = el; id = route.id; tab = route.tab || 'summary'; editing = false; tFilter = ''; asking = false; lastSeg = -1;
  bindBack();
  el.innerHTML = `<div class="view-inner" style="padding-top:40px"><div class="empty">${ic('loader', 26, 'spin')}</div></div>`;
  await load();
  if (!data) { el.innerHTML = `<div class="view-inner"><div class="empty"><h3>Reunião não encontrada</h3><button class="btn" id="bk">Voltar</button></div></div>`; $('#bk').onclick = () => ctx.navigate('home'); return; }
  el.innerHTML = `<div class="view-inner">
    <div class="m-head" id="mHead"></div>
    <div id="mStatus"></div>
    <div id="mWarn"></div>
    <div class="card player" id="player"></div>
    <div class="tabs" id="tabs"></div>
    <div id="tabBody"></div>
  </div>`;
  renderHead(); renderStatus(); renderWarn(); renderPlayer(); renderTabs(); renderBody();
  sig = signature();
}

export function destroy() {
  const a = audio();
  if (a) { a.ontimeupdate = a.onplay = a.onpause = a.onloadedmetadata = a.onended = a.onerror = null; releaseAudio(); }
  root = null;
}

async function load() { data = await api.lib.get(id); }

function signature() {
  if (!data) return '';
  const m = data.meta;
  return [m.status, data.summary?.length || 0, data.transcript?.segments?.length || 0, JSON.stringify(m.speakerNames || {}), (m.chat || []).length, m.audioFile, m.folder || '', (m.doubts || []).map((d) => d.status).join(',')].join('|');
}

const names = (s) => data.meta.speakerNames?.[s] || s;

// ───────── Cabeçalho ─────────
function renderHead() {
  const m = data.meta;
  const people = m.participants || [];
  $('#mHead').innerHTML = `
    <div class="grow">
      <input class="m-title" id="mTitle" value="${esc(m.title)}" title="Clique para renomear">
      <div class="m-meta">
        <button class="folder-chip ${m.folder ? '' : 'none'}" id="folderChip" title="${m.folder ? 'O resumo usa o contexto, o glossário e o histórico desta pasta. Clique para mover.' : 'Coloque numa pasta para a IA usar o contexto das reuniões do mesmo assunto'}">${ic('folder', 13)} ${m.folder ? esc(m.folder) : 'Sem pasta — mover…'}</button>
        <span>${ic('calendar', 14)} ${fmtDate(m.createdAt)}</span>
        ${m.duration ? `<span>${ic('clock', 14)} ${fmtDuration(m.duration)}</span>` : ''}
        ${m.platform ? `<span>${ic('globe', 14)} ${esc(m.platform)}</span>` : ''}
        ${people.length ? `<span title="${esc(people.map(names).join(', '))}">${ic('users', 14)} ${people.length} participante${people.length > 1 ? 's' : ''}</span>` : ''}
        ${m.source === 'import' ? `<span>${ic('upload', 14)} Importado</span>` : ''}
      </div>
    </div>
    <div class="m-actions">
      ${data.summary ? `<button class="btn primary" id="copySum" title="Copia o resumo pronto para colar no Teams">${ic('copy', 15)} Copiar resumo</button>` : ''}
      <button class="btn icon" id="moreBtn" title="Mais ações">${ic('more', 18)}</button>
    </div>`;
  $('#mTitle').onchange = async (e) => {
    const v = e.target.value.trim();
    if (!v) return;
    await api.lib.update(id, { title: v });
    toast('success', 'Título atualizado.');
    await ctx.reloadList();
    $('#topbar').innerHTML = topbar({ id }); bindBack();
  };
  $('#mTitle').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
  if ($('#copySum')) $('#copySum').onclick = copySummary;
  $('#folderChip').onclick = askMove;
  $('#moreBtn').onclick = (e) => {
    e.stopPropagation();
    const busy = data.meta.status === 'processing';
    popMenu($('.m-actions'), [
      { icon: 'folder', label: 'Mover para pasta…', onClick: askMove },
      ...(data.meta.folder ? [{ icon: 'brain', label: `Contexto da pasta “${data.meta.folder}”`, onClick: () => ctx.navigate({ view: 'folder', name: data.meta.folder }) }] : []),
      { icon: 'external', label: 'Abrir pasta da reunião', onClick: () => api.lib.openFolder(id) },
      '-',
      { icon: 'download', label: 'Exportar resumo (.md)', onClick: () => api.lib.exportItem(id, 'summary') },
      { icon: 'download', label: 'Exportar transcrição (.txt)', onClick: () => api.lib.exportItem(id, 'transcript') },
      { icon: 'download', label: 'Exportar áudio (MP3)', onClick: () => api.lib.exportItem(id, 'mp3') },
      '-',
      ...(busy ? [{ icon: 'x', label: 'Cancelar processamento', onClick: () => api.pipe.cancel(id) }] : [
        { icon: 'refresh', label: 'Processar tudo novamente', onClick: () => api.pipe.process(id, 'audio') },
        { icon: 'fileText', label: 'Refazer só a transcrição', onClick: () => api.pipe.process(id, 'transcribe') },
        { icon: 'sparkles', label: 'Refazer só o resumo', onClick: () => api.pipe.process(id, 'summary') },
      ]),
      '-',
      { icon: 'trash', label: 'Excluir reunião', danger: true, onClick: async () => {
        if (await confirmDialog('Excluir reunião?', `"${data.meta.title}" e todos os arquivos (áudio, transcrição e resumo) irão para a lixeira.`, 'Excluir', 'danger')) {
          releaseAudio();
          const r = await api.lib.remove(id);
          if (r.ok) ctx.navigate('home'); else toast('error', r.error);
        }
      } },
    ]);
  };
}

async function askMove() {
  const m = data.meta;
  if (m.status === 'processing' || m.status === 'recording') return toast('info', 'Aguarde a gravação/processamento terminar para mover esta reunião.');
  const dest = await pickFolderDialog(m.folder || '');
  if (dest == null || dest === (m.folder || '')) return;
  // No Windows a pasta não pode ser movida com o áudio aberto no player
  const a = audio(); const t = a?.currentTime || 0;
  releaseAudio();
  const ok = await moveMeeting(id, dest);
  await load();
  if (!root || !data) return;
  sig = signature();
  $('#topbar').innerHTML = topbar({ id }); bindBack();
  renderHead();
  await renderPlayer();
  if (t && audio()) audio().currentTime = t;
  if (ok && data.summary && dest) toast('info', `Gere o resumo novamente para o ${aiName()} usar o contexto da nova pasta.`, { action: { label: 'Gerar novamente', onClick: () => api.pipe.process(id, 'summary') } });
}

async function copySummary() {
  if (!data.summary) return;
  await api.copy(data.summary);
  toast('success', 'Resumo copiado! Cole direto no Teams (Ctrl+V).');
}

// ───────── Status / progresso ─────────
function stepView(m) {
  const live = state.progress[id] || {};
  return STEPS.map(([k, label, icn]) => {
    const s = { ...(m.steps?.[k] || {}), ...(live[k] || {}) };
    const st = s.state || 'pending';
    const stIcon = st === 'done' ? ic('check', 13) : st === 'error' ? ic('x', 13) : st === 'running' ? ic('loader', 13, 'spin') : st === 'skipped' ? ic('chevronRight', 13) : ic(icn, 12);
    const pct = Math.round((s.progress || 0) * 100);
    const indet = st === 'running' && !s.progress;
    const eta = st === 'running' && s.eta ? ` · ~${fmtDuration(s.eta)} restantes` : '';
    return `<div class="step ${st}">
      <div class="h"><span class="st">${stIcon}</span>${label}${st === 'running' && pct ? `<span class="muted" style="margin-left:auto;font-weight:500">${pct}%</span>` : ''}</div>
      ${st === 'running' ? `<div class="progress ${indet ? 'indet' : ''}"><i style="width:${pct}%"></i></div>` : ''}
      <div class="msg" title="${esc(s.message || '')}">${esc(s.message || (st === 'pending' ? 'Aguardando' : st === 'done' ? 'Concluído' : ''))}${esc(eta)}</div>
    </div>`;
  }).join('');
}

function renderStatus() {
  const el = $('#mStatus');
  if (!el) return;
  const m = data.meta;
  if (m.status === 'processing') {
    el.innerHTML = `<div class="card card-pad" style="margin-bottom:14px">
      <div class="row" style="margin-bottom:12px">${ic('loader', 16, 'spin')}<b>Processando a reunião</b><span class="muted" style="font-size:12.5px">— pode continuar usando o computador; avisarei quando terminar.</span><div class="grow"></div><button class="btn sm ghost" id="cancelBtn">${ic('x', 13)} Cancelar</button></div>
      <div class="steps">${stepView(m)}</div></div>`;
    $('#cancelBtn').onclick = () => api.pipe.cancel(id);
  } else if (m.status === 'error') {
    const failed = STEPS.find(([k]) => m.steps?.[k]?.state === 'error')?.[0] || 'audio';
    el.innerHTML = `<div class="card card-pad" style="margin-bottom:14px">
      <div class="banner err" style="margin-bottom:12px">${ic('alertCircle', 17)}<div class="grow"><b>Não foi possível concluir.</b><div>${esc(m.error || 'Erro desconhecido.')}</div></div></div>
      <div class="steps">${stepView(m)}</div>
      <div class="row" style="margin-top:12px;justify-content:flex-end">
        <button class="btn" id="diagBtn">${ic('activity', 14)} Abrir diagnóstico</button>
        <button class="btn primary" id="retryBtn">${ic('refresh', 14)} Tentar novamente</button>
      </div></div>`;
    $('#retryBtn').onclick = () => api.pipe.process(id, failed);
    $('#diagBtn').onclick = () => ctx.navigate('diagnostics');
  } else if (m.status === 'recorded' || m.status === 'interrupted') {
    el.innerHTML = `<div class="banner info" style="margin-bottom:14px;align-items:center">${ic('info', 17)}<div class="grow">${m.status === 'interrupted' ? 'Esta gravação foi interrompida, mas o áudio foi preservado.' : 'Esta gravação ainda não foi transcrita.'}</div><button class="btn primary sm" id="procBtn">${ic('sparkles', 14)} Transcrever e resumir</button></div>`;
    $('#procBtn').onclick = () => api.pipe.process(id, 'audio');
  } else if (m.status === 'recording') {
    el.innerHTML = `<div class="banner warn" style="margin-bottom:14px;align-items:center">${ic('mic', 17)}<div class="grow">Esta reunião está sendo gravada agora.</div><button class="btn sm" id="goLive">Ver gravação</button></div>`;
    $('#goLive').onclick = () => ctx.navigate('home');
  } else el.innerHTML = '';
}

function renderWarn() {
  const el = $('#mWarn');
  if (!el) return;
  const w = data.meta.warnings || [];
  el.innerHTML = w.map((t) => `<div class="banner warn">${ic('alert', 16)}<span>${esc(t)}</span></div>`).join('');
}

// ───────── Player ─────────
async function renderPlayer() {
  const el = $('#player');
  if (!el) return;
  const m = data.meta;
  const url = m.status !== 'recording' ? await api.lib.mediaUrl(id) : null;
  if (!url) { el.hidden = true; return; }
  el.hidden = false;
  const a = audio();
  if (a.dataset.src !== url) { a.pause(); a.src = url; a.dataset.src = url; }
  const dur = () => (isFinite(a.duration) && a.duration > 0 ? a.duration : m.duration || 0);
  el.innerHTML = `
    <button class="play-btn" id="playBtn" title="Reproduzir / pausar (espaço)">${ic(a.paused ? 'play' : 'pause', 18)}</button>
    <button class="btn icon sm ghost" id="back10" title="Voltar 10 s">−10</button>
    <div class="seek" id="seek"><div class="track"></div><div class="fill" id="fill"></div>${(m.markers || []).map((mk) => `<span class="mk" style="left:${(mk.t / (m.duration || 1)) * 100}%" title="${esc(mk.label || 'Momento marcado')} · ${fmtTime(mk.t)}"></span>`).join('')}<div class="knob" id="knob"></div></div>
    <button class="btn icon sm ghost" id="fwd10" title="Avançar 10 s">+10</button>
    <span class="time" id="ptime">${fmtTime(a.currentTime)} / ${fmtTime(dur())}</span>
    <button class="btn sm" id="rate" title="Velocidade">${a.playbackRate}x</button>`;
  const upd = () => {
    const d = dur(), p = d ? Math.min(1, a.currentTime / d) : 0;
    const f = $('#fill'), k = $('#knob'), t = $('#ptime');
    if (!f) return;
    f.style.width = p * 100 + '%'; k.style.left = p * 100 + '%';
    t.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(d)}`;
    highlightSegment(a.currentTime);
  };
  upd();
  a.ontimeupdate = upd;
  a.onloadedmetadata = upd;
  a.onplay = a.onpause = () => { const b = $('#playBtn'); if (b) b.innerHTML = ic(a.paused ? 'play' : 'pause', 18); };
  a.onerror = () => toast('error', 'Não foi possível tocar o áudio desta reunião.');
  $('#playBtn').onclick = () => (a.paused ? a.play() : a.pause());
  $('#back10').onclick = () => { a.currentTime = Math.max(0, a.currentTime - 10); };
  $('#fwd10').onclick = () => { a.currentTime = Math.min(dur(), a.currentTime + 10); };
  $('#rate').onclick = (e) => {
    const rates = [1, 1.25, 1.5, 1.75, 2];
    a.playbackRate = rates[(rates.indexOf(a.playbackRate) + 1) % rates.length];
    e.target.textContent = a.playbackRate + 'x';
  };
  const seek = $('#seek');
  const seekTo = (ev) => { const r = seek.getBoundingClientRect(); a.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * dur(); upd(); };
  seek.onmousedown = (ev) => {
    seekTo(ev);
    const mv = (e2) => seekTo(e2);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };
}

function playAt(t) {
  const a = audio();
  if (!a.src) return;
  a.currentTime = Math.max(0, t - 0.3);
  a.play();
}

// Atalho: espaço = play/pause (fora de campos de texto)
document.addEventListener('keydown', (e) => {
  if (!root || e.code !== 'Space' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const a = audio();
  if (!a.src) return;
  e.preventDefault();
  a.paused ? a.play() : a.pause();
});

// ───────── Abas ─────────
function renderTabs() {
  const segs = data.transcript?.segments?.length || 0;
  const acts = data.meta.actions?.length || 0;
  const openDoubts = (data.meta.doubts || []).filter((d) => d.status === 'open').length;
  const t = [
    ['summary', 'sparkles', 'Resumo', openDoubts ? `<span title="Pontos de dúvida abertos" style="display:inline-flex;align-items:center;gap:3px">${ic('help', 11)}${openDoubts}</span>` : ''],
    ['transcript', 'fileText', 'Transcrição', segs],
    ['actions', 'checkCircle', 'Itens de ação', acts],
    ['ask', 'message', `Perguntar ao ${aiName()}`, ''],
    ['notes', 'note', 'Notas e marcações', (data.meta.markers?.length || 0) + (data.meta.notes?.trim() ? 1 : 0) || ''],
  ];
  $('#tabs').innerHTML = t.map(([k, i, l, c]) => `<button data-t="${k}" class="${tab === k ? 'active' : ''}">${ic(i, 15)}${l}${c ? `<span class="count">${c}</span>` : ''}</button>`).join('');
  $$('#tabs button').forEach((b) => (b.onclick = () => { tab = b.dataset.t; editing = false; renderTabs(); renderBody(); }));
}

function renderBody() {
  const el = $('#tabBody');
  if (!el) return;
  ({ summary: renderSummary, transcript: renderTranscript, actions: renderActions, ask: renderAsk, notes: renderNotes })[tab](el);
}

// Resumo
function renderSummary(el) {
  const m = data.meta;
  const stream = state.summaryStream[id];
  const processing = m.status === 'processing';
  if (processing && stream) {
    el.innerHTML = `<div class="doc-tools"><span class="chip accent">${ic('sparkles', 12)} O ${aiName()} está escrevendo…</span></div><div class="card doc streaming" id="docStream">${esc(stream)}</div>`;
    return;
  }
  if (editing) {
    el.innerHTML = `<div class="doc-tools"><span class="muted">Editando o resumo</span><div class="grow"></div><button class="btn" id="cancelEd">Cancelar</button><button class="btn primary" id="saveEd">${ic('check', 14)} Salvar</button></div>
      <textarea class="textarea" id="edArea" style="min-height:520px;font-size:14px;line-height:1.6">${esc(data.summary || '')}</textarea>`;
    $('#cancelEd').onclick = () => { editing = false; renderBody(); };
    $('#saveEd').onclick = async () => { const v = $('#edArea').value; await api.lib.saveSummary(id, v); data.summary = v; editing = false; toast('success', 'Resumo salvo.'); renderBody(); };
    return;
  }
  if (data.summary) {
    const s = m.summary || {};
    el.innerHTML = `<div class="doc-tools">
        <button class="btn primary" id="copy2">${ic('copy', 14)} Copiar para o Teams</button>
        <button class="btn" id="editBtn">${ic('edit', 14)} Editar</button>
        <button class="btn" id="regen" ${processing ? 'disabled' : ''}>${ic('refresh', 14)} Gerar novamente</button>
        <div class="grow"></div>
        <button class="btn ghost" id="expMd">${ic('download', 14)} .md</button>
      </div>
      <div class="card doc">${esc(data.summary)}</div>
      <div class="doc-foot">
        ${s.generatedAt ? `<span>${ic('sparkles', 12)} Gerado pelo ${s.engine === 'codex' ? 'Codex CLI' : 'Claude Code'}${s.model ? ` (${esc(s.model)})` : ''} em ${fmtDate(s.generatedAt)}</span>` : ''}
        ${s.durationMs ? `<span>${ic('clock', 12)} ${Math.round(s.durationMs / 1000)}s</span>` : ''}
        ${s.costUsd != null ? `<span>US$ ${Number(s.costUsd).toFixed(3)}</span>` : ''}
      </div>
      <div id="doubts">${doubtsHtml()}</div>`;
    bindDoubts();
    $('#copy2').onclick = copySummary;
    $('#editBtn').onclick = () => { editing = true; renderBody(); };
    $('#regen').onclick = async () => { if (await confirmDialog('Gerar o resumo novamente?', 'O resumo atual será substituído (a transcrição é mantida).', 'Gerar novamente')) api.pipe.process(id, 'summary'); };
    $('#expMd').onclick = () => api.lib.exportItem(id, 'summary');
    return;
  }
  if (processing) {
    el.innerHTML = `<div class="card card-pad empty"><div class="big">${ic('sparkles', 28)}</div><h3>O resumo aparecerá aqui</h3><div>Assim que a transcrição terminar, o ${aiName()} começa a escrever — você verá o texto surgindo em tempo real.</div></div>`;
    return;
  }
  const hasTr = data.transcript?.segments?.length;
  el.innerHTML = `<div class="card card-pad empty"><div class="big">${ic('sparkles', 28)}</div><h3>Sem resumo ainda</h3>
    <div style="margin-bottom:14px">${hasTr ? 'A transcrição está pronta. Gere o resumo com o ${aiName()}.' : 'Transcreva a reunião para gerar o resumo.'}</div>
    <button class="btn primary" id="mk">${ic('sparkles', 14)} ${hasTr ? 'Gerar resumo' : 'Transcrever e resumir'}</button></div>`;
  $('#mk').onclick = () => api.pipe.process(id, hasTr ? 'summary' : 'audio');
}

// ───────── Pontos de dúvida ─────────
const KIND_LABEL = { termo: 'Termo', nome: 'Nome', numero: 'Número/data', falante: 'Quem falou', trecho: 'Trecho' };
const dState = {}; // rascunho das respostas enquanto a tela re-renderiza

// Trecho da transcrição em volta do horário da dúvida, com a palavra destacada
function excerptFor(d) {
  const segs = data.transcript?.segments || [];
  if (!segs.length) return null;
  let seg = null;
  if (d.heard) {
    const h = d.heard.toLowerCase();
    const hits = segs.filter((s) => s.text.toLowerCase().includes(h));
    seg = d.t != null ? hits.sort((a, b) => Math.abs(a.start - d.t) - Math.abs(b.start - d.t))[0] : hits[0];
  }
  if (!seg && d.t != null) seg = segs.reduce((best, s) => (Math.abs(s.start - d.t) < Math.abs(best.start - d.t) ? s : best), segs[0]);
  if (!seg) return null;
  let html = esc(seg.text);
  if (d.heard) html = html.replace(new RegExp(esc(d.heard).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (x) => `<mark>${x}</mark>`);
  return { seg, html };
}

function doubtsHtml() {
  const list = data.meta.doubts || [];
  const s = data.meta.summary || {};
  if (!list.length) {
    if (!s.generatedAt) return '';
    // Resumos de antes desta versão não têm a lista (doubts ausente) — não dá para dizer que "não houve dúvidas"
    return s.blockError || !Array.isArray(data.meta.doubts)
      ? `<div class="doubts-empty muted">${ic('info', 13)} Este resumo não trouxe a lista de pontos de dúvida. Gere novamente para o ${aiName()} listá-los.</div>`
      : `<div class="doubts-empty">${ic('checkCircle', 14)} O ${s.engine === 'codex' ? 'Codex' : 'Claude'} não teve dúvidas sobre a transcrição desta reunião.</div>`;
  }
  const open = list.filter((d) => d.status === 'open');
  const done = list.filter((d) => d.status !== 'open');
  const changedSince = done.some((d) => d.status !== 'ignored' && d.resolvedAt && (!s.generatedAt || d.resolvedAt > s.generatedAt));
  const folder = data.meta.folder;
  const remLabel = folder ? 'Lembrar nesta pasta' : 'Lembrar em todas as reuniões';
  const remTitle = folder ? `Entra no glossário da pasta “${folder}”: as próximas transcrições já saem corrigidas` : 'Entra no glossário geral: vale para todas as reuniões';
  const card = (d) => {
    const ex = excerptFor(d);
    const st = dState[d.id] || {};
    const val = st.answer ?? d.suggestion ?? '';
    const canRemember = d.kind === 'nome' || d.kind === 'termo';
    return `<div class="doubt" data-d="${d.id}">
      <div class="dq">
        <span class="chip">${esc(KIND_LABEL[d.kind] || 'Dúvida')}</span>
        ${d.t != null || ex ? `<button class="btn sm ghost play-at" data-t="${ex ? ex.seg.start : d.t}" title="Ouvir o trecho">${ic('play', 10)} ${fmtTime(ex ? ex.seg.start : d.t)}</button>` : ''}
        <b class="grow">${esc(d.question)}</b>
      </div>
      ${ex ? `<div class="dx"><span class="who">${esc(names(ex.seg.speaker))}:</span> “${ex.html}”</div>` : d.heard ? `<div class="dx">Transcrição: “<mark>${esc(d.heard)}</mark>”</div>` : ''}
      <div class="da">
        <input class="input" data-in placeholder="${canRemember && d.heard ? `Como deveria ser? (no lugar de “${esc(d.heard)}”)` : 'Sua resposta ou correção'}" value="${esc(val)}">
        <button class="btn primary" data-act="fix">${ic('check', 14)} Corrigir</button>
        ${d.heard ? `<button class="btn" data-act="ok" title="A transcrição está certa">Está certo</button>` : ''}
        <button class="btn ghost" data-act="ignore" title="Não sei / não importa">Ignorar</button>
      </div>
      ${canRemember ? `<label class="dr" title="${esc(remTitle)}"><input type="checkbox" data-rem ${st.remember === false ? '' : 'checked'}> ${esc(remLabel)}</label>` : ''}
    </div>`;
  };
  const doneLine = (d) => {
    const what = d.status === 'fixed'
      ? ((d.kind === 'termo' || d.kind === 'nome') && d.heard && d.answer && d.answer !== d.heard ? `“${esc(d.heard)}” → <b>“${esc(d.answer)}”</b>` : `${esc(d.question)} → <b>${esc(d.answer || '')}</b>`)
      : d.status === 'ok' ? `“${esc(d.heard || d.question)}” está certo` : `${esc(d.question)}`;
    const extra = [d.replaced ? `${d.replaced}× corrigido na transcrição` : '', d.remembered ? (folder ? 'lembrado na pasta' : 'lembrado no glossário geral') : ''].filter(Boolean).join(' · ');
    return `<div class="doubt-done ${d.status}">${ic(d.status === 'ignored' ? 'x' : 'check', 13)}<span class="grow">${what}${d.status === 'ignored' ? ' <span class="muted">(ignorado)</span>' : ''}</span>${extra ? `<span class="muted">${extra}</span>` : ''}</div>`;
  };
  return `<div class="doubts">
    <div class="doubts-head">
      <span class="dh-ico">${ic('help', 17)}</span>
      <div class="grow"><b>Pontos de dúvida</b> ${open.length ? `<span class="chip warn">${open.length} ${open.length === 1 ? 'aberto' : 'abertos'}</span>` : `<span class="chip ok">${ic('check', 11)} tudo revisado</span>`}
        <div class="muted" style="font-size:12.5px;margin-top:2px">A IA não teve certeza destes trechos. Ouça, corrija — e as próximas reuniões${folder ? ' desta pasta' : ''} já vêm melhores.</div></div>
    </div>
    ${changedSince ? `<div class="banner info regen-banner">${ic('sparkles', 16)}<div class="grow">Suas correções ainda não estão no resumo.</div><button class="btn primary sm" id="regenFix">${ic('refresh', 13)} Refazer resumo com as correções</button></div>` : ''}
    ${open.map(card).join('')}
    ${done.length ? `<div class="doubts-done">${done.map(doneLine).join('')}</div>` : ''}
  </div>`;
}

function bindDoubts() {
  const box = $('#doubts');
  if (!box) return;
  $$('.play-at', box).forEach((b) => (b.onclick = () => playAt(+b.dataset.t)));
  $$('.doubt', box).forEach((card) => {
    const did = card.dataset.d;
    const inp = card.querySelector('[data-in]');
    const rem = card.querySelector('[data-rem]');
    inp.oninput = () => { dState[did] = { ...(dState[did] || {}), answer: inp.value }; };
    if (rem) rem.onchange = () => { dState[did] = { ...(dState[did] || {}), remember: rem.checked }; };
    const submit = async (action) => {
      if (action === 'fix' && !inp.value.trim()) { inp.focus(); toast('warn', 'Escreva a correção (ou clique em "Está certo" / "Ignorar").'); return; }
      $$('button', card).forEach((b) => (b.disabled = true));
      const r = await api.lib.resolveDoubt(id, did, { action, answer: inp.value, remember: rem ? rem.checked : false });
      if (!r.ok) { toast('error', r.error); $$('button', card).forEach((b) => (b.disabled = false)); return; }
      delete dState[did];
      data.meta = r.meta;
      if (r.replaced) data.transcript = (await api.lib.get(id))?.transcript || data.transcript;
      const msg = action === 'ignore' ? 'Ponto ignorado.'
        : [action === 'fix' ? 'Correção salva' : 'Confirmado', r.replaced ? `${r.replaced}× na transcrição` : '', r.remembered ? (data.meta.folder ? 'lembrado na pasta' : 'lembrado no glossário geral') : ''].filter(Boolean).join(' · ') + '.';
      toast('success', msg);
      sig = signature();
      const el = $('#doubts'); if (el) { el.innerHTML = doubtsHtml(); bindDoubts(); }
      renderTabs();
      if (r.remembered) ctx.reloadFolders();
    };
    $$('[data-act]', card).forEach((b) => (b.onclick = () => submit(b.dataset.act)));
    inp.onkeydown = (e) => { if (e.key === 'Enter') submit('fix'); };
  });
  const rg = $('#regenFix');
  if (rg) rg.onclick = () => { api.pipe.process(id, 'summary'); toast('info', 'Gerando o resumo de novo com as suas correções…'); };
}

// Transcrição
function renderTranscript(el) {
  const segs = data.transcript?.segments || [];
  if (!segs.length) {
    el.innerHTML = `<div class="card card-pad empty"><div class="big">${ic('fileText', 28)}</div><h3>Sem transcrição</h3><div>${data.meta.status === 'processing' ? 'Transcrevendo… acompanhe o progresso acima.' : 'Processe a reunião para ver quem disse o quê.'}</div></div>`;
    return;
  }
  const counts = {};
  for (const s of segs) counts[s.speaker] = (counts[s.speaker] || 0) + 1;
  const speakers = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  el.innerHTML = `
    <div class="doc-tools">
      <div class="search" style="width:300px">${ic('search', 15)}<input class="input" id="tq" placeholder="Buscar na transcrição…" value="${esc(tFilter)}"></div>
      <label class="row muted" style="font-size:12.5px;gap:6px;cursor:pointer"><span class="switch"><input type="checkbox" id="follow" ${follow ? 'checked' : ''}><span></span></span> Acompanhar o áudio</label>
      <div class="grow"></div>
      <button class="btn ghost" id="cpTr">${ic('copy', 14)} Copiar</button>
      <button class="btn ghost" id="expTr">${ic('download', 14)} .txt</button>
    </div>
    <div class="speakers">${speakers.map((s) => `<span class="spk" data-s="${esc(s)}" title="Clique para renomear"><span class="av" style="background:${colorFor(names(s))}">${esc(initials(names(s)))}</span>${esc(names(s))} <span class="n">${counts[s]}</span>${ic('edit', 12)}</span>`).join('')}</div>
    <div class="muted" style="font-size:12px;margin:-4px 0 10px">Clique no nome de um falante para renomeá-lo em toda a transcrição (ex.: "Participante" → "Ana"). Clique no horário para ouvir o trecho.</div>
    <div class="card" style="padding:8px" id="segs"></div>`;
  renderSegs();
  $('#tq').oninput = debounce((e) => { tFilter = e.target.value; renderSegs(); }, 200);
  $('#follow').onchange = (e) => (follow = e.target.checked);
  $('#cpTr').onclick = async () => { await api.copy(segs.map((s) => `[${fmtTime(s.start)}] ${names(s.speaker)}: ${s.text}`).join('\n')); toast('success', 'Transcrição copiada.'); };
  $('#expTr').onclick = () => api.lib.exportItem(id, 'transcript');
  $$('.spk', el).forEach((b) => (b.onclick = async () => {
    const orig = b.dataset.s;
    const v = await promptDialog('Renomear falante', `Novo nome para "${names(orig)}":`, names(orig) === 'Participante' ? '' : names(orig));
    if (v == null || !v) return;
    const speakerNames = { ...(data.meta.speakerNames || {}), [orig]: v };
    await api.lib.update(id, { speakerNames });
    data.meta.speakerNames = speakerNames;
    toast('success', `"${orig}" agora aparece como "${v}". Gere o resumo novamente para refletir no texto.`, { action: { label: 'Regerar resumo', onClick: () => api.pipe.process(id, 'summary') } });
    renderTranscript(el);
  }));
}

function renderSegs() {
  const box = $('#segs');
  if (!box) return;
  const segs = data.transcript?.segments || [];
  const q = tFilter.trim().toLowerCase();
  const markers = [...(data.meta.markers || [])].sort((a, b) => a.t - b.t);
  let mi = 0;
  const hl = (t) => { const e = esc(t); if (!q) return e; return e.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (x) => `<mark>${x}</mark>`); };
  const out = [];
  segs.forEach((s, i) => {
    while (!q && mi < markers.length && markers[mi].t <= s.start) { out.push(`<div class="seg-marker">${ic('flag', 13)} ${fmtTime(markers[mi].t)} · ${esc(markers[mi].label || 'Momento marcado')}</div>`); mi++; }
    if (q && !s.text.toLowerCase().includes(q) && !names(s.speaker).toLowerCase().includes(q)) return;
    const n = names(s.speaker);
    out.push(`<div class="seg" data-i="${i}" data-start="${s.start}" data-end="${s.end}">
      <span class="av" style="background:${colorFor(n)}">${esc(initials(n))}</span>
      <div><div class="who">${esc(n)} <span class="ts" data-t="${s.start}">${fmtTime(s.start)}</span>${s.source === 'mic' ? '' : ''}</div><div class="tx">${hl(s.text)}</div></div>
    </div>`);
  });
  box.innerHTML = out.join('') || `<div class="empty">Nenhum trecho com “${esc(tFilter)}”.</div>`;
  $$('.ts', box).forEach((t) => (t.onclick = () => playAt(+t.dataset.t)));
}

let lastSeg = -1;
function highlightSegment(t) {
  if (tab !== 'transcript') return;
  const segs = $$('#segs .seg');
  let cur = null;
  for (const s of segs) if (t >= +s.dataset.start && t <= +s.dataset.end + 0.8) cur = s;
  const idx = cur ? +cur.dataset.i : -1;
  if (idx === lastSeg) return;
  lastSeg = idx;
  segs.forEach((s) => s.classList.toggle('now', s === cur));
  if (cur && follow && !audio().paused) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Itens de ação
function renderActions(el) {
  const acts = data.meta.actions || [];
  if (!acts.length) {
    el.innerHTML = `<div class="card card-pad empty"><div class="big">${ic('checkCircle', 28)}</div><h3>Nenhum item de ação</h3><div>${data.summary ? 'O resumo não trouxe tarefas com responsável.' : 'Os itens de ação são extraídos do resumo gerado pela IA.'}</div></div>`;
    return;
  }
  const done = acts.filter((a) => a.done).length;
  el.innerHTML = `<div class="doc-tools"><span class="chip ${done === acts.length ? 'ok' : 'accent'}">${done} de ${acts.length} concluídos</span><div class="grow"></div><button class="btn ghost" id="cpAct">${ic('copy', 14)} Copiar lista</button></div>
    <div class="actions-list">${acts.map((a, i) => `<label class="card act ${a.done ? 'done' : ''}"><input type="checkbox" data-i="${i}" ${a.done ? 'checked' : ''}><div class="grow">${a.owner ? `<div class="owner"><span class="chip" style="background:${colorFor(a.owner)}22;color:${colorFor(a.owner)}">${ic('user', 11)} ${esc(a.owner)}</span></div>` : ''}<div class="tx">${esc(a.text)}</div></div></label>`).join('')}</div>`;
  $$('input[type=checkbox]', el).forEach((c) => (c.onchange = async () => {
    acts[+c.dataset.i].done = c.checked;
    await api.lib.update(id, { actions: acts });
    renderActions(el); renderTabs();
  }));
  $('#cpAct').onclick = async () => { await api.copy(acts.map((a) => `${a.done ? '☑' : '☐'} ${a.owner ? a.owner + ': ' : ''}${a.text}`).join('\n')); toast('success', 'Lista copiada.'); };
}

// Perguntar à IA
const SUGGESTIONS = [
  'Quais decisões foram tomadas?',
  'O que ficou pendente para mim?',
  'Escreva um e-mail de follow-up para os participantes',
  'Quais riscos ou preocupações foram levantados?',
  'Resuma em 3 frases para meu gestor',
];

function renderAsk(el) {
  const chat = data.meta.chat || [];
  const hasTr = data.transcript?.segments?.length;
  if (!hasTr) {
    el.innerHTML = `<div class="card card-pad empty"><div class="big">${ic('message', 28)}</div><h3>Converse sobre a reunião</h3><div>Disponível depois que a reunião for transcrita.</div></div>`;
    return;
  }
  el.innerHTML = `<div class="chat" id="chat">
      ${chat.length ? '' : `<div class="muted" style="text-align:center;margin:10px 0 4px">${ic('sparkles', 22)}<div style="margin-top:8px">Pergunte qualquer coisa sobre esta reunião. O ${aiName()} responde com base na transcrição.</div></div><div class="sugs" style="justify-content:center">${SUGGESTIONS.map((s) => `<button class="sug">${esc(s)}</button>`).join('')}</div>`}
      ${chat.map((c) => `<div class="msg ${c.role}">${c.role === 'error' ? ic('alertCircle', 14) + ' ' : ''}${esc(c.text)}${c.role === 'assistant' ? `<div style="margin-top:6px"><button class="btn sm ghost cp" data-t="${esc(c.text)}">${ic('copy', 12)} Copiar</button></div>` : ''}</div>`).join('')}
      ${asking ? `<div class="msg assistant" id="streamMsg">${askText ? esc(askText) : `<span class="row muted" style="gap:8px">${ic('loader', 14, 'spin')} O ${aiName()} está lendo a reunião…</span>`}</div>` : ''}
    </div>
    <div class="chat-input"><textarea class="textarea" id="askIn" rows="1" placeholder="Pergunte algo… (Enter envia, Shift+Enter quebra linha)" ${asking ? 'disabled' : ''}></textarea><button class="btn primary" id="askBtn" style="height:44px" ${asking ? 'disabled' : ''}>${ic('send', 15)}</button></div>`;
  const send = async (q) => {
    q = (q ?? $('#askIn').value).trim();
    if (!q || asking) return;
    asking = true; askText = '';
    data.meta.chat = [...chat, { role: 'user', text: q }];
    renderAsk(el);
    $('#streamMsg')?.scrollIntoView({ block: 'end' });
    const r = await api.pipe.ask(id, q);
    asking = false; askText = '';
    if (!r.ok) toast('error', r.error);
    await load();
    if (tab === 'ask') renderAsk(el);
    $('#askIn')?.focus();
  };
  $$('.sug', el).forEach((b) => (b.onclick = () => send(b.textContent)));
  $$('.cp', el).forEach((b) => (b.onclick = async () => { await api.copy(b.dataset.t); toast('success', 'Resposta copiada.'); }));
  $('#askBtn').onclick = () => send();
  $('#askIn').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('#askIn').oninput = (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px'; };
}

// Notas e marcações
function renderNotes(el) {
  const m = data.meta;
  const markers = [...(m.markers || [])].sort((a, b) => a.t - b.t);
  el.innerHTML = `
    <div class="section-title" style="margin-top:0">${ic('note', 14)} Anotações</div>
    <textarea class="textarea" id="notes" rows="8" placeholder="Suas anotações sobre a reunião. A IA considera este texto ao gerar o resumo.">${esc(m.notes || '')}</textarea>
    <div class="muted" id="nsaved" style="font-size:11.5px;margin-top:4px;height:14px"></div>
    <div class="section-title">${ic('flag', 14)} Momentos marcados</div>
    ${markers.length ? `<div class="card" style="padding:6px">${markers.map((mk, i) => `<div class="seg" style="grid-template-columns:70px 1fr auto;align-items:center"><span class="ts" data-t="${mk.t}">${ic('play', 10)} ${fmtTime(mk.t)}</span><span>${esc(mk.label || 'Momento importante')}</span><button class="btn sm ghost" data-ed="${i}">${ic('edit', 13)}</button></div>`).join('')}</div>`
      : `<div class="muted">Nenhum momento marcado. Durante a gravação, use o botão ${ic('flag', 12)} ou o atalho.</div>`}
    ${(m.participants || []).length ? `<div class="section-title">${ic('users', 14)} Participantes identificados</div><div class="speakers">${m.participants.map((p) => `<span class="spk"><span class="av" style="background:${colorFor(names(p))}">${esc(initials(names(p)))}</span>${esc(names(p))}</span>`).join('')}</div>` : ''}`;
  const save = debounce(async (v) => { await api.lib.update(id, { notes: v }); data.meta.notes = v; const s = $('#nsaved'); if (s) s.textContent = 'Salvo ✓'; }, 600);
  $('#notes').oninput = (e) => { $('#nsaved').textContent = 'Salvando…'; save(e.target.value); };
  $$('.ts', el).forEach((t) => (t.onclick = () => playAt(+t.dataset.t)));
  $$('[data-ed]', el).forEach((b) => (b.onclick = async () => {
    const mk = markers[+b.dataset.ed];
    const v = await promptDialog('Descrição do momento', `Momento em ${fmtTime(mk.t)}`, mk.label || '');
    if (v == null) return;
    mk.label = v;
    await api.lib.update(id, { markers });
    data.meta.markers = markers;
    renderNotes(el);
  }));
}

// ───────── Eventos ─────────
const reload = debounce(async () => {
  if (!root) return;
  await load();
  if (!data || !root) return;
  const s = signature();
  const changed = s !== sig;
  sig = s;
  renderStatus(); renderWarn();
  if (document.activeElement?.id !== 'mTitle') renderHead();
  if (changed) {
    renderTabs();
    renderPlayer();
    if (!editing && !(tab === 'ask' && asking) && !(tab === 'notes' && document.activeElement?.id === 'notes')) renderBody();
  }
}, 250);

export function onEvent(type, p) {
  if (!root) return;
  if (type === 'list-reloaded' || ((type === 'pipeline-done' || type === 'pipeline-failed' || type === 'pipeline-start') && p.id === id)) reload();
  else if (type === 'pipeline' && p.id === id) {
    // Atualiza só os passos (rápido)
    const steps = $('.steps');
    if (steps && data.meta.status === 'processing') steps.innerHTML = stepView(data.meta);
    else if (data.meta.status !== 'processing') reload();
  } else if (type === 'summary-stream' && p.id === id && tab === 'summary' && !editing) {
    const d = $('#docStream');
    if (d) { d.textContent = p.text; } else renderBody();
  } else if (type === 'ask-stream' && p.id === id && asking) {
    askText = p.text;
    const m = $('#streamMsg');
    if (m) { m.textContent = p.text; m.scrollIntoView({ block: 'end' }); }
  }
}
