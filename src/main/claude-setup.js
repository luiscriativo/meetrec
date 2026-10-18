// Instala o Claude Code e faz o login sem o usuário abrir um terminal.
// Instalação: instalador oficial nativo (não precisa de Node nem de Git) — PowerShell no Windows,
// bash + curl no macOS/Linux; o executável vai para ~/.local/bin, onde o findClaude já procura.
// Login: "claude auth login" abre o navegador; o app acompanha com "claude auth status" e
// encerra sozinho quando a conta estiver conectada.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { findClaude, needsShell, run, clearCache, isWin } = require('./tools');

const INSTALL_URL = { win: 'https://claude.ai/install.ps1', unix: 'https://claude.ai/install.sh' };
const LOGIN_TIMEOUT = 10 * 60e3;

function installCommand(platform = process.platform) {
  if (process.env.MEETREC_DEV_FAKE_INSTALL) { // só em desenvolvimento (main.js): simula sem instalar
    const script = 'for i in 1 2 3 4; do echo "Baixando parte $i de 4..."; sleep 1; done; echo "Setting up Claude Code..."';
    return platform === 'win32'
      ? { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', '1..4 | % { "Baixando parte $_ de 4..."; Start-Sleep 1 }; "Setting up Claude Code..."'] }
      : { cmd: '/bin/bash', args: ['-c', script] };
  }
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm ${INSTALL_URL.win} | iex`],
    };
  }
  // curl quase sempre existe; wget é o plano B em Linux mínimos
  return { cmd: '/bin/bash', args: ['-c', `if command -v curl >/dev/null 2>&1; then curl -fsSL ${INSTALL_URL.unix} | bash; else wget -qO- ${INSTALL_URL.unix} | bash; fi`] };
}

/** Lê a saída de "claude auth status --json". known=false: CLI antigo, sem esse comando. */
function parseAuthStatus(out) {
  const s = String(out || '');
  const i = s.indexOf('{');
  if (i < 0) return { known: false, loggedIn: null };
  try {
    const j = JSON.parse(s.slice(i, s.lastIndexOf('}') + 1));
    if (typeof j.loggedIn !== 'boolean') return { known: false, loggedIn: null };
    return { known: true, loggedIn: j.loggedIn, email: j.email || '', plan: j.subscriptionType || '', method: j.authMethod || '' };
  } catch { return { known: false, loggedIn: null }; }
}

async function authStatus(bin) {
  if (!bin) return { known: false, loggedIn: null };
  const r = await run(bin, ['auth', 'status', '--json'], { timeout: 20000, shell: needsShell(bin) });
  return parseAuthStatus(r.out);
}

// Link de login que o CLI imprime caso o navegador não abra
function findLoginUrl(text) {
  const m = String(text || '').match(/https:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

// Mensagem de erro amigável para falhas da instalação
function installErrorMessage(log, code) {
  const t = String(log || '').toLowerCase();
  if (/could not resolve|name resolution|no such host|unable to connect|failed to connect|network|timed out|não foi possível conectar/.test(t))
    return 'Sem conexão com a internet para baixar o Claude Code. Verifique a rede e tente de novo.';
  if (/supported-countries|not available in your region/.test(t))
    return 'O site de downloads do Claude não respondeu como esperado (serviço fora do ar ou região não atendida). Tente de novo mais tarde.';
  if (/execution policy|is disabled on this system|scripts is disabled/.test(t))
    return 'O Windows bloqueou o instalador (política de scripts da empresa). Peça ao suporte de TI para instalar o Claude Code ou use o Codex.';
  if (/access is denied|permission denied|acesso negado/.test(t))
    return 'Sem permissão para instalar na sua pasta de usuário. Tente de novo; se continuar, peça ajuda ao suporte de TI.';
  if (/virus|threat|blocked by/.test(t))
    return 'O antivírus bloqueou o instalador do Claude Code. Libere o download em claude.ai e tente de novo.';
  return `A instalação do Claude Code falhou (código ${code}). Veja os detalhes e tente de novo.`;
}

class ClaudeSetup extends EventEmitter {
  constructor() {
    super();
    this.state = { phase: 'idle' }; // idle | installing | logging-in | done | error
    this.child = null;
    this.poll = null;
    this.log = '';
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', { ...this.state, log: this.log.slice(-6000) });
  }

  _log(t) {
    // Sem códigos de cor ANSI e com quebras de linha normais
    this.log = (this.log + String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')).slice(-20000);
    this.emit('state', { ...this.state, log: this.log.slice(-6000) });
  }

  busy() { return this.state.phase === 'installing' || this.state.phase === 'logging-in'; }

  /** Situação atual: instalado? versão? conectado? */
  async status(custom) {
    clearCache();
    const bin = await findClaude(custom);
    if (!bin) return { installed: false };
    const v = await run(bin, ['--version'], { timeout: 15000, shell: needsShell(bin) });
    if (v.code !== 0) return { installed: false, path: bin, broken: true };
    const auth = await authStatus(bin);
    return { installed: true, path: bin, version: v.out.trim().split('\n')[0], ...auth };
  }

  async install(custom) {
    if (this.busy()) throw new Error('Já existe uma instalação ou login em andamento.');
    this.log = '';
    this._set({ phase: 'installing', message: 'Baixando e instalando o Claude Code…', startedAt: Date.now(), url: null, error: null });
    const { cmd, args } = installCommand();
    this._log(`> ${isWin ? 'irm ' + INSTALL_URL.win + ' | iex' : 'curl -fsSL ' + INSTALL_URL.unix + ' | bash'}\n`);
    const r = await run(cmd, args, {
      timeout: 15 * 60e3,
      env: { CI: '1', NO_COLOR: '1' },
      onSpawn: (c) => { this.child = c; },
      onStdout: (d) => this._log(d),
      onStderr: (d) => this._log(d),
    });
    this.child = null;
    if (this.state.phase !== 'installing') return this.state; // cancelado
    const st = await this.status(custom);
    if (!st.installed) {
      const msg = r.code === 0 ? 'O instalador terminou, mas o Claude Code não foi encontrado. Feche e abra o MeetRec e tente de novo.' : installErrorMessage(this.log, r.code);
      this._set({ phase: 'error', message: msg, error: msg });
      throw new Error(msg);
    }
    this._set({ phase: 'idle', message: `Claude Code ${st.version} instalado.`, installed: st });
    return st;
  }

  async login(custom) {
    if (this.busy()) throw new Error('Já existe uma instalação ou login em andamento.');
    const bin = await findClaude(custom);
    if (!bin) throw new Error('Instale o Claude Code antes de entrar na conta.');
    this.log = '';
    this._set({ phase: 'logging-in', message: 'Abrindo o navegador para você entrar na sua conta Claude…', startedAt: Date.now(), url: null, error: null });

    return new Promise((resolve, reject) => {
      let finished = false;
      const shell = needsShell(bin);
      const child = spawn(shell ? `"${bin}"` : bin, ['auth', 'login'], { windowsHide: true, shell, env: { ...process.env, NO_COLOR: '1' } });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      const onOut = (d) => {
        this._log(d);
        const url = !this.state.url && findLoginUrl(d);
        if (url) this._set({ url, message: 'Termine o login na janela do navegador que abriu. Se ela não abriu, use o botão “Abrir página de login”.' });
      };
      child.stdout.on('data', onOut);
      child.stderr.on('data', onOut);

      const finish = async (err, st) => {
        if (finished) return;
        finished = true;
        clearInterval(this.poll);
        clearTimeout(timer);
        this.poll = null;
        if (this.child && this.child.exitCode === null) { try { this.child.kill(); } catch {} }
        this.child = null;
        if (err) { this._set({ phase: err.cancelled ? 'idle' : 'error', message: err.message, error: err.cancelled ? null : err.message }); reject(err); return; }
        this._set({ phase: 'done', message: st.email ? `Conectado como ${st.email}.` : 'Conta conectada.', auth: st });
        resolve(st);
      };

      // O login termina no navegador: confere a cada 2,5 s se a conta já está conectada
      this.poll = setInterval(async () => {
        const st = await authStatus(bin);
        if (st.loggedIn) finish(null, st);
      }, 2500);
      const timer = setTimeout(() => finish(new Error('O login não foi concluído em 10 minutos. Tente de novo.')), LOGIN_TIMEOUT);

      child.on('error', (e) => finish(new Error(`Não foi possível iniciar o login: ${e.message}`)));
      child.on('close', async (code) => {
        if (finished) return;
        const st = await authStatus(bin);
        if (st.loggedIn) return finish(null, st);
        if (this.state.cancelRequested) return finish(Object.assign(new Error('Login cancelado.'), { cancelled: true }));
        // CLI antigo sem "auth login": orienta o caminho manual
        if (/unknown command|error: unknown/i.test(this.log)) return finish(new Error('Esta versão do Claude Code é antiga. Clique em “Instalar Claude Code” para atualizar e tente de novo.'));
        finish(new Error(code === 0 ? 'O login não foi confirmado. Tente de novo.' : `O login falhou (código ${code}). Tente de novo.`));
      });
    }).finally(() => { if (this.state.cancelRequested) this._set({ cancelRequested: false }); });
  }

  // Código de autorização colado pelo usuário (quando o login é feito pelo link manual)
  sendCode(code) {
    if (this.state.phase !== 'logging-in' || !this.child?.stdin?.writable) return false;
    this.child.stdin.write(String(code).trim() + '\n');
    this._log('(código enviado)\n');
    return true;
  }

  cancel() {
    if (!this.busy()) return false;
    const wasInstall = this.state.phase === 'installing';
    this._set({ cancelRequested: true });
    try { this.child?.kill(); } catch {}
    if (wasInstall) this._set({ phase: 'idle', message: 'Instalação cancelada.', cancelRequested: false });
    return true;
  }
}

module.exports = { ClaudeSetup, installCommand, parseAuthStatus, findLoginUrl, installErrorMessage, authStatus };
