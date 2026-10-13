// Diálogos compartilhados das pastas: criar pasta e escolher a pasta de destino de uma reunião.
import { state, ctx, api } from './ctx.js';
import { $, $$, ic, esc, toast, modal } from './util.js';

// Cria uma pasta (nome + descrição opcional). Resolve com o nome criado ou null.
export function createFolderDialog() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const submit = async (m) => {
      const name = m.querySelector('#nfName').value;
      const description = m.querySelector('#nfDesc').value;
      const r = await api.folders.create(name, description);
      if (!r.ok) { m.querySelector('#nfErr').textContent = r.error; m.querySelector('#nfName').focus(); return false; }
      await ctx.reloadFolders();
      toast('success', `Pasta "${r.name}" criada. As reuniões dela vão compartilhar contexto, glossário e histórico.`);
      finish(r.name);
      return true;
    };
    modal({
      title: 'Nova pasta',
      body: `<label class="muted" style="font-size:13px">Nome da pasta</label>
        <input class="input" id="nfName" style="margin-top:6px" placeholder="Ex.: Cliente Tecius, Time de Produto, 1:1 com a Ana">
        <label class="muted" style="font-size:13px;display:block;margin-top:14px">Do que se trata? <span style="opacity:.75">(opcional — uma linha já ajuda o Claude)</span></label>
        <input class="input" id="nfDesc" style="margin-top:6px" placeholder="Ex.: Projeto de rebranding do site do cliente">
        <div class="field-err" id="nfErr"></div>
        <div class="muted" style="font-size:12px;margin-top:12px;line-height:1.5">${ic('sparkles', 12)} Você não precisa escrever mais nada: depois da primeira reunião, o Claude monta o contexto da pasta e você só confere.</div>`,
      onClose: () => finish(null),
      onMount: (m, close) => {
        const i = m.querySelector('#nfName');
        i.focus();
        const onEnter = async (e) => { if (e.key === 'Enter' && await submit(m)) close(); };
        i.onkeydown = onEnter;
        m.querySelector('#nfDesc').onkeydown = onEnter;
      },
      actions: [
        { label: 'Cancelar', onClick: () => finish(null) },
        { label: `${ic('folder', 14)} Criar pasta`, kind: 'primary', onClick: (m) => submit(m) },
      ],
    });
  });
}

// Escolhe para qual pasta mover a reunião. Resolve com o nome ('' = Sem pasta) ou null se cancelar.
export function pickFolderDialog(current = '', title = 'Mover para a pasta') {
  return new Promise((resolve) => {
    let done = false, chaining = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const opts = [{ name: '', label: 'Sem pasta', icon: 'list' }, ...state.folders.map((f) => ({ name: f.name, label: f.name, icon: 'folder', count: f.count }))];
    modal({
      title,
      body: `<div class="folder-pick">${opts.map((o) => `<button class="fp ${o.name === current ? 'cur' : ''}" data-f="${esc(o.name)}" ${o.name === current ? 'disabled' : ''}>${ic(o.icon, 16)}<span class="grow">${esc(o.label)}</span>${o.name === current ? '<span class="muted" style="font-size:12px">atual</span>' : o.count != null ? `<span class="muted" style="font-size:12px">${o.count}</span>` : ''}</button>`).join('')}
        <button class="fp new" id="fpNew">${ic('plus', 16)}<span class="grow">Nova pasta…</span></button></div>`,
      onClose: () => { if (!chaining) finish(null); },
      onMount: (m, close) => {
        $$('.fp[data-f]', m).forEach((b) => (b.onclick = () => { finish(b.dataset.f); close(); }));
        m.querySelector('#fpNew').onclick = async () => {
          chaining = true; // fechar este diálogo não é "cancelar": abre o de nova pasta
          close();
          finish(await createFolderDialog());
        };
      },
      actions: [{ label: 'Cancelar', onClick: () => finish(null) }],
    });
  });
}

// Move a reunião mostrando o resultado (o processo principal manda o toast de sucesso)
export async function moveMeeting(id, folder) {
  const r = await api.lib.move(id, folder);
  if (!r.ok) toast('error', r.error);
  else await ctx.reloadFolders();
  return r.ok;
}
