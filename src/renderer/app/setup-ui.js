// Primeiro uso sem terminal: cartões "modelo do Whisper" e "Claude Code" com progresso ao vivo,
// e o assistente de boas-vindas que os reúne. Os cartões também aparecem nas Configurações.
import { state, ctx, api } from './ctx.js';
import { $, $$, ic, esc, toast, prettyShortcut } from './util.js';

const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round((n || 0) / 1e6)} MB`);
const fmtEta = (s) => (s == null ? '' : s < 60 ? 'menos de 1 min' : s < 3600 ? `~${Math.round(s / 60)} min` : `~${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
const fmtClock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let catalog = null;
async function getCatalog() { if (!catalog) catalog = await api.setup.catalog(); return catalog; }

// Liga um cartão aos eventos do processo principal enquanto ele estiver na tela
function live(el, handler) {
  const off = api.on((type, p) => { if (!el.isConnected) { off(); return; } handler(type, p); });
  return off;
}

// ───────────────────────── Cartão: modelo de transcrição local ─────────────────────────
/**
 * Escolha do modelo + download com progresso. autoStart: começa a baixar sozinho ao aparecer.
 */
export async function mountModelCard(el, { autoStart = false, onChange } = {}) {
  const cat = await getCatalog();
  let st = await api.setup.modelStatus();
  let error = null;
  const sel = () => state.settings.localModel || cat.defaultModel;

  const draw = () => {
    if (!el.isConnected) return;
    const m = cat.models.find((x) => x.id === st.id) || cat.models[0];
    const pct = st.total ? Math.min(100, Math.floor((st.received / st.total) * 100)) : 0;
    let status;
    if (st.ready) {
      status = `<div class="setup-status ok">${ic('checkCircle', 18)}<div class="grow"><b>Modelo ${esc(m.label)} pronto</b><div class="muted">Baixado neste computador (${fmtBytes(m.size)}). Funciona sem internet.</div></div></div>`;
    } else if (st.downloading) {
      status = `<div class="setup-status busy">${ic('download', 18)}<div class="grow">
          <div class="row" style="gap:8px"><b class="grow">Baixando o modelo ${esc(m.label)}… ${pct}%</b><button class="btn sm" data-x="cancel">${ic('pause', 13)} Pausar</button></div>
          <div class="progress" style="margin:8px 0 6px"><i style="width:${pct}%"></i></div>
          <div class="muted">${fmtBytes(st.received)} de ${fmtBytes(st.total)}${st.speed ? ` · ${fmtBytes(st.speed)}/s` : ''}${st.eta != null ? ` · falta ${fmtEta(st.eta)}` : ''} · pode continuar usando o app enquanto baixa</div>
        </div></div>`;
    } else if (error && error !== 'cancelled') {
      status = `<div class="setup-status err">${ic('alertCircle', 18)}<div class="grow"><b>O download parou</b><div class="muted">${esc(error)}</div></div><button class="btn sm primary" data-x="download">${ic('refresh', 13)} Tentar de novo</button></div>`;
    } else {
      // Só o detector de fala (≈ 1 MB) não conta como "pausado"
      const resumed = st.received > 2e6 || error === 'cancelled';
      status = `<div class="setup-status idle">${ic(resumed ? 'pause' : 'download', 18)}<div class="grow"><b>${resumed ? `Download pausado em ${pct}%` : 'Modelo ainda não baixado'}</b><div class="muted">${resumed ? `${fmtBytes(st.received)} de ${fmtBytes(st.total)} — continua de onde parou.` : `${fmtBytes(m.size)} · baixado uma única vez.`}</div></div><button class="btn sm primary" data-x="download">${ic('download', 13)} ${resumed ? 'Continuar' : 'Baixar agora'}</button></div>`;
    }
    el.innerHTML = `
      <label class="setup-lbl">Modelo de transcrição</label>
      <select class="select" data-x="model" ${st.downloading ? 'disabled' : ''}>
        ${cat.models.map((x) => `<option value="${x.id}" ${x.id === sel() ? 'selected' : ''}>${esc(x.label)}${x.recommended ? ' (recomendado)' : ''} — ${esc(x.desc)} ${fmtBytes(x.size)}${st.downloaded?.includes(x.id) ? ' · baixado' : ''}</option>`).join('')}
      </select>
      ${status}`;
    $('[data-x="model"]', el).onchange = async (e) => {
      state.settings = await api.setSettings({ localModel: e.target.value });
      error = null;
      st = await api.setup.modelStatus();
      draw(); onChange?.(st);
      ctx.runHealth();
      if (!st.ready && autoStart) start();
    };
    const dl = $('[data-x="download"]', el); if (dl) dl.onclick = start;
    const cc = $('[data-x="cancel"]', el); if (cc) cc.onclick = () => api.setup.modelCancel(st.id);
  };

  async function start() {
    error = null;
    const r = await api.setup.modelDownload(sel());
    if (!r.ok) { error = r.code === 'cancelled' ? 'cancelled' : r.error; st = await api.setup.modelStatus(); draw(); onChange?.(st); }
  }

  live(el, async (type, p) => {
    if (type !== 'model-progress' || p.id !== st.id) return;
    const wasReady = st.ready;
    st = { ...st, ...p };
    if (!p.downloading) { if (p.error) error = p.error; st = await api.setup.modelStatus(); }
    draw(); onChange?.(st);
    if (st.ready && !wasReady) { toast('success', `Modelo ${st.label} baixado e pronto.`); ctx.runHealth(); }
  });
  draw();
  if (autoStart && !st.ready && !st.downloading && !st.error) start();
  return { status: () => st };
}

// ───────────────────────── Cartão: Claude Code ─────────────────────────
export async function mountClaudeCard(el, { onChange } = {}) {
  let info = null;         // { installed, version, known, loggedIn, email, plan }
  let setup = await api.setup.claudeState(); // fase da instalação/login em andamento
  let showLog = false, codeOpen = false, testing = false;
  let tick = null;

  const refresh = async () => { info = await api.setup.claudeStatus(); draw(); onChange?.(info); };

  const draw = () => {
    if (!el.isConnected) { clearInterval(tick); return; }
    const phase = setup.phase;
    const elapsed = setup.startedAt ? fmtClock(Date.now() - setup.startedAt) : '';
    let body;
    if (phase === 'installing') {
      body = `<div class="setup-status busy">${ic('loader', 18, 'spin')}<div class="grow">
          <div class="row" style="gap:8px"><b class="grow">Instalando o Claude Code… <span class="muted" data-x="clock">${elapsed}</span></b><button class="btn sm" data-x="cancel">Cancelar</button></div>
          <div class="progress indet" style="margin:8px 0 6px"><i></i></div>
          <div class="muted">Baixando do site oficial da Anthropic. Costuma levar de 30 s a 2 min.</div>
        </div></div>`;
    } else if (phase === 'logging-in') {
      body = `<div class="setup-status busy">${ic('loader', 18, 'spin')}<div class="grow">
          <div class="row" style="gap:8px"><b class="grow">Aguardando você entrar na conta… <span class="muted" data-x="clock">${elapsed}</span></b><button class="btn sm" data-x="cancel">Cancelar</button></div>
          <div class="muted" style="margin-top:4px;line-height:1.5">Abrimos o navegador na página da Claude. Entre com sua conta e clique em <b>Autorizar</b>. Esta tela atualiza sozinha.</div>
          <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
            ${setup.url ? `<button class="btn sm" data-x="open-url">${ic('external', 13)} Abrir página de login</button>` : ''}
            <button class="btn sm ghost" data-x="code-toggle">${ic('hash', 13)} Recebi um código</button>
          </div>
          ${codeOpen ? `<div class="row" style="gap:8px;margin-top:10px"><input class="input" data-x="code" placeholder="Cole aqui o código mostrado no navegador"><button class="btn sm primary" data-x="send-code">Enviar</button></div>` : ''}
        </div></div>`;
    } else if (!info) {
      body = `<div class="setup-status idle">${ic('loader', 18, 'spin')}<div class="grow"><b>Verificando o Claude Code…</b></div></div>`;
    } else if (!info.installed) {
      body = `<div class="setup-status idle">${ic('download', 18)}<div class="grow"><b>Claude Code não instalado</b><div class="muted">O MeetRec instala para você — sem terminal, direto do site oficial.</div></div><button class="btn primary" data-x="install">${ic('download', 14)} Instalar Claude Code</button></div>`;
    } else if (info.known && !info.loggedIn) {
      body = `<div class="setup-status idle">${ic('user', 18)}<div class="grow"><b>Instalado · falta entrar na sua conta</b><div class="muted">${esc(info.version)} — o navegador abre para você autorizar.</div></div><button class="btn primary" data-x="login">${ic('user', 14)} Entrar com minha conta Claude</button></div>`;
    } else if (info.loggedIn) {
      body = `<div class="setup-status ok">${ic('checkCircle', 18)}<div class="grow"><b>Claude conectado${info.email ? ` como ${esc(info.email)}` : ''}</b><div class="muted">${esc(info.version)}${info.plan ? ` · plano ${esc(info.plan[0].toUpperCase() + info.plan.slice(1))}` : ''}</div></div><button class="btn sm" data-x="test" ${testing ? 'disabled' : ''}>${testing ? ic('loader', 13, 'spin') : ic('send', 13)} Testar</button></div>`;
    } else {
      // CLI antigo, sem "auth status": não dá para saber se está logado
      body = `<div class="setup-status idle">${ic('info', 18)}<div class="grow"><b>Claude Code instalado</b><div class="muted">${esc(info.version)} — versão antiga. Atualize para o app conferir o login sozinho.</div></div><button class="btn sm" data-x="install">${ic('refresh', 13)} Atualizar</button><button class="btn sm" data-x="test" ${testing ? 'disabled' : ''}>Testar</button></div>`;
    }
    const err = phase === 'error' && setup.error ? `<div class="banner err" style="margin-top:10px">${ic('alertCircle', 16)}<span>${esc(setup.error)}</span></div>` : '';
    const log = setup.log && (phase === 'installing' || phase === 'error' || showLog)
      ? `<button class="linkish" data-x="log-toggle">${showLog ? 'Ocultar detalhes' : 'Ver detalhes'}</button>${showLog ? `<div class="log" style="max-height:140px;margin-top:6px">${esc(setup.log)}</div>` : ''}` : '';
    el.innerHTML = `${body}${err}${log}`;

    const on = (x, fn) => { const b = $(`[data-x="${x}"]`, el); if (b) b.onclick = fn; };
    on('install', async () => {
      const r = await api.setup.claudeInstall();
      if (r.ok) { toast('success', `Claude Code ${r.status.version} instalado!`); await refresh(); if (info?.known && !info.loggedIn) login(); }
      else await refresh();
      ctx.runHealth();
    });
    on('login', login);
    on('cancel', () => api.setup.claudeCancel());
    on('open-url', () => api.open(setup.url));
    on('code-toggle', () => { codeOpen = !codeOpen; draw(); $('[data-x="code"]', el)?.focus(); });
    on('send-code', async () => {
      const v = $('[data-x="code"]', el).value.trim();
      if (!v) return;
      if (await api.setup.claudeCode(v)) toast('info', 'Código enviado. Conferindo…'); else toast('error', 'Não consegui enviar o código. Tente entrar de novo.');
    });
    on('log-toggle', () => { showLog = !showLog; draw(); });
    on('test', async () => {
      testing = true; draw();
      const r = await api.diag.action('test-claude');
      testing = false; draw();
      toast(r.ok ? 'success' : 'error', r.message, { duration: 6000 });
    });
    const lg = $('.log', el); if (lg) lg.scrollTop = lg.scrollHeight;
  };

  async function login() {
    codeOpen = false;
    const r = await api.setup.claudeLogin();
    if (r.ok) toast('success', r.auth?.email ? `Conectado como ${r.auth.email} ✅` : 'Conta Claude conectada ✅');
    await refresh();
    ctx.runHealth();
  }

  live(el, (type, p) => {
    if (type !== 'claude-setup') return;
    const phaseChanged = p.phase !== setup.phase;
    setup = p;
    // Só redesenha tudo quando muda de fase (para não apagar o código que a pessoa está digitando)
    if (phaseChanged || (p.url && !$('[data-x="open-url"]', el)) || (showLog && $('.log', el)) || (p.log && !$('[data-x="log-toggle"]', el) && p.phase === 'installing')) draw();
  });
  // Relógio da instalação/login
  tick = setInterval(() => {
    if (!el.isConnected) { clearInterval(tick); return; }
    const c = $('[data-x="clock"]', el);
    if (c && setup.startedAt) c.textContent = fmtClock(Date.now() - setup.startedAt);
  }, 1000);
  draw();
  await refresh();
  return { status: () => info, refresh };
}

// ───────────────────────── Assistente de boas-vindas ─────────────────────────
/**
 * mode 'full': primeira execução (nome → transcrição → Claude → pronto).
 * mode 'whisper': aviso único para quem atualizou da versão com Python.
 */
export function openWizard({ mode = 'full' } = {}) {
  if ($('.wizard-bg')) return;
  const steps = mode === 'whisper' ? ['whisper'] : ['welcome', 'transcription', 'claude', 'done'];
  let i = 0;
  let modelSt = null, claudeSt = null;
  const bg = document.createElement('div');
  bg.className = 'wizard-bg';
  document.body.appendChild(bg);
  // Na tela final, atualiza quando o download em segundo plano terminar
  live(bg, (type, p) => { if (type === 'model-progress' && !p.downloading && steps[i] === 'done') render(); });

  const finish = async () => {
    // O nome já é salvo pelos botões; aqui só marca o assistente como visto
    state.settings = await api.setSettings(mode === 'whisper' ? { whisperNotice: false } : { onboarded: true, whisperNotice: false });
    bg.remove();
    ctx.refreshSidebar?.();
    ctx.runHealth();
  };

  const dots = () => steps.length > 1 ? `<div class="wz-dots">${steps.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'done' : ''}"></i>`).join('')}</div>` : '';

  const render = async () => {
    const step = steps[i];
    // Resumo final sempre com a situação atual (o download pode ter terminado em segundo plano)
    if (step === 'done') {
      [modelSt, claudeSt] = await Promise.all([api.setup.modelStatus(), api.setup.claudeStatus()]);
      if (steps[i] !== 'done') return;
    }
    const s = state.settings;
    let head, body, foot;
    if (step === 'welcome') {
      head = `<span class="wz-logo">${ic('waves', 26)}</span><h2>Bem-vindo ao MeetRec 👋</h2><p>Grave reuniões do Teams, Meet, Zoom ou qualquer app: o MeetRec capta <b>sua voz</b> e o <b>som do computador</b>, transcreve e o <b>Claude</b> escreve o resumo para você.</p>`;
      body = `<label class="setup-lbl">Como você quer ser chamado nas transcrições?</label>
        <input class="input" id="wzName" placeholder="Seu nome (ex.: Luis)" value="${esc(s.userName || '')}">
        <div class="wz-plan">
          <div>${ic('download', 16)}<span><b>1. Transcrição</b> — baixamos o motor de transcrição para este computador.</span></div>
          <div>${ic('sparkles', 16)}<span><b>2. Resumos</b> — instalamos e conectamos o Claude à sua conta.</span></div>
          <div>${ic('checkCircle', 16)}<span><b>3. Pronto</b> — é só clicar em <b>Gravar reunião</b>.</span></div>
        </div>
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">Leva uns 3 minutos. Tudo acontece aqui dentro — sem terminal, sem instalar nada à mão.</p>`;
      foot = `<button class="btn ghost" data-w="skip">Configurar depois</button><div class="grow"></div><button class="btn primary" data-w="next">Começar ${ic('chevronRight', 15)}</button>`;
    } else if (step === 'transcription' || step === 'whisper') {
      const local = s.engine === 'local';
      head = step === 'whisper'
        ? `<span class="wz-logo">${ic('sparkles', 24)}</span><h2>Transcrição nova e mais simples</h2><p>O MeetRec não precisa mais do Python: o motor de transcrição agora vem dentro do app. Só falta baixar o modelo uma vez — e o padrão agora é o <b>Large v3 Turbo</b>, bem mais preciso.</p>`
        : `<span class="wz-logo">${ic('fileText', 24)}</span><h2>Transcrição</h2><p>Onde o áudio das reuniões vira texto.</p>`;
      body = `${step === 'transcription' ? `<div class="engine-cards wz-eng">
          <div class="engine ${local ? 'active' : ''}" data-eng="local"><h4>${ic('shield', 14)} No seu computador <span class="chip ok" style="height:18px;font-size:10.5px">recomendado</span></h4><p>Grátis e privado: o áudio não sai do seu PC.</p></div>
          <div class="engine ${s.engine === 'groq' ? 'active' : ''}" data-eng="groq"><h4>${ic('bolt', 14)} Na nuvem (Groq)</h4><p>Muito rápido, precisa de uma chave grátis do Groq.</p></div>
        </div>` : ''}
        <div id="wzEngine"></div>`;
      foot = step === 'whisper'
        ? `<button class="btn ghost" data-w="skip">Depois</button><div class="grow"></div><button class="btn primary" data-w="finish">Pronto</button>`
        : `<button class="btn ghost" data-w="back">${ic('chevronLeft', 15)} Voltar</button><div class="grow"></div><button class="btn primary" data-w="next">Continuar ${ic('chevronRight', 15)}</button>`;
    } else if (step === 'claude') {
      head = `<span class="wz-logo">${ic('sparkles', 24)}</span><h2>Resumos com o Claude</h2><p>O Claude lê a transcrição e escreve o resumo com tópicos, decisões e tarefas. Precisa de uma conta Claude com assinatura <b>Pro</b> ou <b>Max</b>.</p>`;
      body = `<div id="wzClaude"></div>
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">Prefere o ChatGPT? Dá para usar o Codex em <b>Configurações → Resumo</b>.</p>`;
      foot = `<button class="btn ghost" data-w="back">${ic('chevronLeft', 15)} Voltar</button><div class="grow"></div><button class="btn" data-w="next" id="wzClaudeNext">${claudeSt?.loggedIn ? 'Continuar' : 'Fazer depois'} ${ic('chevronRight', 15)}</button>`;
    } else {
      const local = s.engine === 'local';
      const t = local
        ? modelSt?.ready ? ['ok', 'Transcrição pronta', `Modelo ${modelSt.label} baixado.`]
          : modelSt?.downloading ? ['warn', 'Transcrição: baixando o modelo', `${Math.floor((modelSt.received / modelSt.total) * 100)}% — termina sozinho em segundo plano.`]
            : ['warn', 'Transcrição: modelo não baixado', 'Ele será baixado na primeira reunião (ou em Diagnóstico).']
        : s.groqKey || s.openaiKey ? ['ok', 'Transcrição na nuvem', 'Chave configurada.'] : ['warn', 'Transcrição na nuvem', 'Falta a chave de API (Configurações → Transcrição).'];
      const c = claudeSt?.loggedIn ? ['ok', 'Resumos prontos', `Claude conectado${claudeSt.email ? ` como ${claudeSt.email}` : ''}.`]
        : claudeSt?.installed ? ['warn', 'Resumos: falta entrar na conta', 'Faça depois em Diagnóstico → Entrar na conta.']
          : ['warn', 'Resumos: Claude não instalado', 'Faça depois em Diagnóstico → Instalar Claude Code.'];
      const row = ([st, l, d]) => `<div class="onb-step"><span class="n" style="background:${st === 'ok' ? 'var(--ok)' : 'var(--warn)'}">${ic(st === 'ok' ? 'check' : 'alert', 14)}</span><div class="grow"><b>${esc(l)}</b><div class="muted" style="font-size:12px">${esc(d)}</div></div></div>`;
      head = `<span class="wz-logo">${ic('checkCircle', 26)}</span><h2>${t[0] === 'ok' && c[0] === 'ok' ? 'Tudo pronto! 🎉' : 'Quase lá!'}</h2><p>Quando começar uma reunião, clique em <b>Gravar reunião</b> (ou use <b>${esc(prettyShortcut(s.shortcutToggle || 'CommandOrControl+Shift+R'))}</b>). O resumo aparece sozinho quando a gravação terminar.</p>`;
      body = `<div class="onb-steps">${row(t)}${row(c)}</div>`;
      foot = `<button class="btn ghost" data-w="back">${ic('chevronLeft', 15)} Voltar</button><div class="grow"></div><button class="btn primary" data-w="finish">Começar a usar</button>`;
    }
    const name = $('#wzName', bg)?.value;
    bg.innerHTML = `<div class="wizard" role="dialog" aria-modal="true">${dots()}<div class="wz-head">${head}</div><div class="wz-body">${body}</div><div class="wz-foot">${foot}</div></div>`;
    if (name != null && $('#wzName', bg)) $('#wzName', bg).value = name;

    // Conteúdo vivo de cada passo
    const eng = $('#wzEngine', bg);
    if (eng) {
      if (state.settings.engine === 'local' || step === 'whisper') {
        eng.innerHTML = '<div class="setup-card"></div>';
        await mountModelCard(eng.firstChild, { autoStart: true, onChange: (st) => { modelSt = st; } });
      } else {
        eng.innerHTML = `<div class="setup-card"><label class="setup-lbl">Chave de API do Groq</label>
          <input class="input" type="password" id="wzGroq" placeholder="gsk_…" value="${esc(state.settings.groqKey || '')}">
          <div class="muted" style="font-size:12.5px;margin-top:6px">Crie grátis em <a href="#" data-url="https://console.groq.com/keys">console.groq.com/keys</a> e cole aqui. Fica salva criptografada neste computador.</div></div>`;
        $('#wzGroq', bg).onchange = async (e) => { state.settings = await api.setSettings({ groqKey: e.target.value.trim() }); toast('success', 'Chave salva.', { duration: 1800 }); ctx.runHealth(); };
      }
    }
    const cl = $('#wzClaude', bg);
    if (cl) {
      cl.className = 'setup-card';
      await mountClaudeCard(cl, { onChange: (st) => { claudeSt = st; const b = $('#wzClaudeNext', bg); if (b) { b.innerHTML = `${st?.loggedIn ? 'Continuar' : 'Fazer depois'} ${ic('chevronRight', 15)}`; b.classList.toggle('primary', !!st?.loggedIn); } } });
    }

    $$('[data-eng]', bg).forEach((c) => (c.onclick = async () => { state.settings = await api.setSettings({ engine: c.dataset.eng }); ctx.runHealth(); render(); }));
    $$('[data-url]', bg).forEach((a) => (a.onclick = (e) => { e.preventDefault(); api.open(a.dataset.url); }));
    $$('[data-w]', bg).forEach((b) => (b.onclick = async () => {
      const w = b.dataset.w;
      const nm = $('#wzName', bg);
      if (nm) state.settings = await api.setSettings({ userName: nm.value.trim() });
      if (w === 'next') { i = Math.min(steps.length - 1, i + 1); render(); }
      else if (w === 'back') { i = Math.max(0, i - 1); render(); }
      else if (w === 'skip' || w === 'finish') finish();
    }));
    $('#wzName', bg)?.focus();
  };
  render();
}
