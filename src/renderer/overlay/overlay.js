// Indicador flutuante (sempre visível) — estilo Notion.
// `api` é exposto globalmente pelo preload (contextBridge)
const pill = document.getElementById('pill');
const note = document.getElementById('note');
const wrap = document.getElementById('wrap');

let mode = null, data = {}, rec = {}, speaking = [], platform = null;
let noteTimer = null;

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bars = (n = 5) => `<span class="bars">${'<i></i>'.repeat(n)}</span>`;

function fit() { requestAnimationFrame(() => api.overlay.resize(wrap.getBoundingClientRect().height)); }

function subtitle() {
  if (rec.paused) return 'Pausado — clique em ▶ para continuar';
  if (speaking.length) return `<span class="speaker-chip"><span class="live"></span><b>${esc(speaking.slice(0, 2).join(', '))}</b> falando</span>`;
  const parts = [];
  if (rec.tracks?.mic) parts.push('Mic');
  if (rec.tracks?.system) parts.push('som do PC');
  return (platform ? esc(platform) + ' · ' : '') + (parts.join(' + ') || 'Capturando áudio');
}

function render() {
  const b = (action, ic, title, cls = '') => `<button class="btn ${cls}" data-a="${action}" title="${title}">${icon(ic, 17)}</button>`;
  if (mode === 'recording') {
    pill.innerHTML = `
      <span class="dot ${rec.paused ? 'paused' : ''}"></span>
      <div class="txt">
        <div class="t1">${rec.paused ? 'Pausado' : 'Gravando'} <span class="timer" id="timer">${fmt(rec.elapsed)}</span></div>
        <div class="t2" id="sub">${subtitle()}</div>
      </div>
      <div class="meters">
        <span class="meter mic ${rec.tracks?.mic ? '' : 'off'}" title="Seu microfone">${icon(rec.tracks?.mic ? 'mic' : 'micOff', 14)}${bars()}</span>
        <span class="meter sys ${rec.tracks?.system ? '' : 'off'}" title="Som do computador (participantes)">${icon('speaker', 14)}${bars()}</span>
      </div>
      <div class="btns">
        ${b('marker', 'flag', 'Marcar momento importante')}
        ${b('pause', rec.paused ? 'play' : 'pause', rec.paused ? 'Retomar' : 'Pausar')}
        ${b('stop', 'stop', 'Parar e salvar', 'stop')}
        ${b('open', 'external', 'Abrir o MeetRec')}
      </div>`;
  } else if (mode === 'starting' || mode === 'saving') {
    pill.innerHTML = `
      <span class="icon-badge info">${icon('loader', 18, 'spin')}</span>
      <div class="txt"><div class="t1">${mode === 'starting' ? 'Iniciando gravação…' : 'Salvando gravação…'}</div>
      <div class="t2">${mode === 'starting' ? 'Conectando ao microfone e ao som do computador' : 'Finalizando os arquivos de áudio'}</div></div>`;
  } else if (mode === 'saved') {
    pill.innerHTML = `
      <span class="icon-badge ok">${icon('check', 18)}</span>
      <div class="txt"><div class="t1">${esc(data.message || 'Gravação salva')} ${data.duration ? `<span class="timer">${fmt(data.duration)}</span>` : ''}</div>
      <div class="t2">${data.processing ? 'Transcrevendo e resumindo em segundo plano…' : 'Pronto para transcrever quando quiser'}</div></div>
      <div class="btns"><button class="btn ghost" data-a="open">Abrir</button>${b('hide', 'x', 'Fechar')}</div>`;
  } else if (mode === 'ready') {
    pill.innerHTML = `
      <span class="icon-badge info">${icon('sparkles', 18)}</span>
      <div class="txt"><div class="t1">Resumo pronto</div><div class="t2">${esc(data.title)}</div></div>
      <div class="btns"><button class="btn primary" data-a="open-last">Ver resumo</button>${b('hide', 'x', 'Fechar')}</div>`;
  } else if (mode === 'error') {
    pill.innerHTML = `
      <span class="icon-badge err">${icon('alertCircle', 18)}</span>
      <div class="txt"><div class="t1">Não foi possível gravar</div><div class="t2" title="${esc(data.message)}">${esc(data.message)}</div></div>
      <div class="btns">${b('open', 'external', 'Abrir o MeetRec')}${b('hide', 'x', 'Fechar')}</div>`;
  } else if (mode === 'suggest') {
    pill.innerHTML = `
      <span class="icon-badge info">${icon('mic', 18)}</span>
      <div class="txt"><div class="t1">${esc(data.text || 'Reunião detectada')}</div><div class="t2">Quer gravar e resumir esta reunião?</div></div>
      <div class="btns"><button class="btn primary" data-a="start">${icon('record', 12)} Gravar</button>${b('hide', 'x', 'Agora não')}</div>`;
  } else if (mode === 'suggest-stop') {
    pill.innerHTML = `
      <span class="dot"></span>
      <div class="txt"><div class="t1">${esc(data.text || 'A reunião terminou?')}</div><div class="t2">Gravando há <span id="timer">${fmt(rec.elapsed)}</span></div></div>
      <div class="btns"><button class="btn ghost" data-a="dismiss">Continuar</button><button class="btn primary" style="background:#FF4560" data-a="stop">${icon('stop', 12)} Parar</button></div>`;
  }
  fit();
}

pill.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-a]');
  if (btn) api.overlay.action(btn.dataset.a);
});

function showNote(w) {
  clearTimeout(noteTimer);
  const lvl = w.level || 'warn';
  const ic = lvl === 'error' ? 'alertCircle' : lvl === 'ok' ? 'checkCircle' : lvl === 'info' ? 'info' : 'alert';
  note.className = `note ${lvl}`;
  note.innerHTML = `${icon(ic, 15)}<span>${esc(w.message)}</span><span class="x" title="Dispensar">${icon('x', 14)}</span>`;
  note.hidden = false;
  note.querySelector('.x').onclick = () => { note.hidden = true; fit(); };
  fit();
  noteTimer = setTimeout(() => { note.hidden = true; fit(); }, lvl === 'ok' || lvl === 'info' ? 5000 : 15000);
}

api.on((type, p) => {
  if (type === 'overlay-mode') {
    mode = p.mode; data = p; rec = p.rec || {};
    if (mode !== 'recording' && mode !== 'suggest-stop') note.hidden = true;
    render();
  } else if (type === 'rec-state') {
    rec = p;
    if (mode === 'recording') render();
  } else if (type === 'rec-tick') {
    rec.elapsed = p.elapsed;
    const t = document.getElementById('timer');
    if (t) t.textContent = fmt(p.elapsed);
  } else if (type === 'levels' && mode === 'recording') {
    for (const [cls, v] of [['mic', p.mic], ['sys', p.system]]) {
      const is = document.querySelectorAll(`.meter.${cls} .bars i`);
      const shape = [0.55, 0.85, 1, 0.75, 0.5];
      is.forEach((el, i) => {
        const h = 4 + Math.round(Math.min(1, v * 1.25) * 14 * shape[i] * (0.8 + Math.random() * 0.4));
        el.style.height = h + 'px';
        el.classList.toggle('on', v > 0.08);
      });
    }
  } else if (type === 'rec-warning' && (mode === 'recording' || mode === 'suggest-stop')) {
    showNote(p);
  } else if (type === 'marker-added' && mode === 'recording') {
    showNote({ level: 'ok', message: `Momento marcado em ${fmt(p.t)}` });
  } else if (type === 'bridge') {
    speaking = p.connected && p.inCall ? (p.speaking || []) : [];
    platform = p.inCall ? p.platform : null;
    const sub = document.getElementById('sub');
    if (sub && mode === 'recording') sub.innerHTML = subtitle();
  }
});
