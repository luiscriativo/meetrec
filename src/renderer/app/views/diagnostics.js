// Diagnóstico: verifica tudo que o app precisa e oferece correções com um clique.
import { state, ctx, api } from '../ctx.js';
import { $, $$, ic, esc, toast } from '../util.js';

let root = null, running = false, logText = '', busyAction = null, micCheck = null;

export function topbar() {
  return `<h1>${ic('activity', 17)} Diagnóstico</h1><div class="grow"></div><button class="btn no-drag" id="rerun">${ic('refresh', 14)} Verificar novamente</button>`;
}

export function render(el) {
  root = el;
  $('#rerun').onclick = rerun;
  draw();
  checkMic();
  if (!state.health) rerun();
}

export function destroy() { root = null; }

async function rerun() {
  if (running) return;
  running = true; draw();
  await Promise.all([ctx.runHealth(), checkMic()]);
  running = false; draw();
}

async function checkMic() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((d) => d.kind === 'audioinput');
    micCheck = mics.length
      ? { id: 'mic', group: 'Áudio', label: 'Microfone', state: 'ok', detail: `${mics.length} dispositivo(s): ${mics.slice(0, 3).map((m) => m.label || 'sem nome').join(', ')}` }
      : { id: 'mic', group: 'Áudio', label: 'Microfone', state: 'error', detail: 'Nenhum microfone encontrado. Conecte um microfone/headset.' };
  } catch (e) {
    micCheck = { id: 'mic', group: 'Áudio', label: 'Microfone', state: 'error', detail: e.message };
  }
  draw();
}

function draw() {
  if (!root) return;
  const checks = [...(micCheck ? [micCheck] : []), ...(state.health || [])];
  const groups = {};
  for (const c of checks) (groups[c.group] = groups[c.group] || []).push(c);
  const errors = checks.filter((c) => c.state === 'error').length;
  const warns = checks.filter((c) => c.state === 'warn').length;
  const stIcon = { ok: 'check', warn: 'alert', error: 'x', info: 'info' };
  root.innerHTML = `<div class="view-inner">
    <div class="card card-pad row" style="gap:16px;margin-bottom:6px">
      <span class="logo" style="width:46px;height:46px;border-radius:14px;background:${running ? 'var(--surface-3)' : errors ? 'var(--rec)' : warns ? 'var(--warn)' : 'var(--ok)'}">${ic(running ? 'loader' : errors ? 'alertCircle' : warns ? 'alert' : 'checkCircle', 22, running ? 'spin' : '')}</span>
      <div class="grow">
        <b style="font-size:16px">${running ? 'Verificando…' : errors ? `${errors} problema(s) precisam de atenção` : warns ? 'Tudo funcionando, com avisos' : 'Tudo pronto para gravar e resumir ✨'}</b>
        <div class="muted" style="font-size:13px;margin-top:3px">${running ? 'Checando microfone, áudio do sistema, motor de transcrição e Claude Code.' : 'Itens vermelhos impedem alguma etapa; amarelos são recomendações.'}</div>
      </div>
    </div>
    ${Object.entries(groups).map(([g, cs]) => `<div class="section-title">${esc(g)}</div><div class="card checks">${cs.map((c) => `
      <div class="check">
        <span class="st ${c.state}">${ic(stIcon[c.state] || 'info', 16)}</span>
        <div><div class="l">${esc(c.label)}</div><div class="d">${esc(c.detail)}</div></div>
        <div>${c.action ? `<button class="btn sm ${c.state === 'error' ? 'primary' : ''}" data-act="${c.action.id}" ${busyAction ? 'disabled' : ''}>${busyAction === c.action.id ? ic('loader', 13, 'spin') : ''} ${esc(c.action.label)}</button>` : ''}</div>
      </div>`).join('')}</div>`).join('')}
    ${!checks.length ? `<div class="empty">${ic('loader', 24, 'spin')}</div>` : ''}
    ${logText ? `<div class="section-title">Log</div><div class="log" id="log">${esc(logText)}</div>` : ''}
    <div class="section-title">Como funciona</div>
    <div class="card card-pad" style="line-height:1.6;color:var(--text-2);font-size:13.5px">
      <b>1. Gravação</b> — o microfone e o som do computador são gravados em faixas separadas (e uma mixada para ouvir), salvas em blocos a cada segundo: se o app fechar, nada se perde.<br>
      <b>2. Transcrição</b> — cada faixa é transcrita pelo Whisper (local ou nuvem). Separar as faixas permite saber o que <i>você</i> disse e o que os <i>outros</i> disseram.<br>
      <b>3. Falantes</b> — com a extensão do navegador, os nomes vêm do Teams/Meet (indicador de fala e legendas). Você também pode renomear falantes na transcrição.<br>
      <b>4. Resumo</b> — o motor escolhido em Configurações → Resumo (<span class="inline-code">claude -p</span> do Claude Code ou <span class="inline-code">codex exec</span> do Codex CLI, com o login da sua conta) recebe a transcrição, suas anotações e o contexto da pasta, e escreve o resumo no formato da sua skill <span class="inline-code">resumo-reuniao</span>.
    </div>
  </div>`;
  $$('[data-act]', root).forEach((b) => (b.onclick = () => doAction(b.dataset.act)));
  const lg = $('#log'); if (lg) lg.scrollTop = lg.scrollHeight;
}

async function doAction(a) {
  busyAction = a;
  if ((['install-whisper', 'download-model'].includes(a) || a.startsWith('test-claude') || a.startsWith('test-codex'))) logText = '';
  draw();
  const r = await api.diag.action(a);
  busyAction = null;
  if (r.message) toast(r.ok ? 'success' : 'error', r.message, { duration: 6000 });
  if ((['install-whisper', 'download-model', 'test-cloud', 'test-claude', 'test-codex'].includes(a))) await rerun(); else draw();
}

export function onEvent(type, p) {
  if (!root) return;
  if (type === 'diag-log') {
    logText += p;
    if (logText.length > 40000) logText = logText.slice(-30000);
    const lg = $('#log');
    if (lg) { lg.textContent = logText; lg.scrollTop = lg.scrollHeight; } else draw();
  } else if (type === 'health' && !running) draw();
}
