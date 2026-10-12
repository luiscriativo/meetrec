// Utilitários de UI: formatação, toasts, modais, cores de falantes.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const ic = (name, size, cls) => window.icon(name, size, cls);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

export function fmtDate(iso, withTime = true) {
  const d = new Date(iso);
  const opts = { day: '2-digit', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  const date = d.toLocaleDateString('pt-BR', opts).replace('.', '');
  return withTime ? `${date} · ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : date;
}

export function dayGroup(iso) {
  const d = new Date(iso); const now = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Ontem';
  if (diff < 7) return 'Esta semana';
  if (diff < 30) return 'Este mês';
  return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase());
}

export function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return 'agora';
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  return `há ${Math.round(s / 3600)} h`;
}

const COLORS = ['#7C5CFF', '#10B981', '#F59E0B', '#3B82F6', '#EC4899', '#14B8A6', '#F97316', '#8B5CF6', '#06B6D4', '#84CC16'];
export function colorFor(name) {
  // FNV-1a: espalha melhor nomes parecidos entre as cores
  let h = 2166136261;
  for (const c of String(name)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return COLORS[h % COLORS.length];
}
export function initials(name) {
  const parts = String(name || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function prettyShortcut(acc) {
  const mac = document.documentElement.classList.contains('platform-darwin');
  return String(acc || '').replace('CommandOrControl', mac ? '⌘' : 'Ctrl').replace('Shift', mac ? '⇧' : 'Shift').replace('Alt', mac ? '⌥' : 'Alt').replace(/\+/g, mac ? '' : '+');
}

// ───────── Toasts ─────────
export function toast(kind, message, opts = {}) {
  const root = $('#toasts');
  const el = document.createElement('div');
  const icons = { success: 'checkCircle', error: 'alertCircle', warn: 'alert', info: 'info' };
  el.className = `toast ${kind}`;
  el.innerHTML = `${ic(icons[kind] || 'info', 18)}<div class="body"><div>${esc(message)}</div>${opts.action ? `<div class="act"><button class="btn sm">${esc(opts.action.label)}</button></div>` : ''}</div><span class="close">${ic('x', 15)}</span>`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  el.querySelector('.close').onclick = close;
  if (opts.action) el.querySelector('.act button').onclick = () => { opts.action.onClick?.(); close(); };
  root.appendChild(el);
  while (root.children.length > 5) root.firstChild.remove();
  const dur = opts.duration || (kind === 'error' ? 10000 : kind === 'warn' ? 7000 : 4000);
  let t = setTimeout(close, dur);
  el.onmouseenter = () => clearTimeout(t);
  el.onmouseleave = () => { t = setTimeout(close, 2500); };
}

// ───────── Modal ─────────
export function modal({ title, body, actions = [], onMount, wide, onClose }) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-bg"><div class="modal" style="${wide ? 'width:min(680px,calc(100vw - 40px))' : ''}"><h3>${esc(title)}</h3><div class="mbody">${body}</div><div class="foot"></div></div></div>`;
  const bg = root.firstChild;
  const foot = root.querySelector('.foot');
  let closed = false;
  const close = () => { if (closed) return; closed = true; root.innerHTML = ''; document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.kind || ''}`;
    b.innerHTML = a.label;
    b.onclick = async () => { const r = await a.onClick?.(root.querySelector('.modal')); if (r !== false) close(); };
    foot.appendChild(b);
  }
  onMount?.(root.querySelector('.modal'), close);
  return close;
}

export function confirmDialog(title, text, okLabel = 'Confirmar', kind = 'primary') {
  return new Promise((resolve) => {
    // Fechar com Esc ou clicando fora conta como "Cancelar"
    modal({
      title, body: `<p class="muted" style="line-height:1.5;margin:4px 0 0">${esc(text)}</p>`,
      onClose: () => resolve(false),
      actions: [
        { label: 'Cancelar', onClick: () => resolve(false) },
        { label: okLabel, kind, onClick: () => resolve(true) },
      ],
    });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    modal({
      title,
      body: `<label class="muted" style="font-size:13px">${esc(label)}</label><input class="input" id="pd" style="margin-top:8px" value="${esc(value)}">`,
      onClose: () => resolve(null),
      onMount: (m, close) => {
        const i = m.querySelector('#pd'); i.focus(); i.select();
        i.onkeydown = (e) => { if (e.key === 'Enter') { resolve(i.value.trim()); close(); } };
      },
      actions: [
        { label: 'Cancelar', onClick: () => resolve(null) },
        { label: 'Salvar', kind: 'primary', onClick: (m) => resolve(m.querySelector('#pd').value.trim()) },
      ],
    });
  });
}

export function popMenu(anchor, items) {
  $$('.menu').forEach((m) => m.remove());
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${ic(it.icon || 'chevronRight', 16)}${esc(it.label)}</button>`).join('');
  anchor.appendChild(m);
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; e.stopPropagation(); m.remove(); items[+b.dataset.i].onClick(); };
  setTimeout(() => document.addEventListener('click', function h(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', h); } }), 0);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
