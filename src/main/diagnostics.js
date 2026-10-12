// Verificações de ambiente exibidas na tela "Diagnóstico" e ações de correção.
const fs = require('fs');
const os = require('os');
const { ffmpegPath, run, findPython, clearCache } = require('./tools');
const { claudeInfo } = require('./claude');

function bytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  return Math.round(n / 1e6) + ' MB';
}

async function runChecks({ store, bridge, detector }) {
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
    const py = await findPython(s.pythonPath);
    if (!py) {
      add({ id: 'python', group: 'Transcrição', label: 'Python 3', state: 'error', detail: 'Não encontrado. Instale o Python 3.9+ (python.org) ou use Groq/OpenAI.', action: { id: 'open-python', label: 'Baixar Python' } });
    } else {
      add({ id: 'python', group: 'Transcrição', label: 'Python 3', state: 'ok', detail: `${py.version} (${py.cmd})` });
      const fw = await run(py.cmd, [...py.args, '-c', 'import faster_whisper; print(faster_whisper.__version__)'], { timeout: 30000 });
      add(fw.code === 0
        ? { id: 'whisper', group: 'Transcrição', label: 'Motor local (faster-whisper)', state: 'ok', detail: `Versão ${fw.out.trim()} · modelo "${s.localModel}"`, action: { id: 'download-model', label: 'Baixar modelo agora' } }
        : { id: 'whisper', group: 'Transcrição', label: 'Motor local (faster-whisper)', state: 'error', detail: 'Não instalado. Clique para instalar (≈ 100 MB).', action: { id: 'install-whisper', label: 'Instalar motor local' } });
    }
  } else {
    const name = s.engine === 'groq' ? 'Groq' : 'OpenAI';
    const key = s.engine === 'groq' ? s.groqKey : s.openaiKey;
    add(key
      ? { id: 'cloudkey', group: 'Transcrição', label: `Chave de API ${name}`, state: 'ok', detail: 'Configurada (armazenada criptografada).', action: { id: 'test-cloud', label: 'Testar chave' } }
      : { id: 'cloudkey', group: 'Transcrição', label: `Chave de API ${name}`, state: 'error', detail: 'Não configurada. Vá em Configurações → Transcrição.' });
  }

  // Claude
  const ci = await claudeInfo(s);
  add(ci.ok
    ? { id: 'claude', group: 'Resumo', label: 'Claude Code CLI', state: 'ok', detail: `${ci.version} · ${ci.path}`, action: { id: 'test-claude', label: 'Testar conexão' } }
    : { id: 'claude', group: 'Resumo', label: 'Claude Code CLI', state: 'error', detail: ci.message + ' Instale: npm i -g @anthropic-ai/claude-code', action: { id: 'open-claude-docs', label: 'Como instalar' } });
  if (ci.ok) add(ci.skill
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

// Ações longas com log em tempo real
async function installWhisper(store, log) {
  const py = await findPython(store.get('pythonPath'));
  if (!py) throw new Error('Python não encontrado.');
  log(`> ${py.cmd} -m pip install --upgrade faster-whisper\n`);
  const r = await run(py.cmd, [...py.args, '-m', 'pip', 'install', '--upgrade', 'faster-whisper'], { onStdout: log, onStderr: log, timeout: 30 * 60e3 });
  if (r.code !== 0) throw new Error('A instalação falhou. Veja o log acima.');
}

async function downloadModel(store, log) {
  const py = await findPython(store.get('pythonPath'));
  if (!py) throw new Error('Python não encontrado.');
  const model = store.get('localModel');
  log(`Baixando o modelo "${model}"… (pode levar alguns minutos)\n`);
  const code = `from faster_whisper.utils import download_model\nimport os\np = download_model(${JSON.stringify(model)})\nprint('Modelo salvo em', p)`;
  const r = await run(py.cmd, [...py.args, '-c', code], { onStdout: log, onStderr: log, timeout: 60 * 60e3, env: { PYTHONIOENCODING: 'utf-8' } });
  if (r.code !== 0) throw new Error('Falha ao baixar o modelo.');
}

module.exports = { runChecks, installWhisper, downloadModel };
