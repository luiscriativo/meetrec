// Integração com o Claude Code CLI (claude -p) com streaming do texto gerado.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { findClaude, needsShell, run } = require('./tools');
const { authStatus } = require('./claude-setup');
const { UserError } = require('./transcribe');

const SKILL_PATH = path.join(os.homedir(), '.claude', 'skills', 'resumo-reuniao', 'SKILL.md');

function readSkill() {
  try {
    const raw = fs.readFileSync(SKILL_PATH, 'utf8');
    return raw.replace(/^---[\s\S]*?---\s*/, '').trim();
  } catch { return null; }
}

async function claudeInfo(settings) {
  const bin = await findClaude(settings.claudePath);
  if (!bin) return { ok: false, message: 'Claude Code CLI não encontrado.' };
  const r = await run(bin, ['--version'], { timeout: 15000, shell: needsShell(bin) });
  if (r.code !== 0) return { ok: false, path: bin, message: `Falha ao executar: ${(r.err || r.out).slice(0, 200)}` };
  const auth = await authStatus(bin);
  return { ok: true, path: bin, version: r.out.trim().split('\n')[0], skill: fs.existsSync(SKILL_PATH) ? SKILL_PATH : null, auth };
}

function friendlyError(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('/login') || t.includes('not logged in') || t.includes('invalid api key') || t.includes('authentication'))
    return 'O Claude Code não está conectado à sua conta. Vá em Diagnóstico → "Entrar na conta".';
  if (t.includes('rate limit') || t.includes('usage limit') || t.includes('limit reached'))
    return 'Limite de uso do Claude atingido. Tente novamente mais tarde.';
  if (t.includes('enotfound') || t.includes('network') || t.includes('econnrefused'))
    return 'Sem conexão com a internet para falar com o Claude.';
  return null;
}

/**
 * Executa o Claude Code em modo não interativo.
 * onText(delta, fullText) recebe o texto em tempo real; onStatus(msg) recebe mudanças de estado.
 */
async function runClaude({ prompt, settings, cwd, onText, onStatus, onChild, timeoutMs = 15 * 60 * 1000 }) {
  const bin = await findClaude(settings.claudePath);
  if (!bin) throw new UserError('O Claude Code não está instalado. Vá em Diagnóstico → "Instalar Claude Code" (um clique).', 'no-claude');

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '', '--no-session-persistence'];
  if (settings.claudeModel) args.push('--model', settings.claudeModel);

  onStatus?.('Iniciando o Claude Code…');
  return new Promise((resolve, reject) => {
    const shell = needsShell(bin);
    const child = spawn(shell ? `"${bin}"` : bin, shell ? args.map((a) => (a === '' ? '""' : a)) : args, {
      cwd: cwd || os.homedir(), windowsHide: true, shell, env: { ...process.env },
    });
    onChild?.(child);
    let text = '', stderr = '', buf = '', result = null, model = null, thinkingNotified = false, writing = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init') {
          onStatus?.(`Claude Code conectado${ev.model ? ` (${ev.model})` : ''}. Enviando transcrição…`);
        } else if (ev.type === 'system' && ev.subtype === 'status' && ev.status === 'requesting') {
          onStatus?.('Aguardando resposta do Claude…');
        } else if (ev.type === 'stream_event') {
          const e = ev.event || {};
          if (e.type === 'message_start') model = e.message?.model || model;
          if (e.type === 'content_block_start' && e.content_block?.type === 'thinking' && !thinkingNotified) {
            thinkingNotified = true; onStatus?.('Claude está analisando a reunião…');
          }
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            if (!writing) { writing = true; onStatus?.('Claude está escrevendo…'); }
            text += e.delta.text;
            onText?.(e.delta.text, text);
          }
        } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status === 'rejected') {
          onStatus?.('Limite de uso do Claude atingido.');
        } else if (ev.type === 'result' || ('result' in ev && 'total_cost_usd' in ev)) {
          result = ev;
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.write(prompt);
    child.stdin.end();

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new UserError(`Não foi possível executar o Claude Code: ${e.message}`, 'spawn'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (result && !result.is_error) {
        const final = (result.result || text || '').trim();
        return resolve({ text: final, costUsd: result.total_cost_usd, durationMs: result.duration_ms, model, engine: 'claude' });
      }
      if (timedOut) return reject(new UserError(`O Claude não respondeu em ${Math.round(timeoutMs / 60000)} min (tempo esgotado). Tente novamente.`, 'timeout'));
      if (code === null) return reject(new UserError('Geração cancelada.', 'cancelled'));
      const raw = (result && (result.result || result.error)) || stderr || text || `código de saída ${code}`;
      reject(new UserError(friendlyError(raw) || `O Claude Code falhou: ${String(raw).slice(0, 400)}`, 'claude-failed'));
    });
  });
}

module.exports = { runClaude, claudeInfo, readSkill, SKILL_PATH };
