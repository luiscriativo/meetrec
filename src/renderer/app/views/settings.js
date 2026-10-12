// Configurações.
import { state, ctx, api } from '../ctx.js';
import { $, $$, ic, esc, toast, prettyShortcut, relTime, confirmDialog } from '../util.js';

let root = null, sec = 'general', testStream = null, testRaf = null;

const SECTIONS = [
  ['general', 'settings', 'Geral'],
  ['audio', 'mic', 'Áudio e gravação'],
  ['transcription', 'fileText', 'Transcrição'],
  ['summary', 'sparkles', 'Resumo (Claude)'],
  ['integrations', 'plug', 'Integrações'],
  ['shortcuts', 'keyboard', 'Atalhos'],
];

const MODELS = [
  ['tiny', 'Tiny', 'Muito rápido, menos preciso (~75 MB)'],
  ['base', 'Base', 'Rápido (~150 MB)'],
  ['small', 'Small', 'Equilíbrio recomendado (~480 MB)'],
  ['medium', 'Medium', 'Mais preciso, mais lento (~1,5 GB)'],
  ['large-v3-turbo', 'Large v3 Turbo', 'Ótima precisão, pesado (~1,6 GB)'],
  ['large-v3', 'Large v3', 'Máxima precisão, bem lento em CPU (~3 GB)'],
];

export function topbar() { return `<h1>${ic('settings', 17)} Configurações</h1>`; }

export function render(el, route) {
  root = el;
  if (route.tab) sec = route.tab;
  el.innerHTML = `<div class="view-inner"><div class="settings">
    <div class="settings-nav" id="snav"></div>
    <div id="sbody"></div>
  </div></div>`;
  draw();
}

export function destroy() { stopTest(); root = null; }

function draw() {
  $('#snav').innerHTML = SECTIONS.map(([k, i, l]) => `<button data-s="${k}" class="${sec === k ? 'active' : ''}">${ic(i, 16)}${l}</button>`).join('');
  $$('#snav button').forEach((b) => (b.onclick = () => { stopTest(); sec = b.dataset.s; draw(); }));
  const body = $('#sbody');
  ({ general, audio, transcription, summary, integrations, shortcuts })[sec](body);
  bindGeneric(body);
}

async function save(patch, msg = 'Configuração salva.') {
  state.settings = await api.setSettings(patch);
  toast('success', msg, { duration: 1800 });
  ctx.refreshSidebar();
}

// Campos com data-k são salvos automaticamente
function bindGeneric(body) {
  $$('[data-k]', body).forEach((inp) => {
    const k = inp.dataset.k;
    const evt = inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'change';
    inp.addEventListener(evt, async () => {
      const v = inp.type === 'checkbox' ? inp.checked : inp.dataset.num ? Number(inp.value) : inp.value;
      await save({ [k]: v });
      if (inp.dataset.redraw) draw();
      if (inp.dataset.health) ctx.runHealth();
    });
  });
}

const sw = (k, on, extra = '') => `<label class="switch"><input type="checkbox" data-k="${k}" ${on ? 'checked' : ''} ${extra}><span></span></label>`;
const field = (lbl, desc, ctl, cls = '') => `<div class="field ${cls}"><div><div class="lbl">${lbl}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div><div class="ctl">${ctl}</div></div>`;

function general(b) {
  const s = state.settings;
  b.innerHTML = `<div class="card" id="updCard" style="margin-bottom:14px">${updateField()}</div>
  <div class="card">
    ${field('Seu nome', 'Como suas falas (microfone) aparecem na transcrição e no resumo.', `<input class="input" data-k="userName" value="${esc(s.userName)}" placeholder="Ex.: Luis">`)}
    ${field('Pasta das gravações', esc(s.storageDir), `<button class="btn" id="pickDir">${ic('folder', 14)} Alterar…</button><button class="btn ghost icon" id="openDir" title="Abrir">${ic('external', 15)}</button>`)}
    ${field('Transcrever e resumir automaticamente', 'Ligado: ao parar, já transcreve e resume em segundo plano (com prioridade baixa, e esperando se outra gravação começar). Desligado: só grava — depois use "Processar pendentes" na lista para fazer tudo de uma vez.', sw('autoProcess', s.autoProcess))}
    ${field('Iniciar com o sistema', 'Abre o MeetRec minimizado na bandeja quando você liga o computador.', sw('launchAtLogin', s.launchAtLogin))}
    ${field('Iniciar minimizado', 'Ao abrir, fica só na bandeja (ícone perto do relógio).', sw('startHidden', s.startHidden))}
    ${field('Tema', '', `<select class="select" data-k="theme" style="width:200px"><option value="system" ${s.theme === 'system' ? 'selected' : ''}>Automático (sistema)</option><option value="light" ${s.theme === 'light' ? 'selected' : ''}>Claro</option><option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Escuro</option></select>`)}
    ${field('Notificações do sistema', 'Avisos de início/fim de gravação, resumo pronto e erros.', sw('notifications', s.notifications))}
    ${field('Sons', 'Sinal sonoro discreto ao iniciar, parar e marcar momentos.', sw('sounds', s.sounds))}
  </div>`;
  bindUpdate();
  $('#pickDir').onclick = async () => {
    if (state.rec.active) return toast('warn', 'Pare a gravação antes de trocar a pasta das gravações.');
    const d = await api.pickFolder();
    if (d) { await save({ storageDir: d }, 'Pasta alterada. Novas gravações serão salvas lá.'); await ctx.reloadList(); draw(); }
  };
  $('#openDir').onclick = () => api.lib.openFolder();
}

function updateText(u) {
  const when = u.checkedAt ? ` · verificado às ${new Date(u.checkedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '';
  switch (u.state) {
    case 'dev': return 'Modo de desenvolvimento: a atualização automática funciona só no app instalado.';
    case 'checking': return 'Procurando uma versão nova…';
    case 'not-available': return `Você está na versão mais recente${when}.`;
    case 'available': return u.manual ? `Versão ${u.version} disponível — baixe pelo site (esta instalação não se atualiza sozinha).` : `Versão ${u.version} disponível para baixar.`;
    case 'downloading': return `Baixando a versão ${u.version}… ${u.percent || 0}%`;
    case 'downloaded': return `Versão ${u.version} baixada — instala ao reiniciar ou ao fechar o app.`;
    case 'error': return u.error || 'Falha ao verificar.';
    default: return `O MeetRec verifica sozinho a cada 6 horas e avisa quando sair uma versão nova${when}.`;
  }
}

function updateField() {
  const u = state.update || {};
  const busy = u.state === 'checking' || u.state === 'downloading';
  const btn = u.state === 'available'
    ? `<button class="btn primary" id="updAct">${ic(u.manual ? 'external' : 'download', 14)} ${u.manual ? 'Baixar no site' : 'Baixar'}</button>`
    : u.state === 'downloaded'
      ? `<button class="btn primary" id="updAct">${ic('refresh', 14)} Reiniciar e instalar</button>`
      : `<button class="btn" id="updAct" ${busy || u.state === 'dev' ? 'disabled' : ''}>${ic(busy ? 'loader' : 'refresh', 14, busy ? 'spin' : '')} Verificar agora</button>`;
  return field(`MeetRec v${esc(state.info.version || '')}`, esc(updateText(u)), btn);
}

function bindUpdate() {
  const b = $('#updAct');
  if (!b) return;
  b.onclick = async () => {
    const u = state.update || {};
    if (u.state === 'available') return api.update.download();
    if (u.state === 'downloaded') {
      if (state.rec.active) return toast('warn', 'Pare a gravação antes de instalar a atualização.');
      toast('info', 'Fechando o MeetRec para instalar a atualização…');
      return api.update.install();
    }
    await api.update.check();
  };
}

async function audio(b) {
  const s = state.settings;
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const mics = devs.filter((d) => d.kind === 'audioinput');
  const isLinux = state.info.platform === 'linux';
  const opt = (d, cur) => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || 'Microfone ' + d.deviceId.slice(0, 6))}</option>`;
  b.innerHTML = `
    <div class="banner info">${ic('info', 16)}<span><b>Dica:</b> use fones de ouvido nas reuniões. Assim sua voz (microfone) e a dos participantes (som do PC) ficam bem separadas e a transcrição sai mais limpa. Se usar caixas de som, o MeetRec remove o eco duplicado automaticamente.</span></div>
    <div class="card">
      ${field('Microfone', `${mics.length} dispositivo(s) encontrado(s).`, `<select class="select" data-k="micDeviceId">${mics.map((d) => opt(d, s.micDeviceId)).join('')}</select>`)}
      <div class="field"><div><div class="lbl">Testar microfone</div><div class="desc" id="testDesc">Fale algo e veja o nível.</div></div><div class="ctl"><div class="meter-bar" style="width:180px"><i id="testBar"></i></div><button class="btn sm" id="testBtn">${ic('mic', 13)} Testar</button></div></div>
      ${field('Gravar som do computador', 'Captura o que toca no PC (as pessoas da reunião). ' + (state.info.platform === 'darwin' ? 'No macOS, exige permissão de "Gravação de Tela e Áudio do Sistema".' : ''), sw('captureSystem', s.captureSystem))}
      ${isLinux ? field('Fonte do áudio do sistema (Linux)', 'Escolha o dispositivo "Monitor of …" da sua saída de som.', `<select class="select" data-k="systemDeviceId"><option value="">— Selecione —</option>${mics.map((d) => opt(d, s.systemDeviceId)).join('')}</select>`) : ''}
      ${field('Cancelamento de eco', 'Reduz o som das caixas captado pelo microfone.', sw('echoCancellation', s.echoCancellation))}
      ${field('Supressão de ruído', 'Filtra ruídos de fundo do microfone.', sw('noiseSuppression', s.noiseSuppression))}
    </div>
    <div class="section-title">Indicador de gravação</div>
    <div class="card">
      ${field('Mostrar indicador flutuante', 'Pílula sempre visível com tempo, níveis de áudio e botões (estilo Notion). Arraste para mudar a posição.', sw('showOverlay', s.showOverlay))}
      ${field('Ocultar o indicador em compartilhamentos de tela', 'Quando você compartilha a tela no Teams/Meet, o indicador não aparece para os outros.', sw('hideOverlayInShare', s.hideOverlayInShare))}
    </div>`;
  $('#testBtn').onclick = toggleTest;
}

async function toggleTest() {
  if (testStream) { stopTest(); return; }
  try {
    const id = state.settings.micDeviceId;
    testStream = await navigator.mediaDevices.getUserMedia({ audio: id && id !== 'default' ? { deviceId: { exact: id } } : true });
  } catch (e) {
    toast('error', `Não consegui acessar o microfone: ${e.message}`);
    return;
  }
  const ctxA = new AudioContext();
  const an = ctxA.createAnalyser();
  an.fftSize = 1024;
  ctxA.createMediaStreamSource(testStream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let maxSeen = 0;
  $('#testBtn').innerHTML = `${ic('stop', 12)} Parar`;
  $('#testDesc').textContent = `Ouvindo: ${testStream.getAudioTracks()[0].label}`;
  const loop = () => {
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
    const lv = Math.max(0, Math.min(1, (db + 60) / 60));
    maxSeen = Math.max(maxSeen, lv);
    const bar = $('#testBar');
    if (!bar) return stopTest();
    bar.style.width = lv * 100 + '%';
    $('#testDesc').textContent = maxSeen > 0.35 ? 'Microfone funcionando ✓' : maxSeen > 0.1 ? 'Sinal baixo — fale mais perto ou aumente o volume do microfone.' : 'Fale algo…';
    testRaf = requestAnimationFrame(loop);
  };
  testStream.ctxA = ctxA;
  loop();
}

function stopTest() {
  cancelAnimationFrame(testRaf);
  if (testStream) { testStream.getTracks().forEach((t) => t.stop()); try { testStream.ctxA.close(); } catch {} testStream = null; }
  const b = $('#testBtn'); if (b) b.innerHTML = `${ic('mic', 13)} Testar`;
  const bar = $('#testBar'); if (bar) bar.style.width = '0';
}

function transcription(b) {
  const s = state.settings;
  const eng = (k, t, d, badge) => `<div class="engine ${s.engine === k ? 'active' : ''}" data-eng="${k}"><h4>${t}${badge ? `<span class="chip ${badge[1]}" style="height:18px;font-size:10.5px">${badge[0]}</span>` : ''}</h4><p>${d}</p></div>`;
  b.innerHTML = `
    <div class="card card-pad">
      <div class="lbl" style="font-weight:600;margin-bottom:10px">Motor de transcrição</div>
      <div class="engine-cards">
        ${eng('local', `${ic('shield', 14)} Local (Whisper)`, 'Roda no seu PC. Privado e gratuito. Mais lento em CPU.', ['privado', 'ok'])}
        ${eng('groq', `${ic('bolt', 14)} Groq`, 'Whisper Large v3 na nuvem. Muito rápido; plano gratuito generoso.', ['rápido', 'accent'])}
        ${eng('openai', `${ic('globe', 14)} OpenAI`, 'Whisper da OpenAI. Pago por minuto de áudio.', null)}
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      ${s.engine === 'local' ? `
        ${field('Modelo Whisper', 'Modelos maiores são mais precisos e mais lentos. O download acontece na primeira vez.', `<select class="select" data-k="localModel" data-health="1">${MODELS.map(([k, n, d]) => `<option value="${k}" ${s.localModel === k ? 'selected' : ''}>${n} — ${d}</option>`).join('')}</select>`)}
        ${field('Python', 'Deixe vazio para detectar automaticamente.', `<input class="input" data-k="pythonPath" data-health="1" value="${esc(s.pythonPath)}" placeholder="auto (python / python3)">`)}
        <div class="field"><div><div class="lbl">Instalação do motor local</div><div class="desc">Instala o pacote faster-whisper e baixa o modelo escolhido.</div></div><div class="ctl"><button class="btn" id="goDiag">${ic('activity', 14)} Ir para o diagnóstico</button></div></div>
      ` : ''}
      ${s.engine === 'groq' ? field('Chave de API do Groq', 'Crie em <a href="#" data-url="https://console.groq.com/keys">console.groq.com/keys</a>. Fica salva criptografada neste computador.', `<input class="input" type="password" data-k="groqKey" data-health="1" value="${esc(s.groqKey)}" placeholder="gsk_…">`) : ''}
      ${s.engine === 'openai' ? field('Chave de API da OpenAI', 'Crie em <a href="#" data-url="https://platform.openai.com/api-keys">platform.openai.com/api-keys</a>. Fica salva criptografada.', `<input class="input" type="password" data-k="openaiKey" data-health="1" value="${esc(s.openaiKey)}" placeholder="sk-…">`) : ''}
      ${field('Idioma das reuniões', '', `<select class="select" data-k="language"><option value="pt" ${s.language === 'pt' ? 'selected' : ''}>Português</option><option value="en" ${s.language === 'en' ? 'selected' : ''}>Inglês</option><option value="es" ${s.language === 'es' ? 'selected' : ''}>Espanhol</option><option value="" ${!s.language ? 'selected' : ''}>Detectar automaticamente</option></select>`)}
      ${field('Vocabulário', 'Nomes de pessoas, empresas, siglas e termos técnicos que aparecem nas reuniões (separados por vírgula). Ajuda o Whisper a acertar.', `<textarea class="textarea" data-k="vocabulary" rows="3" placeholder="Ex.: PlanMat, SAP HANA, Libra APS, Ana Souza">${esc(s.vocabulary)}</textarea>`, 'stack')}
    </div>`;
  $$('[data-eng]', b).forEach((c) => (c.onclick = async () => { await save({ engine: c.dataset.eng }, 'Motor de transcrição alterado.'); ctx.runHealth(); draw(); }));
  $$('[data-url]', b).forEach((a) => (a.onclick = (e) => { e.preventDefault(); api.open(a.dataset.url); }));
  if ($('#goDiag')) $('#goDiag').onclick = () => ctx.navigate('diagnostics');
}

function summary(b) {
  const s = state.settings;
  const h = state.health || [];
  const claude = h.find((c) => c.id === 'claude');
  const skill = h.find((c) => c.id === 'skill');
  b.innerHTML = `
    <div class="card card-pad" style="display:flex;gap:14px;align-items:center">
      <span class="logo" style="width:40px;height:40px;border-radius:12px">${ic('terminal', 20)}</span>
      <div class="grow"><b>Claude Code CLI</b><div class="muted" style="font-size:12.5px;margin-top:2px">${claude ? esc(claude.detail) : 'Verificando…'}</div></div>
      <span class="chip ${claude?.state === 'ok' ? 'ok' : 'err'}">${claude?.state === 'ok' ? 'Conectado' : 'Não encontrado'}</span>
      <button class="btn" id="testClaude">${ic('bolt', 14)} Testar</button>
    </div>
    <div class="card" style="margin-top:14px">
      ${field('Caminho do Claude Code', 'Deixe vazio para detectar automaticamente.', `<input class="input" data-k="claudePath" data-health="1" value="${esc(s.claudePath)}" placeholder="auto (claude)">`)}
      ${field('Modelo', 'Modelo usado pelo Claude Code para resumir e responder.', `<select class="select" data-k="claudeModel"><option value="" ${!s.claudeModel ? 'selected' : ''}>Padrão do Claude Code</option><option value="sonnet" ${s.claudeModel === 'sonnet' ? 'selected' : ''}>Sonnet (rápido)</option><option value="opus" ${s.claudeModel === 'opus' ? 'selected' : ''}>Opus (máxima qualidade)</option><option value="haiku" ${s.claudeModel === 'haiku' ? 'selected' : ''}>Haiku (mais econômico)</option></select>`)}
      ${field('Usar a skill "resumo-reuniao"', skill ? esc(skill.detail) : 'Usa o formato da sua skill (~/.claude/skills/resumo-reuniao) no resumo.', sw('useSkill', s.useSkill, 'data-health="1"'))}
      ${field('Instruções adicionais para o resumo', 'Ex.: "Destaque riscos e dependências", "Escreva em inglês", "Inclua uma seção de próximos passos".', `<textarea class="textarea" data-k="customInstructions" rows="3">${esc(s.customInstructions)}</textarea>`, 'stack')}
    </div>`;
  $('#testClaude').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.innerHTML = `${ic('loader', 14, 'spin')} Testando…`;
    const r = await api.diag.action('test-claude');
    btn.disabled = false; btn.innerHTML = `${ic('bolt', 14)} Testar`;
    toast(r.ok ? 'success' : 'error', r.message);
  };
}

function integrations(b) {
  const s = state.settings;
  const st = state.bridge;
  const extDir = state.info.extensionDir;
  b.innerHTML = `
    <div class="card card-pad">
      <div class="row" style="margin-bottom:10px"><b style="font-size:15px">Extensão para Teams / Google Meet no navegador</b><div class="grow"></div>
        <span class="chip ${st.error ? 'err' : st.connected ? 'ok' : ''}"><span class="d"></span>${st.error ? 'Erro' : st.connected ? `Conectada${st.lastSeen ? ' · ' + relTime(st.lastSeen) : ''}` : 'Não conectada'}</span></div>
      <p class="muted" style="margin:0 0 14px;line-height:1.55">Lê no Teams/Meet <b>quem está falando</b>, as <b>legendas com nome</b> e a <b>lista de participantes</b>. O MeetRec usa isso para colocar o nome certo em cada fala da transcrição, detectar o início/fim da chamada e sugerir gravar.</p>
      ${st.error ? `<div class="banner err">${ic('alertCircle', 16)}<span>${esc(st.error)}</span></div>` : ''}
      ${st.connected ? `<div class="banner ok">${ic('checkCircle', 16)}<span>Conectada${st.browser ? ` ao ${esc(st.browser)}` : ''}. ${st.inCall ? `Chamada ativa no <b>${esc(st.platform)}</b>${st.participants?.length ? ` com ${st.participants.length} participantes` : ''}. ${st.captionsActive ? 'Legendas ativas ✓' : 'Ative as legendas (Mais → Idioma e fala → Legendas ao vivo) para nomes mais precisos.'}` : 'Nenhuma chamada ativa no momento.'}</span></div>` : ''}
      <div class="row" style="gap:18px;align-items:flex-start;margin-top:6px">
        <div class="grow">
          <div style="font-weight:600;margin-bottom:8px">Como instalar (Chrome, Edge, Brave):</div>
          <ol class="steps-list">
            <li>Abra <span class="inline-code">chrome://extensions</span> (ou <span class="inline-code">edge://extensions</span>)</li>
            <li>Ative o <b>Modo do desenvolvedor</b></li>
            <li>Clique em <b>Carregar sem compactação</b> e escolha a pasta da extensão</li>
            <li>Clique no ícone do MeetRec na barra do navegador e cole o código ao lado</li>
          </ol>
          <div class="row" style="margin-top:10px"><button class="btn" id="openExt">${ic('folder', 14)} Abrir pasta da extensão</button><button class="btn ghost" id="copyExt">${ic('copy', 14)} Copiar caminho</button></div>
        </div>
        <div style="text-align:center">
          <div class="muted" style="font-size:12px;margin-bottom:6px">Código de pareamento</div>
          <div class="code-box" id="token">${esc(s.bridgeToken)}</div>
          <div class="row" style="justify-content:center;margin-top:8px"><button class="btn sm" id="copyTok">${ic('copy', 12)} Copiar</button><button class="btn sm ghost" id="newTok">${ic('refresh', 12)} Novo</button></div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      ${field('Detectar reuniões automaticamente', state.info.platform === 'darwin' ? 'No macOS, a detecção usa a extensão do navegador.' : 'Quando o Teams, Zoom, Meet (navegador) etc. começar a usar o microfone, o MeetRec pergunta se você quer gravar.', sw('detectMeetings', s.detectMeetings))}
      ${field('Sugerir parar quando a reunião acabar', 'Mostra um aviso quando o app de reunião solta o microfone ou a chamada termina.', sw('autoStopSuggest', s.autoStopSuggest))}
      ${field('Porta local da extensão', 'A extensão fala com o MeetRec só em 127.0.0.1. Mude se a porta estiver em uso.', `<input class="input" style="width:120px" data-k="bridgePort" data-num="1" value="${esc(s.bridgePort)}">`)}
    </div>`;
  $('#openExt').onclick = () => api.open(extDir);
  $('#copyExt').onclick = async () => { await api.copy(extDir); toast('success', 'Caminho copiado.'); };
  $('#copyTok').onclick = async () => { await api.copy(s.bridgeToken); toast('success', 'Código copiado. Cole na extensão.'); };
  $('#newTok').onclick = async () => {
    if (!(await confirmDialog('Gerar novo código?', 'A extensão precisará ser pareada novamente com o novo código.', 'Gerar'))) return;
    const t = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    await save({ bridgeToken: t }, 'Novo código gerado.');
    draw();
  };
}

function toAccelerator(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  let key = k.length === 1 ? k.toUpperCase() : k;
  if (/^F\d+$/.test(k)) key = k;
  if (k === ' ') key = 'Space';
  if (!parts.length) return null;
  parts.push(key);
  return parts.join('+');
}

function shortcuts(b) {
  const s = state.settings;
  const sc = (k, label, desc) => field(label, desc, `<button class="btn" data-sc="${k}" style="min-width:170px">${esc(prettyShortcut(s[k]) || '—')}</button>`);
  b.innerHTML = `<div class="card">
    ${sc('shortcutToggle', 'Iniciar / parar gravação', 'Funciona em qualquer app, mesmo com o MeetRec minimizado.')}
    ${sc('shortcutMarker', 'Marcar momento importante', 'Adiciona uma marcação no tempo atual — o Claude dá destaque a ela no resumo.')}
  </div><p class="muted" style="font-size:12.5px;margin-top:10px">Clique no atalho e pressione a nova combinação (precisa de Ctrl/⌘ ou Alt). Esc cancela.</p>`;
  $$('[data-sc]', b).forEach((btn) => (btn.onclick = () => {
    btn.textContent = 'Pressione as teclas…';
    btn.classList.add('primary');
    const onKey = async (e) => {
      e.preventDefault();
      if (e.key === 'Escape') { cleanup(); draw(); return; }
      const acc = toAccelerator(e);
      if (!acc) return;
      cleanup();
      await save({ [btn.dataset.sc]: acc }, `Atalho definido: ${prettyShortcut(acc)}`);
      draw();
    };
    const cleanup = () => document.removeEventListener('keydown', onKey, true);
    document.addEventListener('keydown', onKey, true);
  }));
}

let bridgeSig = '';
export function onEvent(type, p) {
  if (!root) return;
  if (type === 'update' && sec === 'general') {
    const card = $('#updCard');
    if (card) { card.innerHTML = updateField(); bindUpdate(); }
  }
  if (type === 'bridge' && sec === 'integrations') {
    const s = [p.connected, p.inCall, p.platform, p.captionsActive, p.error, p.participants?.length].join('|');
    if (s !== bridgeSig && document.activeElement?.tagName !== 'INPUT') { bridgeSig = s; draw(); }
  }
  if (type === 'health' && (sec === 'summary')) draw();
}
