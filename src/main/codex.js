// Integração com o OpenAI Codex CLI (`codex exec --json`), usando o login da sua conta ChatGPT.
// Mesma interface do claude.js: runCodex({ prompt, settings, cwd, onText, onStatus, onChild }) → { text, model, durationMs }.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { findCodex, needsShell, run, isWin } = require('./tools');
const { UserError } = require('./transcribe');

const INSTALL_HINT = 'Instale com "npm i -g @openai/codex" e entre com sua conta ChatGPT rodando "codex login" num terminal.';

// Só caracteres seguros em valores que viram argumentos (no Windows o .cmd passa pelo cmd.exe)
const safe = (v) => String(v || '').trim().replace(/[^\w.\-:/]/g, '');

function friendlyError(text) {
  const t = (text || '').toLowerCase();
  if (/not logged in|codex login|please log ?in|unauthorized|\b401\b|authentication|token.*expired|refresh token/.test(t))
    return 'O Codex CLI não está autenticado. Abra um terminal, rode "codex login" e entre com sua conta ChatGPT.';
  if (/usage limit|rate limit|\b429\b|quota|limit reached/.test(t))
    return 'Limite de uso do Codex/ChatGPT atingido. Tente novamente mais tarde (ou troque para o Claude em Configurações → Resumo).';
  if (/enotfound|network|econnrefused|connection (error|refused)|stream disconnected/.test(t))
    return 'Sem conexão com a internet para falar com o Codex.';
  if (/model.*(not found|not supported|does not exist|unsupported)/.test(t))
    return 'O modelo escolhido não está disponível na sua conta do Codex. Deixe o modelo em "Padrão do Codex" em Configurações → Resumo.';
  return null;
}

/**
 * Traduz uma linha JSON do `codex exec --json` em ações para o app.
 * Aceita o formato atual (thread/turn/item) e o antigo ({ msg: { type } }).
 * Retorna { status?, text?, final?, delta?, error?, usage?, model? } ou null.
 */
function parseCodexEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  // Formato antigo
  if (ev.msg && typeof ev.msg === 'object') {
    const m = ev.msg;
    switch (m.type) {
      case 'session_configured': return { status: 'Codex conectado. Enviando a transcrição…', model: m.model };
      case 'task_started': return { status: 'Aguardando resposta do Codex…' };
      case 'agent_reasoning': case 'agent_reasoning_delta': case 'agent_reasoning_section_break': return { status: 'Codex está analisando a reunião…' };
      case 'agent_message_delta': return { delta: m.delta || '' };
      case 'agent_message': return { final: m.message || '' };
      case 'task_complete': return m.last_agent_message ? { final: m.last_agent_message } : null;
      case 'token_count': return { usage: m.info?.total_token_usage || m };
      case 'error': case 'stream_error': return { error: m.message || 'erro desconhecido' };
      default: return null;
    }
  }
  const item = ev.item || {};
  const itemType = item.type || item.item_type;
  switch (ev.type) {
    case 'thread.started': return { status: 'Codex conectado. Enviando a transcrição…' };
    case 'turn.started': return { status: 'Aguardando resposta do Codex…' };
    case 'turn.completed': return { usage: ev.usage || null };
    case 'turn.failed': return { error: ev.error?.message || 'O Codex não conseguiu concluir a resposta.' };
    case 'error': return { error: ev.message || ev.error?.message || 'erro desconhecido' };
    case 'item.started': case 'item.updated': case 'item.completed': {
      if (itemType === 'reasoning') return { status: 'Codex está analisando a reunião…' };
      if (itemType === 'agent_message' || itemType === 'assistant_message') {
        return ev.type === 'item.completed' ? { final: item.text || '' } : { text: item.text || '' };
      }
      if (itemType === 'command_execution' || itemType === 'file_change' || itemType === 'mcp_tool_call') return { status: 'Codex está consultando arquivos…' };
      if (itemType === 'error') return { error: item.message || 'erro desconhecido' };
      return null;
    }
    default: return null;
  }
}

function quoteArg(a) {
  if (a === '') return '""';
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

// No Windows, matar o cmd.exe não encerra o Codex (processo filho): derruba a árvore inteira
function killTree(child) {
  if (!child?.pid) return;
  if (isWin) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  } else {
    try { child.kill(); } catch {}
  }
}

async function codexInfo(settings) {
  const bin = await findCodex(settings.codexPath);
  if (!bin) return { ok: false, message: 'Codex CLI não encontrado.' };
  const shell = needsShell(bin);
  const r = await run(shell ? `"${bin}"` : bin, ['--version'], { timeout: 15000, shell });
  if (r.code !== 0) return { ok: false, path: bin, message: `Falha ao executar: ${(r.err || r.out).slice(0, 200)}` };
  const version = (r.out || r.err).trim().split('\n')[0];
  // `codex login status` sai com código 0 quando há login (ChatGPT ou chave)
  const ls = await run(shell ? `"${bin}"` : bin, ['login', 'status'], { timeout: 15000, shell });
  const txt = `${ls.out}\n${ls.err}`.trim();
  const loggedIn = ls.code === 0 && !/not logged in/i.test(txt);
  return { ok: true, path: bin, version, loggedIn, loginDetail: txt.split('\n')[0] || '' };
}

async function runCodex({ prompt, settings, cwd, onText, onStatus, onChild, timeoutMs = 15 * 60 * 1000 }) {
  const bin = await findCodex(settings.codexPath);
  if (!bin) throw new UserError(`Codex CLI não encontrado. ${INSTALL_HINT} Ou informe o caminho em Configurações → Resumo.`, 'no-codex');

  // A resposta final também é gravada num arquivo: é a fonte mais confiável do texto completo
  const lastFile = path.join(os.tmpdir(), `meetrec-codex-${process.pid}-${Date.now()}.txt`);
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', lastFile];
  const model = safe(settings.codexModel);
  if (model) args.push('-m', model);
  const effort = safe(settings.codexEffort);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  args.push('-'); // o prompt vai pelo stdin (transcrições longas não cabem na linha de comando)

  onStatus?.('Iniciando o Codex CLI…');
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const shell = needsShell(bin);
    const child = spawn(shell ? `"${bin}"` : bin, shell ? args.map(quoteArg) : args, {
      cwd: cwd || os.homedir(), windowsHide: true, shell, env: { ...process.env },
    });
    // O pipeline cancela chamando child.kill(): garante que a árvore toda seja encerrada
    const origKill = child.kill.bind(child);
    let killed = false;
    child.kill = (sig) => { killed = true; killTree(child); try { return origKill(sig); } catch { return false; } };
    onChild?.(child);

    let text = '', final = '', stderr = '', buf = '', errorMsg = '', usedModel = model || null, writing = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const lastStatus = { v: '' };
    const status = (m) => { if (m && m !== lastStatus.v) { lastStatus.v = m; onStatus?.(m); } };

    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const a = parseCodexEvent(ev);
        if (!a) continue;
        if (a.model) usedModel = a.model;
        if (a.status) status(a.status);
        if (a.error) errorMsg = a.error;
        if (a.delta) { text += a.delta; if (!writing) { writing = true; status('Codex está escrevendo…'); } onText?.(a.delta, text); }
        if (a.text != null && a.text !== '') { text = a.text; if (!writing) { writing = true; status('Codex está escrevendo…'); } onText?.('', text); }
        if (a.final != null && a.final !== '') { final = a.final; if (!writing) { writing = true; status('Codex está escrevendo…'); } onText?.('', final); }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {}); // o processo pode fechar antes de ler tudo (ex.: erro de login)
    child.stdin.write(prompt);
    child.stdin.end();

    const readLast = () => {
      try { const t = fs.readFileSync(lastFile, 'utf8').trim(); fs.unlinkSync(lastFile); return t; } catch { return ''; }
    };
    child.on('error', (e) => {
      clearTimeout(timer);
      readLast();
      reject(new UserError(`Não foi possível executar o Codex CLI: ${e.message}`, 'spawn'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = (readLast() || final || text).trim();
      if (code === 0 && out && !errorMsg) {
        return resolve({ text: out, costUsd: null, durationMs: Date.now() - started, model: usedModel, engine: 'codex' });
      }
      if (timedOut) return reject(new UserError(`O Codex não respondeu em ${Math.round(timeoutMs / 60000)} min (tempo esgotado). Tente novamente.`, 'timeout'));
      if (killed || code === null) return reject(new UserError('Geração cancelada.', 'cancelled'));
      if (code === 0 && out) return resolve({ text: out, costUsd: null, durationMs: Date.now() - started, model: usedModel, engine: 'codex' });
      const raw = errorMsg || stderr || `código de saída ${code}`;
      reject(new UserError(friendlyError(raw) || `O Codex CLI falhou: ${String(raw).trim().slice(0, 400)}`, 'codex-failed'));
    });
  });
}

module.exports = { runCodex, codexInfo, parseCodexEvent, friendlyError, INSTALL_HINT };
