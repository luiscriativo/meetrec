// Verificações de ambiente exibidas na tela "Diagnóstico" e ações de correção.
const fs = require('fs');
const os = require('os');
const { ffmpegPath, run, clearCache } = require('./tools');
const { MODELS, modelId, fmtBytes } = require('./engine');
const { claudeInfo, SKILL_PATH } = require('./claude');
const { codexInfo } = require('./codex');
const { ENGINES, engineOf } = require('./ai');

// Linha do Diagnóstico para um CLI de IA. O motor escolhido aparece como erro se faltar algo;
// o outro aparece só como informação (é opcional).
function aiCheck(eng, info, selected) {
  const E = ENGINES[eng];
  const base = { id: eng, ai: true, selected, group: 'Resumo', label: `${E.cli}${selected ? ' — motor do resumo' : ''}` };
  const other = eng === 'codex' ? 'Claude' : 'Codex';
  const account = eng === 'codex' ? 'ChatGPT (Plus ou Pro)' : 'Claude (precisa de assinatura Pro ou Max)';
  if (!info.ok) {
    return { ...base, state: selected ? 'error' : 'info', detail: selected ? 'Não instalado. O MeetRec instala para você (≈ 1 min, sem precisar de terminal).' : `Não instalado (opcional, alternativa ao ${other}).`, action: { id: `install-${eng}`, label: `Instalar ${eng === 'codex' ? 'Codex' : 'Claude Code'}` } };
  }
  const loggedOut = eng === 'codex' ? !info.loggedIn : info.auth?.known && !info.auth.loggedIn;
  if (loggedOut) {
    return { ...base, state: selected ? 'error' : 'info', detail: `${info.version} · não conectado à sua conta ${account}.`, action: { id: `login-${eng}`, label: 'Entrar na conta' } };
  }
  const who = info.auth?.loggedIn ? ` · conectado${info.auth.email ? ` como ${info.auth.email}` : ''}${info.auth.plan ? ` (plano ${info.auth.plan[0].toUpperCase()}${info.auth.plan.slice(1)})` : ''}` : '';
  return { ...base, state: selected ? 'ok' : 'info', detail: `${info.version}${who}${selected ? '' : ' · disponível como alternativa'}`, action: { id: `test-${eng}`, label: 'Testar conexão' } };
}

function bytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  return Math.round(n / 1e6) + ' MB';
}

async function runChecks({ store, bridge, detector, engine }) {
  clearCache();
  const s = store.get();
  const checks = [];
  const add = (c) => checks.push(c);

  const ff = await run(ffmpegPath(), ['-version'], { timeout: 10000 });
  add(ff.code === 0
    ? { id: 'ffmpeg', group: 'Áudio', label: 'FFmpeg (processamento de áudio)', state: 'ok', detail: ff.out.split('\n')[0].slice(0, 60) }
    : { id: 'ffmpeg', group: 'Áudio', label: 'FFmpeg (processamento de áudio)', state: 'error', detail: 'Não encontrado. Reinstale o app ou instale o ffmpeg no sistema.' });

  const plat = process.platform;
  if (plat === 'win32') add({ id: 'sysaudio', group: 'Áudio', label: 'Captura do som do computador', state: 'ok', detail: 'Suportado no Windows (loopback do sistema).' });
  else if (plat === 'darwin') {
    const major = parseInt(os.release().split('.')[0], 10); // Darwin 22 = macOS 13
    add(major >= 22
      ? { id: 'sysaudio', group: 'Áudio', label: 'Captura do som do computador', state: 'warn', detail: 'macOS 13+: permita "Gravação de Tela e Áudio do Sistema" para o MeetRec em Ajustes do Sistema → Privacidade.' }
      : { id: 'sysaudio', group: 'Áudio', label: 'Captura do som do computador', state: 'error', detail: 'Requer macOS 13 ou superior. Alternativa: instale o BlackHole e selecione-o como fonte do sistema.' });
  } else add({ id: 'sysaudio', group: 'Áudio', label: 'Captura do som do computador', state: s.systemDeviceId ? 'ok' : 'warn', detail: s.systemDeviceId ? 'Usando o dispositivo "Monitor" escolhido.' : 'No Linux, escolha um dispositivo "Monitor of …" em Configurações → Áudio.' });

  // Transcrição
  if (s.engine === 'local') {
    engine.forget(); // "Verificar novamente" enxerga um Python instalado depois
    const py = await engine.find(s);
    const label = 'Motor local (Python + faster-whisper)';
    const where = { system: 'Python do sistema', app: 'Python do MeetRec', custom: 'Python escolhido nas Configurações' };
    add(py
      ? { id: 'whisper', group: 'Transcrição', label, state: 'ok', detail: `faster-whisper ${py.fw} · ${py.version} (${where[py.source]})` }
      : engine.busy()
        ? { id: 'whisper', group: 'Transcrição', label, state: 'warn', detail: 'Instalando…' }
        : { id: 'whisper', group: 'Transcrição', label, state: 'error', detail: 'Não instalado. O MeetRec instala sozinho (~300 MB, cerca de 1 min, sem mexer no Python do sistema).', action: { id: 'install-engine', label: 'Instalar motor' } });
    const m = MODELS[modelId(s.localModel)];
    const st = engine.modelStatus(s.localModel);
    if (py) add(st.ready
      ? { id: 'model', group: 'Transcrição', label: `Modelo ${m.label}`, state: 'ok', detail: 'Baixado e pronto.' }
      : st.downloading
        ? { id: 'model', group: 'Transcrição', label: `Modelo ${m.label}`, state: 'warn', detail: `Baixando… ${Math.floor((st.received / st.total) * 100)}%`, model: st.id }
        : { id: 'model', group: 'Transcrição', label: `Modelo ${m.label}`, state: 'warn', detail: `Ainda não baixado (~${fmtBytes(m.size)}). Baixe agora ou ele será baixado na primeira transcrição.`, action: { id: 'download-model', label: 'Baixar agora' }, model: st.id });
  } else {
    const name = 'OpenAI';
    const key = s.openaiKey;
    add(key
      ? { id: 'cloudkey', group: 'Transcrição', label: `Chave de API ${name}`, state: 'ok', detail: 'Configurada (armazenada criptografada).', action: { id: 'test-cloud', label: 'Testar chave' } }
      : { id: 'cloudkey', group: 'Transcrição', label: `Chave de API ${name}`, state: 'error', detail: 'Não configurada. Vá em Configurações → Transcrição.' });
  }

  // Motor do resumo: Claude Code e/ou Codex CLI
  const sel = engineOf(s);
  const [ci, xi] = await Promise.all([claudeInfo(s), codexInfo(s)]);
  const infos = { claude: ci, codex: xi };
  add(aiCheck(sel, infos[sel], true));
  const other = sel === 'claude' ? 'codex' : 'claude';
  add(aiCheck(other, infos[other], false));
  if (infos[sel].ok) add(fs.existsSync(SKILL_PATH)
    ? { id: 'skill', group: 'Resumo', label: 'Skill "resumo-reuniao"', state: s.useSkill ? 'ok' : 'info', detail: s.useSkill ? 'Encontrada — o resumo segue o formato dela.' : 'Encontrada, mas desativada nas Configurações.' }
    : { id: 'skill', group: 'Resumo', label: 'Skill "resumo-reuniao"', state: 'info', detail: 'Não encontrada — usando o formato estilo Notion embutido.' });

  // Integrações
  const b = bridge.status();
  add(b.error
    ? { id: 'bridge', group: 'Integrações', label: 'Extensão do navegador (Teams/Meet)', state: 'error', detail: b.error }
    : b.connected
      ? { id: 'bridge', group: 'Integrações', label: 'Extensão do navegador (Teams/Meet)', state: 'ok', detail: `Conectada${b.browser ? ` (${b.browser})` : ''}${b.platform ? ` · ${b.platform}` : ''}` }
      : { id: 'bridge', group: 'Integrações', label: 'Extensão do navegador (Teams/Meet)', state: 'warn', detail: `Não conectada. Opcional: identifica quem fala no Teams/Meet. Código: ${s.bridgeToken}`, action: { id: 'open-extension', label: 'Instalar extensão' } });
  add(detector.supported
    ? { id: 'detector', group: 'Integrações', label: 'Detecção automática de reuniões', state: s.detectMeetings ? 'ok' : 'info', detail: s.detectMeetings ? (detector.apps.length ? `Microfone em uso por: ${detector.apps.join(', ')}` : 'Ativa — aviso quando um app de reunião usar o microfone.') : 'Desativada.' }
    : { id: 'detector', group: 'Integrações', label: 'Detecção automática de reuniões', state: 'info', detail: 'Neste sistema, a detecção depende da extensão do navegador.' });

  // Armazenamento
  try {
    fs.mkdirSync(s.storageDir, { recursive: true });
    fs.accessSync(s.storageDir, fs.constants.W_OK);
    let free = null;
    try { const st = fs.statfsSync(s.storageDir); free = st.bavail * st.bsize; } catch {}
    add({ id: 'storage', group: 'Armazenamento', label: 'Pasta das gravações', state: free != null && free < 2e9 ? 'warn' : 'ok', detail: `${s.storageDir}${free != null ? ` · ${bytes(free)} livres` : ''}`, action: { id: 'open-storage', label: 'Abrir pasta' } });
  } catch (e) {
    add({ id: 'storage', group: 'Armazenamento', label: 'Pasta das gravações', state: 'error', detail: `Sem permissão de escrita: ${e.message}` });
  }
  return checks;
}

module.exports = { runChecks };
