const test = require('node:test');
const assert = require('node:assert/strict');
const { installCommand, parseAuthStatus, findLoginUrl, installErrorMessage } = require('../src/main/claude-setup');

test('instalador oficial nativo em cada sistema (sem Node, sem Git)', () => {
  const win = installCommand('win32');
  assert.equal(win.cmd, 'powershell.exe');
  assert.ok(win.args.includes('Bypass'));
  assert.match(win.args.at(-1), /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  for (const p of ['darwin', 'linux']) {
    const u = installCommand(p);
    assert.equal(u.cmd, '/bin/bash');
    assert.match(u.args[1], /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.match(u.args[1], /wget/); // plano B em Linux sem curl
  }
});

test('lê "claude auth status --json"', () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.com", "subscriptionType": "pro"}'),
    { known: true, loggedIn: true, email: 'a@b.com', plan: 'pro', method: 'claude.ai' });
  assert.equal(parseAuthStatus('{"loggedIn": false}').loggedIn, false);
  assert.equal(parseAuthStatus('aviso qualquer\n{"loggedIn": false}\n').known, true);
  // CLI antigo, sem o comando: não dá para saber
  assert.deepEqual(parseAuthStatus("error: unknown command 'auth'"), { known: false, loggedIn: null });
  assert.deepEqual(parseAuthStatus(''), { known: false, loggedIn: null });
  assert.deepEqual(parseAuthStatus('{"outra": 1}'), { known: false, loggedIn: null });
});

test('acha o link de login na saída do CLI', () => {
  const out = "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y\n";
  assert.equal(findLoginUrl(out), 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y');
  assert.equal(findLoginUrl('Opening browser…'), null);
});

test('mensagens de erro da instalação em português e com o que fazer', () => {
  assert.match(installErrorMessage('irm : Could not resolve host: claude.ai', 1), /internet/);
  assert.match(installErrorMessage('running scripts is disabled on this system', 1), /política/);
  assert.match(installErrorMessage('Access is denied.', 1), /permissão/);
  assert.match(installErrorMessage('qualquer coisa', 7), /código 7/);
});
