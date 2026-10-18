const test = require('node:test');
const assert = require('node:assert/strict');
const { installCommand, parseAuthStatus, parseCodexStatus, findLoginUrl, installErrorMessage, CLIS } = require('../src/main/ai-setup');

test('Claude Code: instalador oficial nativo em cada sistema (sem Node, sem Git)', () => {
  const win = installCommand('claude', 'win32');
  assert.equal(win.cmd, 'powershell.exe');
  assert.ok(win.args.includes('Bypass'));
  assert.match(win.args.at(-1), /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  for (const p of ['darwin', 'linux']) {
    const u = installCommand('claude', p);
    assert.equal(u.cmd, '/bin/bash');
    assert.match(u.args[1], /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.match(u.args[1], /wget/); // plano B em Linux sem curl
  }
});

test('Codex: instalador oficial da OpenAI, sem perguntas e sem npm', () => {
  const win = installCommand('codex', 'win32');
  assert.equal(win.cmd, 'powershell.exe');
  assert.match(win.args.at(-1), /irm https:\/\/chatgpt\.com\/codex\/install\.ps1 \| iex/);
  for (const p of ['darwin', 'linux']) {
    const u = installCommand('codex', p);
    assert.match(u.args[1], /curl -fsSL https:\/\/chatgpt\.com\/codex\/install\.sh \| sh/);
    assert.doesNotMatch(u.args[1], /npm/);
  }
  // O instalador pergunta "Iniciar o Codex agora?" — o app não tem como responder
  assert.equal(CLIS.codex.installEnv.CODEX_NON_INTERACTIVE, '1');
  assert.deepEqual(CLIS.codex.loginArgs, ['login']);
  assert.deepEqual(CLIS.claude.loginArgs, ['auth', 'login']);
});

test('lê "claude auth status --json"', () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.com", "subscriptionType": "pro"}'),
    { known: true, loggedIn: true, email: 'a@b.com', plan: 'pro', method: 'claude.ai' });
  assert.equal(parseAuthStatus('{"loggedIn": false}').loggedIn, false);
  assert.equal(parseAuthStatus('aviso qualquer\n{"loggedIn": false}\n').known, true);
  // CLI antigo, sem o comando: não dá para saber
  assert.deepEqual(parseAuthStatus("error: unknown command 'auth'"), { known: false, loggedIn: null });
  assert.deepEqual(parseAuthStatus(''), { known: false, loggedIn: null });
});

test('lê "codex login status"', () => {
  const ok = parseCodexStatus(0, 'Logged in using ChatGPT\n');
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.method, 'ChatGPT');
  assert.equal(parseCodexStatus(1, 'Not logged in').loggedIn, false);
  assert.equal(parseCodexStatus(0, 'Not logged in').loggedIn, false);
  assert.equal(parseCodexStatus(0, 'Logged in using an API key - sk-***').method, 'chave de API');
});

test('acha o link de login na saída dos dois CLIs', () => {
  const claude = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y\n";
  assert.equal(findLoginUrl(claude), 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y');
  // O Codex imprime antes o endereço local (http) do servidor de login: o link certo é o https
  const codex = 'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&state=z\n';
  assert.equal(findLoginUrl(codex), 'https://auth.openai.com/oauth/authorize?response_type=code&state=z');
  assert.equal(findLoginUrl('Opening browser…'), null);
});

test('mensagens de erro da instalação em português, com o nome do CLI', () => {
  assert.match(installErrorMessage('irm : Could not resolve host: claude.ai', 1, 'claude'), /internet.*|Claude Code/);
  assert.match(installErrorMessage('Could not resolve host', 1, 'codex'), /Codex/);
  assert.match(installErrorMessage('running scripts is disabled on this system', 1, 'codex'), /política/);
  assert.match(installErrorMessage('Access is denied.', 1), /permissão/);
  assert.match(installErrorMessage('qualquer coisa', 7, 'codex'), /Codex falhou \(código 7\)/);
});
