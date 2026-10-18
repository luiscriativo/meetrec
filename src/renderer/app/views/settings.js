// Configurações.
import { state, ctx, api } from '../ctx.js';
import { $, $$, ic, esc, toast, prettyShortcut, relTime, confirmDialog, modal } from '../util.js';
import { mountModelCard, mountAiCard } from '../setup-ui.js';

let root = null, sec = 'general', testStream = null, testRaf = null;

const SECTIONS = [
  ['general', 'settings', 'Geral'],
  ['audio', 'mic', 'Áudio e gravação'],
  ['transcription', 'fileText', 'Transcrição'],
  ['summary', 'sparkles', 'Resumo (IA)'],
  ['integrations', 'plug', 'Integrações'],
  ['shortcuts', 'keyboard', 'Atalhos'],
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
    ${field('Transcrever e resumir automaticamente', 'Ligado: ao parar, já transcreve e resume em segundo plano (com prioridade baixa, e esperando se outra gravação começar). Desligado: só grava — depois use "Processar pendentes" na lista para fazer tudo de uma vez.', sw('autoProcess', s.autoProcess))}
    ${field('Iniciar com o sistema', 'Abre o MeetRec minimizado na bandeja quando você liga o computador.', sw('launchAtLogin', s.launchAtLogin))}
    ${field('Iniciar minimizado', 'Ao abrir, fica só na bandeja (ícone perto do relógio).', sw('startHidden', s.startHidden))}
    ${field('Tema', '', `<select class="select" data-k="theme" style="width:200px"><option value="system" ${s.theme === 'system' ? 'selected' : ''}>Automático (sistema)</option><option value="light" ${s.theme === 'light' ? 'selected' : ''}>Claro</option><option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Escuro</option></select>`)}
    ${field('Notificações do sistema', 'Avisos de início/fim de gravação, resumo pronto e erros.', sw('notifications', s.notifications))}
    ${field('Sons', 'Sinal sonoro discreto ao iniciar, parar e marcar momentos.', sw('sounds', s.sounds))}
  </div>
  <div class="card" id="syncCard" style="margin-top:14px"><div class="field"><div class="muted">${ic('loader', 14, 'spin')} Verificando a sincronização…</div></div></div>`;
  bindUpdate();
  drawSync();
}

// ───────── Sincronização entre computadores (pasta no Google Drive) ─────────
const DRIVE_URL = 'https://www.google.com/drive/download/';

async function drawSync() {
  if (!$('#syncCard')) return;
  const i = await api.sync.info();
  const card = $('#syncCard');
  if (!card) return;
  const s = state.settings;
  const inDrive = i.cloud === 'Google Drive';
  const status = inDrive
    ? `<div class="banner ok" style="margin:0">${ic('check', 16)}<div class="grow"><b>Sincronizando pelo Google Drive.</b> Reuniões, resumos, pastas e glossário aparecem nos dois computadores. ${i.watching ? 'Mudanças do outro PC chegam em segundos.' : 'Mudanças do outro PC chegam em até 20 segundos.'}${i.conflictsMerged ? ` · ${i.conflictsMerged} edição(ões) simultânea(s) juntada(s)` : ''}</div></div>`
    : i.cloud
      ? `<div class="banner info" style="margin:0">${ic('info', 16)}<div class="grow">A pasta está no <b>${esc(i.cloud)}</b>. Funciona igual, desde que o outro computador use a mesma pasta.</div></div>`
      : i.drive
        ? `<div class="banner info" style="margin:0;align-items:center">${ic('info', 16)}<div class="grow"><b>Ainda não sincroniza.</b> As reuniões ficam só neste computador. O Google Drive está instalado aqui: é só um clique.</div><button class="btn primary sm" id="useDrive">${ic('refresh', 14)} Usar o Google Drive</button></div>`
        : i.driveInstalled
          ? `<div class="banner warn" style="margin:0;align-items:center">${ic('alert', 16)}<div class="grow"><b>O Google Drive está instalado, mas fechado.</b> Abra o Google Drive, entre na sua conta e espere aparecer o "Meu Drive" (normalmente a unidade G:).</div><button class="btn sm" id="recheck">${ic('refresh', 14)} Verificar de novo</button></div>`
          : `<div class="banner warn" style="margin:0;align-items:center">${ic('alert', 16)}<div class="grow"><b>Ainda não sincroniza.</b> Instale o <b>Google Drive para computador</b> nos dois PCs, entre na mesma conta e volte aqui.</div><button class="btn sm" id="getDrive">${ic('external', 14)} Baixar o Google Drive</button></div>`;
  card.innerHTML = `
    <div class="field" style="display:block"><div class="lbl" style="margin-bottom:8px">Sincronizar entre computadores</div>${status}</div>
    ${field('Pasta das gravações', esc(i.root), `<button class="btn" id="pickDir">${ic('folder', 14)} Alterar…</button><button class="btn ghost icon" id="openDir" title="Abrir">${ic('external', 15)}</button>`)}
    ${field('Nome deste computador', 'Aparece no outro PC: "Gravando no …", "Também aberta no …".', `<input class="input" data-k="machineName" value="${esc(s.machineName || '')}" placeholder="${esc(i.hostname)}" style="width:200px">`)}
    ${inDrive || i.drive ? `<div class="field" style="display:block"><div class="desc">${ic('info', 13)} Funciona com o Google Drive em <b>streaming</b> (o padrão), sem baixar o resto do seu Drive. Gravação e processamento acontecem numa pasta local, e só o resultado vai para o Drive. O áudio de uma reunião feita no outro PC é baixado na primeira vez que você ouve ou processa. <b>Opcional:</b> para ouvir sem espera e ter tudo mesmo sem internet, clique com o botão direito em <b>MeetRec - Reuniões</b> dentro do Google Drive → <b>Acesso off-line → Disponível off-line</b>. Só essa pasta fica no disco.</div></div>` : ''}`;
  bindGeneric(card);
  $('#openDir').onclick = () => api.lib.openFolder();
  $('#pickDir').onclick = async () => {
    const d = await api.pickFolder();
    if (d) await switchLibrary(d, i, {});
  };
  if ($('#useDrive')) $('#useDrive').onclick = () => switchLibrary(i.driveTarget, i, { there: i.driveCount, isDrive: true });
  if ($('#getDrive')) $('#getDrive').onclick = () => api.open(DRIVE_URL);
  if ($('#recheck')) $('#recheck').onclick = drawSync;
}

// Pergunta o que fazer com as reuniões daqui e troca a pasta (juntando com a do outro PC, se houver)
async function switchLibrary(target, i, { there = 0, isDrive = false }) {
  if (state.rec.active) return toast('warn', 'Pare a gravação antes de trocar a pasta das gravações.');
  const here = i.localCount;
  const where = isDrive ? 'no Google Drive' : 'na nova pasta';
  const text = there
    ? `Já existem ${there} reuniões ${where} (provavelmente do outro computador). As ${here} reuniões deste PC podem ser juntadas a elas: nada é apagado nem sobrescrito, e o glossário das pastas com o mesmo nome é somado.`
    : here ? `Levar as ${here} reuniões deste computador para ${isDrive ? 'o Google Drive' : 'a nova pasta'}? Elas saem da pasta atual e passam a ficar lá.` : 'Passar a salvar as reuniões nessa pasta?';
  const mode = await new Promise((resolve) => {
    modal({
      title: isDrive ? 'Sincronizar pelo Google Drive' : 'Trocar a pasta das gravações',
      body: `<p class="muted" style="line-height:1.5;margin:4px 0 0">${esc(text)}</p><p class="muted" style="font-size:12.5px;margin:10px 0 0;display:flex;gap:6px;align-items:center">${ic('folder', 12)} ${esc(target)}</p>`,
      onClose: () => resolve(null),
      actions: [
        { label: 'Cancelar', onClick: () => resolve(null) },
        ...(here ? [{ label: there ? 'Só usar a de lá' : 'Só trocar a pasta', onClick: () => resolve('switch') }] : []),
        { label: `${ic('check', 14)} ${here ? (there ? 'Juntar e usar' : 'Levar as reuniões') : 'Usar essa pasta'}`, kind: 'primary', onClick: () => resolve(here ? 'move' : 'switch') },
      ],
    });
  });
  if (!mode) return;
  if (mode === 'switch' && here && !(await confirmDialog('Deixar as reuniões daqui para trás?', `As ${here} reuniões deste computador continuam em "${i.root}", mas não aparecem mais no app (dá para voltar trocando a pasta de novo).`, 'Só trocar'))) return;
  const card = $('#syncCard');
  if (card) card.innerHTML = `<div class="field" style="display:block"><b>${ic('loader', 15, 'spin')} ${mode === 'move' ? 'Levando as reuniões…' : 'Trocando a pasta…'}</b><div class="progress" style="margin-top:10px"><i id="syncBar" style="width:0%"></i></div><div class="desc" id="syncTxt" style="margin-top:6px">Não feche o app.</div></div>`;
  const r = await api.sync.migrate(target, mode);
  state.settings = await api.getSettings();
  await ctx.reloadList();
  ctx.refreshSidebar();
  if (!r.ok) toast('error', r.error, { duration: 12000 });
  else {
    const parts = [];
    if (r.moved) parts.push(`${r.moved} ${r.moved === 1 ? 'reunião levada' : 'reuniões levadas'}`);
    if (r.skipped?.length) parts.push(`${r.skipped.length} já ${r.skipped.length === 1 ? 'estava' : 'estavam'} lá (a cópia daqui ficou na pasta antiga)`);
    const extra = parts.length ? ` ${parts.join(' · ')}.` : '';
    toast('success', isDrive ? `Pronto! Agora as reuniões sincronizam pelo Google Drive.${extra} Faça o mesmo no outro computador.` : `Pasta alterada.${extra}`, { duration: 10000 });
  }
  if (root && sec === 'general') draw();
}

function syncProgress(p) {
  const b = $('#syncBar'), t = $('#syncTxt');
  if (b && p.total) b.style.width = `${Math.round((p.done / p.total) * 100)}%`;
  if (t && p.total) t.textContent = `${p.done} de ${p.total} reuniões · não feche o app.`;
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
      <div class="engine-cards" style="grid-template-columns:repeat(2, 1fr)">
        ${eng('local', `${ic('shield', 14)} Local (Whisper)`, 'Roda no seu PC. Privado e gratuito.', ['privado', 'ok'])}
        ${eng('openai', `${ic('globe', 14)} OpenAI`, 'Whisper da OpenAI na nuvem. Pago por minuto de áudio.', null)}
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      ${s.engine === 'local' ? `
        <div class="card-pad setup-card" id="modelCard" style="border-bottom:1px solid var(--border)"></div>
        ${field('Python (avançado)', 'Deixe vazio: o MeetRec usa o Python que já tem o faster-whisper ou instala um só dele.', `<input class="input" data-k="pythonPath" data-health="1" value="${esc(s.pythonPath)}" placeholder="automático">`)}
      ` : ''}
      ${s.engine === 'openai' ? field('Chave de API da OpenAI', 'Crie em <a href="#" data-url="https://platform.openai.com/api-keys">platform.openai.com/api-keys</a>. Fica salva criptografada.', `<input class="input" type="password" data-k="openaiKey" data-health="1" value="${esc(s.openaiKey)}" placeholder="sk-…">`) : ''}
      ${field('Idioma das reuniões', '', `<select class="select" data-k="language"><option value="pt" ${s.language === 'pt' ? 'selected' : ''}>Português</option><option value="en" ${s.language === 'en' ? 'selected' : ''}>Inglês</option><option value="es" ${s.language === 'es' ? 'selected' : ''}>Espanhol</option><option value="" ${!s.language ? 'selected' : ''}>Detectar automaticamente</option></select>`)}
      ${field('Vocabulário', 'Nomes de pessoas, empresas, siglas e termos técnicos que aparecem nas reuniões (separados por vírgula). Ajuda o Whisper a acertar.', `<textarea class="textarea" data-k="vocabulary" rows="3" placeholder="Ex.: PlanMat, SAP HANA, Libra APS, Ana Souza">${esc(s.vocabulary)}</textarea>`, 'stack')}
    </div>`;
  $$('[data-eng]', b).forEach((c) => (c.onclick = async () => { await save({ engine: c.dataset.eng }, 'Motor de transcrição alterado.'); ctx.runHealth(); draw(); }));
  $$('[data-url]', b).forEach((a) => (a.onclick = (e) => { e.preventDefault(); api.open(a.dataset.url); }));
  if ($('#modelCard')) mountModelCard($('#modelCard'));
}

function summary(b) {
  const s = state.settings;
  const h = state.health || [];
  const sel = s.aiEngine === 'codex' ? 'codex' : 'claude';
  const skill = h.find((c) => c.id === 'skill');
  // Status de cada CLI no cartão de escolha (vem do Diagnóstico)
  const badge = (k) => {
    const c = (state.health || []).find((x) => x.id === k); // sempre o diagnóstico mais recente
    if (!c) return ['verificando…', ''];
    if (/não instalado|não encontrado/i.test(c.detail)) return ['não instalado', 'err'];
    if (/login não confirmado|não conectado/i.test(c.detail)) return ['sem login', 'warn'];
    return ['instalado', 'ok'];
  };
  const card = (k, t, d) => {
    const [bt, bc] = badge(k);
    return `<div class="engine ${sel === k ? 'active' : ''}" data-ai="${k}"><h4>${t}<span class="chip ${bc}" style="height:18px;font-size:10.5px">${bt}</span></h4><p>${d}</p></div>`;
  };
  const isCodex = sel === 'codex';
  b.innerHTML = `
    <div class="card card-pad">
      <div class="lbl" style="font-weight:600;margin-bottom:4px">Motor do resumo</div>
      <div class="muted" style="font-size:12.5px;margin-bottom:10px">Usa o CLI instalado no seu PC com o login da sua conta (sem chave de API). Vale para resumos, perguntas e a memória das pastas.</div>
      <div class="engine-cards ai-cards">
        ${card('claude', `${ic('sparkles', 14)} Claude Code`, 'Conta Claude Pro / Max. Mostra o resumo sendo escrito em tempo real.')}
        ${card('codex', `${ic('terminal', 14)} Codex CLI`, 'Conta ChatGPT Plus / Pro (OpenAI). O texto aparece quando o Codex termina.')}
      </div>
    </div>
    <div class="card card-pad setup-card" id="aiCard" style="margin-top:14px"></div>
    <div class="card" style="margin-top:14px">
      ${isCodex ? `
        ${field('Caminho do Codex CLI', 'Deixe vazio para detectar automaticamente.', `<input class="input" data-k="codexPath" data-health="1" value="${esc(s.codexPath)}" placeholder="auto (codex)">`)}
        ${field('Modelo', 'Deixe vazio para usar o padrão do Codex (recomendado). Ou informe o nome de um modelo disponível na sua conta.', `<input class="input" data-k="codexModel" value="${esc(s.codexModel)}" placeholder="Padrão do Codex">`)}
        ${field('Esforço de raciocínio', 'Mais esforço = resumos mais cuidadosos, porém mais lentos e gastam mais do seu limite de uso.', `<select class="select" data-k="codexEffort"><option value="" ${!s.codexEffort ? 'selected' : ''}>Padrão do Codex</option><option value="low" ${s.codexEffort === 'low' ? 'selected' : ''}>Baixo (mais rápido)</option><option value="medium" ${s.codexEffort === 'medium' ? 'selected' : ''}>Médio</option><option value="high" ${s.codexEffort === 'high' ? 'selected' : ''}>Alto (mais cuidadoso)</option></select>`)}`
      : `
        ${field('Caminho do Claude Code', 'Deixe vazio para detectar automaticamente.', `<input class="input" data-k="claudePath" data-health="1" value="${esc(s.claudePath)}" placeholder="auto (claude)">`)}
        ${field('Modelo', 'Modelo usado pelo Claude Code para resumir e responder.', `<select class="select" data-k="claudeModel"><option value="" ${!s.claudeModel ? 'selected' : ''}>Padrão do Claude Code</option><option value="sonnet" ${s.claudeModel === 'sonnet' ? 'selected' : ''}>Sonnet (rápido)</option><option value="opus" ${s.claudeModel === 'opus' ? 'selected' : ''}>Opus (máxima qualidade)</option><option value="haiku" ${s.claudeModel === 'haiku' ? 'selected' : ''}>Haiku (mais econômico)</option></select>`)}`}
      ${field('Usar a skill "resumo-reuniao"', skill ? esc(skill.detail) : `Usa o formato da sua skill (~/.claude/skills/resumo-reuniao) no resumo${isCodex ? ' — o texto dela é enviado ao Codex junto com a transcrição' : ''}.`, sw('useSkill', s.useSkill, 'data-health="1"'))}
      ${field('Instruções adicionais para o resumo', 'Ex.: "Destaque riscos e dependências", "Escreva em inglês", "Inclua uma seção de próximos passos".', `<textarea class="textarea" data-k="customInstructions" rows="3">${esc(s.customInstructions)}</textarea>`, 'stack')}
    </div>`;
  $$('[data-ai]', b).forEach((c) => (c.onclick = async () => {
    const k = c.dataset.ai;
    if (k === sel) return;
    await save({ aiEngine: k }, `Motor do resumo: ${k === 'codex' ? 'Codex CLI' : 'Claude Code'}.`);
    draw();
    // Checa de novo antes de avisar: o CLI pode ter sido instalado depois que o app abriu
    await ctx.runHealth();
    const [bt] = badge(k);
    const nm = k === 'codex' ? 'Codex' : 'Claude Code';
    if (bt === 'não instalado') toast('warn', `O ${nm} não está instalado. Use o botão "Instalar ${nm}" logo abaixo — leva 1 minuto.`, { duration: 9000 });
    else if (bt === 'sem login') toast('warn', `Falta entrar na sua conta: use o botão "Entrar" logo abaixo.`, { duration: 9000 });
    if (sec === 'summary' && root) draw();
  }));
  if ($('#aiCard')) mountAiCard($('#aiCard'), sel);
}

function integrations(b) {
  const s = state.settings;
  const st = state.bridge;
  const extDir = state.info.extensionDir;
  const isMac = state.info.platform === 'darwin';
  const appVer = state.info.extensionVersion || state.info.version;
  const outdated = st.connected && st.extVersion && st.extVersion !== appVer;
  b.innerHTML = `
    <div class="card card-pad">
      <div class="row" style="margin-bottom:10px"><b style="font-size:15px">Extensão para Teams / Google Meet no navegador</b><div class="grow"></div>
        <span class="chip ${st.error ? 'err' : st.connected ? 'ok' : ''}"><span class="d"></span>${st.error ? 'Erro' : st.connected ? `Conectada${st.lastSeen ? ' · ' + relTime(st.lastSeen) : ''}` : 'Não conectada'}</span></div>
      <p class="muted" style="margin:0 0 14px;line-height:1.55">Lê no Teams/Meet <b>quem está falando</b>, as <b>legendas com nome</b> e a <b>lista de participantes</b>. O MeetRec usa isso para colocar o nome certo em cada fala da transcrição, detectar o início/fim da chamada e sugerir gravar.</p>
      ${st.error ? `<div class="banner err">${ic('alertCircle', 16)}<span>${esc(st.error)}</span></div>` : ''}
      ${st.connected ? `<div class="banner ok">${ic('checkCircle', 16)}<span>Conectada${st.browser ? ` ao ${esc(st.browser)}` : ''}. ${st.inCall ? `Chamada ativa no <b>${esc(st.platform)}</b>${st.participants?.length ? ` com ${st.participants.length} participantes` : ''}. ${st.captionsActive ? 'Legendas ativas ✓' : 'Ative as legendas (Mais → Idioma e fala → Legendas ao vivo) para nomes mais precisos.'}` : 'Nenhuma chamada ativa no momento.'}</span></div>` : ''}
      ${outdated ? `<div class="banner warn">${ic('alert', 16)}<div class="grow">A extensão no ${esc(st.browser || 'navegador')} é de uma versão anterior${st.extVersion !== 'antiga' ? ` (v${esc(st.extVersion)})` : ''} à do app (v${esc(appVer)}). Para atualizar: abra <span class="inline-code">chrome://extensions</span> e clique em <b>↻</b> no cartão do MeetRec.</div><button class="btn sm" data-copyurl="chrome://extensions">${ic('copy', 13)} Copiar endereço</button></div>` : ''}
      ${state.info.extensionError ? `<div class="banner warn">${ic('alert', 16)}<span>Não consegui copiar a extensão para a pasta Documentos (${esc(state.info.extensionError)}). Usando a pasta interna do app.</span></div>` : ''}
      <div class="row" style="gap:18px;align-items:flex-start;margin-top:6px">
        <div class="grow">
          <div style="font-weight:600;margin-bottom:8px">Como instalar (Chrome, Edge, Brave):</div>
          <ol class="steps-list ext-steps">
            <li>Abra uma nova aba no navegador e cole este endereço na barra de endereço:
              <div class="row ext-url"><span class="inline-code">chrome://extensions</span><button class="btn sm" data-copyurl="chrome://extensions">${ic('copy', 13)} Copiar endereço</button></div>
              <div class="muted" style="font-size:12px;margin-top:4px">Funciona no Chrome e no Brave. No Edge, se não abrir, use <span class="inline-code">edge://extensions</span>.</div></li>
            <li>Ative o <b>Modo do desenvolvedor</b> (canto superior direito)</li>
            <li>Clique em <b>Carregar sem compactação</b> e escolha a pasta da extensão:
              <div class="ext-path"><span class="inline-code" title="${esc(extDir)}">${esc(extDir)}</span></div>
              <div class="row" style="margin-top:8px;gap:6px"><button class="btn sm" id="openExt">${ic('folder', 13)} Abrir pasta</button><button class="btn sm ghost" id="copyExt">${ic('copy', 13)} Copiar caminho</button></div>
              ${isMac ? `<div class="ext-tip">${ic('info', 13)} No Mac: na janela de escolher pasta, aperte <span class="kbd">⌘</span> <span class="kbd">⇧</span> <span class="kbd">G</span>, cole o caminho copiado e aperte Enter.</div>` : ''}</li>
            <li>Clique no ícone do MeetRec na barra do navegador e cole o código ao lado</li>
          </ol>
          <div class="muted" style="font-size:12px;margin-top:8px;line-height:1.5">A pasta fica em Documentos e é atualizada sozinha junto com o app — não precisa baixar nada. Não mova nem apague a pasta depois de instalar.</div>
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
  // Recopia antes (caso a pasta tenha sido apagada) e usa o caminho atualizado
  const ensureExt = async () => {
    const r = await api.ext.sync();
    state.info.extensionDir = r.dir;
    if (r.error) toast('warn', `Não consegui preparar a pasta da extensão: ${r.error}`);
    return r.dir;
  };
  $('#openExt').onclick = async () => api.open(await ensureExt());
  $('#copyExt').onclick = async () => { await api.copy(await ensureExt()); toast('success', isMac ? 'Caminho copiado. Na janela do Chrome, use ⌘⇧G e cole.' : 'Caminho copiado.'); };
  // O navegador não deixa um app abrir chrome://extensions direto (bloqueio de segurança): o jeito é colar o endereço
  $$('[data-copyurl]', b).forEach((btn) => (btn.onclick = async () => { await api.copy(btn.dataset.copyurl); toast('success', 'Endereço copiado. Abra uma nova aba no navegador e cole na barra de endereço.'); }));
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
  if (type === 'sync-progress') syncProgress(p);
}
