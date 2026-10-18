// Instala e faz o login dos CLIs de IA (Claude Code e Codex) sem o usuário abrir um terminal.
// Instalação: instaladores oficiais nativos (não precisam de Node) — PowerShell no Windows,
// sh/bash + curl no macOS/Linux. Login: o CLI abre o navegador; o app confere o status a cada
// 2,5 s e encerra sozinho quando a conta estiver conectada.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { findClaude, findCodex, needsShell, run, clearCache, isWin } = require('./tools');

const LOGIN_TIMEOUT = 10 * 60e3;

const CLIS = {
  claude: {
    name: 'Claude Code', account: 'Claude', site: 'claude.ai',
    win: 'https://claude.ai/install.ps1', unix: 'https://claude.ai/install.sh', unixShell: 'bash',
    find: (custom) => findClaude(custom),
    loginArgs: ['auth', 'login'],
    installEnv: { CI: '1' },
  },
  codex: {
    name: 'Codex', account: 'ChatGPT', site: 'chatgpt.com',
    win: 'https://chatgpt.com/codex/install.ps1', unix: 'https://chatgpt.com/codex/install.sh', unixShell: 'sh',
    find: (custom) => findCodex(custom),
    loginArgs: ['login'],
    // Sem perguntas ("Iniciar o Codex agora?") — o app não tem como respondê-las
    installEnv: { CODEX_NON_INTERACTIVE: '1' },
  },
};

function installCommand(engine, platform = process.platform) {
  const C = CLIS[engine];
  if (process.env.MEETREC_DEV_FAKE_INSTALL) { // só em desenvolvimento (main.js): simula sem instalar
    return platform === 'win32'
      ? { cmd: 'powershell.exe', args: ['-NoProfile', '-Command', `1..4 | % { "Baixando parte $_ de 4..."; Start-Sleep 1 }; "Setting up ${C.name}..."`] }
      : { cmd: '/bin/bash', args: ['-c', `for i in 1 2 3 4; do echo "Baixando parte $i de 4..."; sleep 1; done; echo "Setting up ${C.name}..."`] };
  }
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm ${C.win} | iex`],
    };
  }
  // curl quase sempre existe; wget é o plano B em Linux mínimos
  return { cmd: '/bin/bash', args: ['-c', `if command -v curl >/dev/null 2>&1; then curl -fsSL ${C.unix} | ${C.unixShell}; else wget -qO- ${C.unix} | ${C.unixShell}; fi`] };
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

/** Lê "codex login status": código 0 = conectado ("Logged in using ChatGPT"), 1 = "Not logged in". */
function parseCodexStatus(code, out) {
  const t = String(out || '').trim();
  const loggedIn = code === 0 && !/not logged in/i.test(t);
  return { known: true, loggedIn, email: '', plan: '', method: /chatgpt/i.test(t) ? 'ChatGPT' : /api key/i.test(t) ? 'chave de API' : '', detail: t.split(/\r?\n/)[0] || '' };
}

async function authStatus(bin, engine = 'claude') {
  if (!bin) return { known: false, loggedIn: null };
  const shell = needsShell(bin);
  if (engine === 'codex') {
    const r = await run(shell ? `"${bin}"` : bin, ['login', 'status'], { timeout: 20000, shell });
    return parseCodexStatus(r.code, `${r.out}\n${r.err}`);
  }
  const r = await run(bin, ['auth', 'status', '--json'], { timeout: 20000, shell });
  return parseAuthStatus(r.out);
}

// Link de login que o CLI imprime caso o navegador não abra (ignora o endereço local do callback)
function findLoginUrl(text) {
  const m = String(text || '').match(/https:\/\/[^\s"'<>]+/);
  return m ? m[0] : null;
}

// Mensagem de erro amigável para falhas da instalação
function installErrorMessage(log, code, engine = 'claude') {
  const C = CLIS[engine];
  const t = String(log || '').toLowerCase();
  if (/could not resolve|name resolution|no such host|unable to connect|failed to connect|network|timed out|não foi possível conectar/.test(t))
    return `Sem conexão com a internet para baixar o ${C.name}. Verifique a rede e tente de novo.`;
  if (/supported-countries|not available in your region/.test(t))
    return `O site de downloads do ${C.name} não respondeu como esperado (serviço fora do ar ou região não atendida). Tente de novo mais tarde.`;
  if (/execution policy|is disabled on this system|scripts is disabled/.test(t))
    return `O Windows bloqueou o instalador (política de scripts da empresa). Peça ao suporte de TI para instalar o ${C.name}.`;
  if (/access is denied|permission denied|acesso negado/.test(t))
    return 'Sem permissão para instalar na sua pasta de usuário. Tente de novo; se continuar, peça ajuda ao suporte de TI.';
  if (/virus|threat|blocked by/.test(t))
    return `O antivírus bloqueou o instalador do ${C.name}. Libere o download em ${C.site} e tente de novo.`;
  return `A instalação do ${C.name} falhou (código ${code}). Veja os detalhes e tente de novo.`;
}

class CliSetup extends EventEmitter {
  /** engine: 'claude' | 'codex' */
  constructor(engine) {
    super();
    this.engine = engine;
    this.C = CLIS[engine];
    this.state = { phase: 'idle' }; // idle | installing | logging-in | done | error
    this.child = null;
    this.poll = null;
    this.log = '';
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', { engine: this.engine, ...this.state, log: this.log.slice(-6000) });
  }

  _log(t) {
    // Sem códigos de cor ANSI e com quebras de linha normais
    this.log = (this.log + String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')).slice(-20000);
    this.emit('state', { engine: this.engine, ...this.state, log: this.log.slice(-6000) });
  }

  busy() { return this.state.phase === 'installing' || this.state.phase === 'logging-in'; }

  /** Situação atual: instalado? versão? conectado? */
  async status(custom) {
    clearCache();
    const bin = await this.C.find(custom);
    if (!bin) return { installed: false };
    const shell = needsShell(bin);
    const v = await run(shell ? `"${bin}"` : bin, ['--version'], { timeout: 15000, shell });
    if (v.code !== 0) return { installed: false, path: bin, broken: true };
    const auth = await authStatus(bin, this.engine);
    return { installed: true, path: bin, version: v.out.trim().split('\n')[0], ...auth };
  }

  async install(custom) {
    if (this.busy()) throw new Error('Já existe uma instalação ou login em andamento.');
    this.log = '';
    this._set({ phase: 'installing', message: `Baixando e instalando o ${this.C.name}…`, startedAt: Date.now(), url: null, error: null });
    const { cmd, args } = installCommand(this.engine);
    this._log(`> ${isWin ? `irm ${this.C.win} | iex` : `curl -fsSL ${this.C.unix} | ${this.C.unixShell}`}\n`);
    const r = await run(cmd, args, {
      timeout: 15 * 60e3,
      env: { NO_COLOR: '1', ...this.C.installEnv },
      onSpawn: (c) => { this.child = c; },
      onStdout: (d) => this._log(d),
      onStderr: (d) => this._log(d),
    });
    this.child = null;
    if (this.state.phase !== 'installing') return this.state; // cancelado
    const st = await this.status(custom);
    if (!st.installed) {
      const msg = r.code === 0 ? `O instalador terminou, mas o ${this.C.name} não foi encontrado. Feche e abra o MeetRec e tente de novo.` : installErrorMessage(this.log, r.code, this.engine);
      this._set({ phase: 'error', message: msg, error: msg });
      throw new Error(msg);
    }
    this._set({ phase: 'idle', message: `${this.C.name} ${st.version} instalado.`, installed: st });
    return st;
  }

  async login(custom) {
    if (this.busy()) throw new Error('Já existe uma instalação ou login em andamento.');
    const bin = await this.C.find(custom);
    if (!bin) throw new Error(`Instale o ${this.C.name} antes de entrar na conta.`);
    this.log = '';
    this._set({ phase: 'logging-in', message: `Abrindo o navegador para você entrar na sua conta ${this.C.account}…`, startedAt: Date.now(), url: null, error: null });

    return new Promise((resolve, reject) => {
      let finished = false;
      const shell = needsShell(bin);
      const child = spawn(shell ? `"${bin}"` : bin, this.C.loginArgs, { windowsHide: true, shell, env: { ...process.env, NO_COLOR: '1' } });
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
        const st = await authStatus(bin, this.engine);
        if (st.loggedIn) finish(null, st);
      }, 2500);
      const timer = setTimeout(() => finish(new Error('O login não foi concluído em 10 minutos. Tente de novo.')), LOGIN_TIMEOUT);

      child.on('error', (e) => finish(new Error(`Não foi possível iniciar o login: ${e.message}`)));
      child.on('close', async (code) => {
        if (finished) return;
        const st = await authStatus(bin, this.engine);
        if (st.loggedIn) return finish(null, st);
        if (this.state.cancelRequested) return finish(Object.assign(new Error('Login cancelado.'), { cancelled: true }));
        if (/address already in use|addrinuse|port .* in use/i.test(this.log)) return finish(new Error(`Outro login do ${this.C.name} está aberto. Feche-o (ou reinicie o computador) e tente de novo.`));
        // CLI antigo sem o comando de login: orienta a atualizar
        if (/unknown command|error: unknown|unrecognized subcommand/i.test(this.log)) return finish(new Error(`Esta versão do ${this.C.name} é antiga. Clique em “Instalar ${this.C.name}” para atualizar e tente de novo.`));
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

module.exports = { CliSetup, CLIS, installCommand, parseAuthStatus, parseCodexStatus, findLoginUrl, installErrorMessage, authStatus };
