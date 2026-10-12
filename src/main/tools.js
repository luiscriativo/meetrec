// Localiza e executa ferramentas externas: ffmpeg, Python e Claude Code CLI.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';

function ffmpegPath() {
  let p = null;
  try { p = require('ffmpeg-static'); } catch { /* sem binário embutido */ }
  if (p) p = p.replace('app.asar', 'app.asar.unpacked');
  if (p && fs.existsSync(p)) return p;
  return 'ffmpeg'; // tenta o do sistema
}

function resourcePath(...parts) {
  const base = path.join(__dirname, '..', '..');
  return path.join(base, ...parts).replace('app.asar', 'app.asar.unpacked');
}

// Executa e coleta saída (com timeout)
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, shell: opts.shell || false, cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) } });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e.message || e) });
    }
    const timer = opts.timeout ? setTimeout(() => { try { child.kill(); } catch {} }, opts.timeout) : null;
    // Decodifica UTF-8 respeitando caracteres que chegam divididos entre dois blocos
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { out += d; opts.onStdout?.(String(d)); });
    child.stderr?.on('data', (d) => { err += d; opts.onStderr?.(String(d)); });
    if (opts.input != null) { child.stdin.write(opts.input); child.stdin.end(); }
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: err + String(e.message || e) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
    opts.onSpawn?.(child);
  });
}

function needsShell(p) { return isWin && /\.(cmd|bat)$/i.test(p); }

async function whichAll(name) {
  const r = isWin ? await run('where', [name], { timeout: 5000 }) : await run('/bin/sh', ['-lc', `command -v ${name}`], { timeout: 5000 });
  return r.code === 0 ? r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

// No macOS apps de GUI não herdam o PATH do terminal: consulta o shell de login.
async function loginShellWhich(name) {
  if (isWin) return [];
  const sh = process.env.SHELL || '/bin/zsh';
  const r = await run(sh, ['-ilc', `command -v ${name}`], { timeout: 8000 });
  return r.code === 0 ? r.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.startsWith('/')) : [];
}

let cache = {};

async function findClaude(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  if (cache.claude) return cache.claude;
  const home = os.homedir();
  const candidates = [
    ...(await whichAll('claude')),
    ...(await loginShellWhich('claude')),
    path.join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude'),
    path.join(home, '.claude', 'local', isWin ? 'claude.exe' : 'claude'),
    isWin ? path.join(process.env.APPDATA || '', 'npm', 'claude.cmd') : '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  // Prefere .exe a .cmd no Windows
  candidates.sort((a, b) => (/\.exe$/i.test(b) ? 1 : 0) - (/\.exe$/i.test(a) ? 1 : 0));
  for (const c of candidates) {
    if (c && fs.existsSync(c)) { cache.claude = c; return c; }
  }
  return null;
}

async function findPython(custom) {
  if (custom) {
    const r = await run(custom, ['--version'], { timeout: 8000 });
    if (r.code === 0) return { cmd: custom, args: [], version: (r.out || r.err).trim() };
  }
  if (cache.python) return cache.python;
  const tries = isWin ? [['python', []], ['py', ['-3']], ['python3', []]] : [['python3', []], ['python', []]];
  for (const extra of await loginShellWhich('python3')) tries.push([extra, []]);
  for (const [cmd, args] of tries) {
    // Pede o executável real (resolve shims .bat do pyenv-win e aliases)
    const code = 'import sys;print(sys.executable);print(sys.version.split()[0])';
    const r = await run(cmd, [...args, '-c', isWin ? `"${code}"` : code], { timeout: 10000, shell: isWin });
    const lines = (r.out || '').trim().split(/\r?\n/);
    if (r.code === 0 && lines.length >= 2 && /^3\.\d+/.test(lines[1]) && fs.existsSync(lines[0])) {
      cache.python = { cmd: lines[0], args: [], version: `Python ${lines[1]}` };
      return cache.python;
    }
  }
  return null;
}

function clearCache() { cache = {}; }

// Duração (s) e volume máximo (dB) de um arquivo de áudio via ffmpeg
async function probeAudio(file) {
  const r = await run(ffmpegPath(), ['-hide_banner', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { timeout: 10 * 60 * 1000 });
  const txt = r.err;
  let duration = 0;
  const times = [...txt.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (times.length) {
    const t = times[times.length - 1];
    duration = +t[1] * 3600 + +t[2] * 60 + +t[3];
  }
  const dm = txt.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!duration && dm) duration = +dm[1] * 3600 + +dm[2] * 60 + +dm[3];
  const mv = txt.match(/max_volume: (-?[\d.]+) dB/);
  const meanv = txt.match(/mean_volume: (-?[\d.]+) dB/);
  return { duration, maxVolume: mv ? +mv[1] : -91, meanVolume: meanv ? +meanv[1] : -91, ok: r.code === 0, err: r.code === 0 ? '' : txt.slice(-600) };
}

module.exports = { ffmpegPath, resourcePath, run, findClaude, findPython, needsShell, clearCache, probeAudio, isWin, execFile };
