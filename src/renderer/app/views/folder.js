// Tela "Contexto da pasta": o que o Claude sabe sobre as reuniões desta pasta.
// Contexto (aprovado por você), glossário (preenchido pelas suas correções) e histórico (automático).
import { state, ctx, api } from '../ctx.js';
import { $, $$, ic, esc, fmtDate, toast, confirmDialog, promptDialog, colorFor, initials } from '../util.js';

let root = null, name = '', data = null, editing = false, editHistory = false, busy = false, busyMsg = '';

export function topbar(route) {
  const n = route.name || '';
  return `<span class="crumb" id="crumbAll">${ic('chevronLeft', 16)} Reuniões</span><span class="muted">/</span>
    <span class="crumb" id="crumbFolder">${n ? `${ic('folder', 14)} ${esc(n)}` : 'Sem pasta'}</span><span class="muted">/</span>
    <h1>${n ? 'Contexto da pasta' : 'Glossário geral'}</h1>`;
}

export async function render(el, route) {
  root = el; name = route.name || ''; editing = false; editHistory = false; busy = false;
  $('#crumbAll').onclick = () => ctx.navigate({ view: 'home' });
  $('#crumbFolder').onclick = () => ctx.navigate({ view: 'home', folder: name });
  el.innerHTML = `<div class="view-inner"><div class="empty">${ic('loader', 26, 'spin')}</div></div>`;
  await load();
  if (!data) {
    el.innerHTML = `<div class="view-inner"><div class="empty"><h3>Pasta não encontrada</h3><div>Ela pode ter sido renomeada ou excluída.</div><button class="btn" id="bk" style="margin-top:12px">Voltar</button></div></div>`;
    $('#bk').onclick = () => ctx.navigate({ view: 'home' });
    return;
  }
  draw();
  if (route.bootstrap && name && !data.context && !data.draft && data.summarized) bootstrap();
}

export function destroy() { root = null; }

async function load() { data = await api.folders.get(name); }

function draw() {
  if (!root || !data) return;
  root.innerHTML = `<div class="view-inner">
    ${name ? headHtml() : `<div class="banner info" style="margin-top:8px">${ic('info', 16)}<div>Termos que você confirma em reuniões <b>sem pasta</b> ficam aqui e valem para <b>todas</b> as reuniões. Termos de uma pasta valem só para ela.</div></div>`}
    ${name ? draftHtml() : ''}
    ${name ? contextHtml() : ''}
    ${glossaryHtml()}
    ${name ? historyHtml() : ''}
  </div>`;
  bind();
}

// ───────── Cabeçalho ─────────
function headHtml() {
  return `<div class="fold-top">
    <div class="fh-ico big">${ic('folder', 26)}</div>
    <div class="grow">
      <div class="row" style="gap:8px"><h2 class="fold-name">${esc(name)}</h2><button class="btn icon sm ghost" id="renameBtn" title="Renomear pasta">${ic('edit', 14)}</button></div>
      <input class="input fold-desc" id="descIn" value="${esc(data.description || '')}" placeholder="Do que se trata esta pasta? (opcional — ex.: Projeto de rebranding do cliente)">
      <div class="muted" style="font-size:12.5px;margin-top:6px">${data.count} ${data.count === 1 ? 'reunião' : 'reuniões'} · ${data.summarized} com resumo</div>
    </div>
    <div class="col" style="gap:6px;align-items:flex-end">
      <button class="btn" id="seeMeetings">${ic('list', 14)} Ver reuniões</button>
      <div class="row" style="gap:6px">
        <button class="btn ghost sm" id="openDir" title="Abrir a pasta no explorador (os arquivos CONTEXTO.md, GLOSSARIO.md e HISTORICO.md ficam em _contexto)">${ic('external', 13)} Explorador</button>
        <button class="btn ghost sm danger" id="delBtn">${ic('trash', 13)} Excluir</button>
      </div>
    </div>
  </div>`;
}

// ───────── Sugestão do Claude aguardando aprovação ─────────
function draftHtml() {
  const d = data.draft;
  if (!d) return '';
  const isNew = d.kind === 'new' || !data.context;
  return `<div class="card draft-card">
    <div class="row" style="align-items:flex-start;gap:12px">
      <span class="draft-ico">${ic('sparkles', 18)}</span>
      <div class="grow">
        <b>${isNew ? 'Montei o contexto desta pasta. Confere?' : 'Sugiro atualizar o contexto desta pasta.'}</b>
        <div class="muted" style="font-size:12.5px;margin-top:2px">A partir de “${esc(d.fromTitle || 'reunião')}” · ${d.at ? fmtDate(d.at) : ''}. Ao aprovar, o Claude passa a usar isto em todos os resumos da pasta.</div>
      </div>
    </div>
    <div class="draft-body">${contextView(d, data.context)}</div>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
      <button class="btn ghost" id="discardDraft">${ic('x', 14)} Descartar</button>
      <button class="btn" id="editDraft">${ic('edit', 14)} Ajustar antes</button>
      <button class="btn primary" id="approveDraft">${ic('check', 14)} Aprovar</button>
    </div>
  </div>`;
}

// Visualização do contexto (destaca o que mudou em relação ao atual)
function contextView(c, prev) {
  const prevNames = new Set((prev?.participants || []).map((p) => `${p.name}|${p.role}`.toLowerCase()));
  const prevGoals = new Set((prev?.goals || []).map((g) => g.toLowerCase()));
  const isNewP = (p) => prev && !prevNames.has(`${p.name}|${p.role}`.toLowerCase());
  const isNewG = (g) => prev && !prevGoals.has(g.toLowerCase());
  const rows = [];
  if (c.about) rows.push(`<div class="cv-row"><span class="cv-l">Sobre</span><div class="${prev && prev.about !== c.about ? 'cv-new' : ''}">${esc(c.about)}</div></div>`);
  if (c.participants?.length) rows.push(`<div class="cv-row"><span class="cv-l">Participantes</span><div class="cv-people">${c.participants.map((p) => `<span class="spk ${isNewP(p) ? 'cv-new' : ''}" style="cursor:default"><span class="av" style="background:${colorFor(p.name)}">${esc(initials(p.name))}</span>${esc(p.name)}${p.role ? `<span class="n">· ${esc(p.role)}</span>` : ''}</span>`).join('')}</div></div>`);
  if (c.goals?.length) rows.push(`<div class="cv-row"><span class="cv-l">Objetivos</span><ul class="cv-goals">${c.goals.map((g) => `<li class="${isNewG(g) ? 'cv-new' : ''}">${esc(g)}</li>`).join('')}</ul></div>`);
  if (c.notes) rows.push(`<div class="cv-row"><span class="cv-l">Observações</span><div class="${prev && prev.notes !== c.notes ? 'cv-new' : ''}">${esc(c.notes)}</div></div>`);
  return rows.join('') || '<div class="muted">Sem informações.</div>';
}

// ───────── Contexto aprovado (formulário) ─────────
function contextHtml() {
  const c = data.context;
  const title = `<div class="section-title">${ic('brain', 14)} Contexto <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">— o Claude lê isto antes de cada resumo da pasta</span></div>`;
  if (editing) return title + `<div class="card card-pad" id="ctxForm">${formHtml(editing === 'draft' ? data.draft : c)}</div>`;
  if (!c) {
    const canBoot = data.summarized > 0;
    return title + `<div class="card card-pad empty" style="padding:26px">
      <div class="big">${ic('sparkles', 26)}</div>
      <h3>${busy ? 'Montando o contexto…' : data.draft ? 'Confira a sugestão acima' : 'O contexto é montado automaticamente'}</h3>
      <div style="max-width:520px;margin:0 auto 14px">${busy ? esc(busyMsg || 'O Claude está lendo os resumos desta pasta…')
        : data.draft ? 'Aprove (ou ajuste) a sugestão do Claude e ela vira o contexto da pasta.'
          : canBoot ? `Esta pasta já tem ${data.summarized} ${data.summarized === 1 ? 'reunião resumida' : 'reuniões resumidas'}. O Claude pode montar o contexto a partir ${data.summarized === 1 ? 'dela' : 'delas'} agora.`
            : 'Depois da primeira reunião resumida nesta pasta, o Claude sugere quem participa, do que se trata e os objetivos — você só confere e aprova.'}</div>
      <div class="row" style="justify-content:center;gap:8px">
        ${busy ? ic('loader', 18, 'spin') : `${canBoot && !data.draft ? `<button class="btn primary" id="bootBtn">${ic('sparkles', 14)} Montar a partir das reuniões</button>` : ''}<button class="btn ${canBoot && !data.draft ? 'ghost' : ''}" id="manualBtn">${ic('edit', 14)} Preencher eu mesmo</button>`}
      </div>
    </div>`;
  }
  return title + `<div class="card card-pad">
    <div class="row" style="margin-bottom:10px"><span class="chip ok">${ic('check', 11)} Aprovado</span>${data.contextAt ? `<span class="muted" style="font-size:12px">${fmtDate(data.contextAt)}</span>` : ''}<div class="grow"></div>
      ${data.summarized && !data.draft ? `<button class="btn ghost sm" id="bootBtn" ${busy ? 'disabled' : ''} title="Pede ao Claude para revisar o contexto com base em todos os resumos da pasta">${ic(busy ? 'loader' : 'refresh', 13, busy ? 'spin' : '')} ${busy ? esc(busyMsg || 'Revisando…') : 'Revisar com o Claude'}</button>` : ''}
      <button class="btn sm" id="editCtx">${ic('edit', 13)} Editar</button></div>
    ${contextView(c)}
  </div>`;
}

function formHtml(c) {
  c = c || { about: '', participants: [], goals: [], notes: '' };
  const parts = c.participants?.length ? c.participants : [{ name: '', role: '' }];
  return `<label class="f-l">Sobre o projeto / assunto</label>
    <textarea class="textarea" id="fAbout" rows="2" placeholder="Ex.: Rebranding do site do cliente Tecius, com lançamento previsto para dezembro.">${esc(c.about || '')}</textarea>
    <label class="f-l">Participantes <span class="muted">(nome e papel — ajudam a identificar quem fala e a grafar os nomes)</span></label>
    <div id="fParts">${parts.map(partRow).join('')}</div>
    <button class="btn ghost sm" id="addPart" style="margin-top:6px">${ic('plus', 13)} Adicionar pessoa</button>
    <label class="f-l">Objetivos <span class="muted">(um por linha)</span></label>
    <textarea class="textarea" id="fGoals" rows="3" placeholder="Ex.: Aprovar o novo layout&#10;Definir o cronograma de conteúdo">${esc((c.goals || []).join('\n'))}</textarea>
    <label class="f-l">Observações</label>
    <textarea class="textarea" id="fNotes" rows="2" placeholder="Ex.: O cliente prefere comunicação por e-mail; termos técnicos em inglês.">${esc(c.notes || '')}</textarea>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:14px">
      <button class="btn" id="cancelForm">Cancelar</button>
      <button class="btn primary" id="saveForm">${ic('check', 14)} ${editing === 'draft' ? 'Aprovar com ajustes' : 'Salvar contexto'}</button>
    </div>`;
}

const partRow = (p) => `<div class="part-row"><input class="input pn" placeholder="Nome" value="${esc(p.name || '')}"><input class="input pr" placeholder="Papel (ex.: gerente do projeto)" value="${esc(p.role || '')}"><button class="btn icon sm ghost rm" title="Remover">${ic('x', 13)}</button></div>`;

function readForm() {
  return {
    about: $('#fAbout').value.trim(),
    participants: $$('#fParts .part-row').map((r) => ({ name: r.querySelector('.pn').value.trim(), role: r.querySelector('.pr').value.trim() })).filter((p) => p.name),
    goals: $('#fGoals').value.split('\n').map((s) => s.trim()).filter(Boolean),
    notes: $('#fNotes').value.trim(),
  };
}

// ───────── Glossário ─────────
function glossaryHtml() {
  const g = data.glossary || [];
  return `<div class="section-title">${ic('book', 14)} Glossário <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">— grafias que você confirmou; o MeetRec corrige automaticamente na transcrição</span></div>
  <div class="card" style="padding:6px">
    ${g.length ? `<div class="gl-table">${g.map((t, i) => `<div class="gl-row">
        <span class="gl-term">${esc(t.term)}</span>
        <span class="gl-heard">${t.heard?.length ? `${ic('chevronLeft', 12)} ${t.heard.map((h) => `<span class="chip">${esc(h)}</span>`).join(' ')}` : '<span class="muted" style="font-size:12px">ajuda o Whisper a reconhecer</span>'}</span>
        <span class="muted" style="font-size:11.5px">${t.uses > 1 ? `${t.uses}× confirmado` : ''}</span>
        <button class="btn icon sm ghost" data-rm="${i}" title="Remover do glossário">${ic('trash', 13)}</button>
      </div>`).join('')}</div>`
      : `<div class="muted" style="padding:14px 12px;font-size:13px">Vazio por enquanto. Ele se preenche sozinho quando você corrige um <b>ponto de dúvida</b> no resumo de uma reunião${name ? ' desta pasta' : ''}.</div>`}
    <div class="gl-add"><input class="input" id="glTerm" placeholder="Termo correto (ex.: Tecius)"><input class="input" id="glHeard" placeholder="Como costuma sair errado (opcional)"><button class="btn sm" id="glAdd">${ic('plus', 13)} Adicionar</button></div>
  </div>`;
}

// ───────── Histórico ─────────
function historyHtml() {
  const h = data.history || '';
  return `<div class="section-title">${ic('history', 14)} Histórico <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">— decisões e pendências, atualizado pelo Claude a cada reunião</span></div>
  <div class="card card-pad">
    ${editHistory ? `<textarea class="textarea" id="histIn" rows="10">${esc(h)}</textarea>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:10px"><button class="btn" id="histCancel">Cancelar</button><button class="btn primary" id="histSave">${ic('check', 14)} Salvar</button></div>`
      : h ? `<div class="row" style="margin-bottom:8px">${data.historyAt ? `<span class="muted" style="font-size:12px">Atualizado ${fmtDate(data.historyAt)}</span>` : ''}<div class="grow"></div><button class="btn sm ghost" id="histEdit">${ic('edit', 13)} Editar</button></div><div class="doc hist">${esc(h)}</div>`
        : `<div class="muted" style="font-size:13px">Começa a ser preenchido no próximo resumo de uma reunião desta pasta. Você não precisa escrever nada.</div>`}
  </div>`;
}

// ───────── Ações ─────────
async function refresh() { await load(); if (root) draw(); }

async function bootstrap() {
  if (busy) return;
  busy = true; busyMsg = 'Iniciando o Claude Code…'; draw();
  const r = await api.folders.bootstrap(name);
  busy = false; busyMsg = '';
  if (!r.ok) toast('error', r.error);
  else toast('success', r.message);
  await refresh();
}

function bind() {
  const on = (sel, fn) => { const e = $(sel); if (e) e.onclick = fn; };
  if ($('#descIn')) $('#descIn').onchange = async (e) => {
    const r = await api.folders.update(name, { description: e.target.value });
    if (r.ok) { toast('success', 'Descrição salva.'); ctx.reloadFolders(); } else toast('error', r.error);
  };
  on('#seeMeetings', () => ctx.navigate({ view: 'home', folder: name }));
  on('#openDir', () => api.folders.open(name));
  on('#renameBtn', async () => {
    const v = await promptDialog('Renomear pasta', 'Novo nome:', name);
    if (!v || v === name) return;
    const r = await api.folders.rename(name, v);
    if (!r.ok) return toast('error', r.error);
    toast('success', `Pasta renomeada para “${r.name}”.`);
    await ctx.reloadList();
    ctx.navigate({ view: 'folder', name: r.name });
  });
  on('#delBtn', async () => {
    const ok = await confirmDialog('Excluir pasta?', `As ${data.count} reuniões de “${name}” voltam para “Sem pasta” (nada é apagado). O contexto, o glossário e o histórico da pasta vão para a lixeira.`, 'Excluir pasta', 'danger');
    if (!ok) return;
    const r = await api.folders.remove(name);
    if (!r.ok) return toast('error', r.error);
    toast('success', 'Pasta excluída. As reuniões estão em “Sem pasta”.');
    await ctx.reloadList();
    ctx.navigate({ view: 'home' });
  });
  on('#approveDraft', async () => {
    const r = await api.folders.approveDraft(name);
    if (!r.ok) return toast('error', r.error);
    toast('success', 'Contexto aprovado! Os próximos resumos desta pasta já usam ele.');
    ctx.reloadFolders(); refresh();
  });
  on('#discardDraft', async () => {
    const r = await api.folders.discardDraft(name);
    if (!r.ok) return toast('error', r.error);
    toast('info', 'Sugestão descartada.');
    ctx.reloadFolders(); refresh();
  });
  on('#editDraft', () => { editing = 'draft'; draw(); $('#ctxForm')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  on('#editCtx', () => { editing = 'ctx'; draw(); });
  on('#manualBtn', () => { editing = 'ctx'; draw(); });
  on('#bootBtn', bootstrap);
  on('#addPart', () => { $('#fParts').insertAdjacentHTML('beforeend', partRow({})); bindParts(); $$('#fParts .pn').pop()?.focus(); });
  bindParts();
  on('#cancelForm', () => { editing = false; draw(); });
  on('#saveForm', async () => {
    const c = readForm();
    const r = editing === 'draft' ? await api.folders.approveDraft(name, c) : await api.folders.update(name, { context: c });
    if (!r.ok) return toast('error', r.error);
    toast('success', editing === 'draft' ? 'Contexto aprovado com seus ajustes.' : 'Contexto salvo.');
    editing = false;
    ctx.reloadFolders(); refresh();
  });
  $$('[data-rm]').forEach((b) => (b.onclick = async () => {
    const g = [...data.glossary];
    const [t] = g.splice(+b.dataset.rm, 1);
    const r = await api.folders.update(name, { glossary: g });
    if (!r.ok) return toast('error', r.error);
    toast('success', `“${t.term}” removido do glossário.`);
    ctx.reloadFolders(); refresh();
  }));
  const addTerm = async () => {
    const term = $('#glTerm').value.trim();
    if (!term) { $('#glTerm').focus(); return; }
    const r = await api.folders.addTerm(name, term, $('#glHeard').value.trim());
    if (!r.ok) return toast('error', r.error);
    toast('success', `“${term}” adicionado ao glossário.`);
    ctx.reloadFolders(); refresh();
  };
  on('#glAdd', addTerm);
  ['#glTerm', '#glHeard'].forEach((s) => { const i = $(s); if (i) i.onkeydown = (e) => { if (e.key === 'Enter') addTerm(); }; });
  on('#histEdit', () => { editHistory = true; draw(); });
  on('#histCancel', () => { editHistory = false; draw(); });
  on('#histSave', async () => {
    const r = await api.folders.update(name, { history: $('#histIn').value });
    if (!r.ok) return toast('error', r.error);
    editHistory = false;
    toast('success', 'Histórico salvo.');
    refresh();
  });
}

function bindParts() { $$('#fParts .rm').forEach((b) => (b.onclick = () => { b.closest('.part-row').remove(); })); }

export function onEvent(type, p) {
  if (!root) return;
  if (type === 'folder-status' && p.name === name && busy) {
    busyMsg = p.message;
    const b = $('#bootBtn'); if (b) b.innerHTML = `${ic('loader', 13, 'spin')} ${esc(busyMsg)}`;
    else draw();
  } else if (type === 'folders-reloaded' && !editing && !editHistory && !busy && document.activeElement?.id !== 'descIn' && !document.activeElement?.closest?.('.gl-add')) {
    if (name && !state.folders.some((f) => f.name === name)) return ctx.navigate({ view: 'home' });
    refresh();
  }
}
