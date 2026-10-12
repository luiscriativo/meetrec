const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: 'status' });
  const pill = $('pill');
  if (st?.ok) {
    pill.className = 'pill ' + (st.recording ? 'rec' : 'ok');
    pill.textContent = st.recording ? '● Gravando' : 'Conectado';
    $('conn').innerHTML = `<span class="ok">✓ Conectado ao app MeetRec${st.version ? ` v${esc(st.version)}` : ''}</span>`;
    $('ctl').hidden = false;
    $('toggle').className = st.recording ? 'rec' : 'primary';
    $('toggle').textContent = st.recording ? '■ Parar gravação' : '● Gravar';
    $('marker').disabled = !st.recording;
  } else {
    pill.className = 'pill';
    pill.textContent = 'Desconectado';
    $('conn').innerHTML = `<span class="err">✕ ${esc(st?.error || 'Sem conexão')}</span><div class="muted">Abra o MeetRec no computador e confira o código.</div>`;
    $('ctl').hidden = true;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'debug' });
    if (info) {
      $('tab').innerHTML = `<b>${esc(info.platform)}</b> · ${info.inCall ? '<span class="ok">em chamada</span>' : 'fora de chamada'}
        ${info.title ? `<div class="muted">${esc(info.title)}</div>` : ''}
        ${info.inCall ? `<div class="muted">Falando agora: ${esc(info.speaking.join(', ') || '—')}</div>
        <div class="muted">Participantes vistos: ${info.participants.length} · Legendas lidas: ${info.captions}</div>
        ${info.captions ? '' : '<div class="muted">⚠ Legendas não detectadas — ative-as para nomes mais precisos.</div>'}` : ''}`;
    }
  } catch { /* aba sem content script */ }
}

(async () => {
  const c = await chrome.storage.local.get(['token', 'port']);
  $('token').value = c.token || '';
  $('port').value = c.port || 47321;
  $('save').onclick = async () => {
    await chrome.storage.local.set({ token: $('token').value.trim().toUpperCase(), port: Number($('port').value) || 47321 });
    $('save').textContent = 'Salvo ✓';
    setTimeout(() => ($('save').textContent = 'Salvar'), 1500);
    refresh();
  };
  $('port').onchange = $('save').onclick;
  $('toggle').onclick = async () => { $('toggle').disabled = true; await chrome.runtime.sendMessage({ type: 'command', action: 'toggle' }); $('toggle').disabled = false; refresh(); };
  $('marker').onclick = async () => { await chrome.runtime.sendMessage({ type: 'command', action: 'marker' }); $('marker').textContent = '✓ Marcado'; setTimeout(() => ($('marker').textContent = '⚑ Marcar'), 1500); };
  refresh();
  setInterval(refresh, 2500);
})();
