// Cópia da extensão do navegador numa pasta comum (Documentos), mantida em dia a cada abertura do app.
// Motivo: no Mac a extensão fica dentro do MeetRec.app (o Chrome não deixa escolher pasta lá dentro)
// e no Linux (AppImage) o caminho do app muda a cada execução. A cópia tem sempre o mesmo caminho,
// então a extensão carregada no navegador continua funcionando depois das atualizações.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FOLDER_NAME = 'MeetRec - Extensão do navegador';
const README = 'LEIA-ME.txt';

function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

const readVersion = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version || null; } catch { return null; }
};

/**
 * Deixa `dest` idêntica a `src` (só reescreve o que mudou e apaga o que não existe mais).
 * Retorna { dir, version, changed, error? }. Em caso de erro, `dir` volta a ser `src`.
 */
function syncExtension(src, dest) {
  try {
    if (!fs.existsSync(path.join(src, 'manifest.json'))) throw new Error('extensão não encontrada no app');
    fs.mkdirSync(dest, { recursive: true });
    const files = listFiles(src);
    let changed = 0;
    for (const rel of files) {
      const a = path.join(src, rel), b = path.join(dest, rel);
      const data = fs.readFileSync(a);
      let same = false;
      try { same = fs.readFileSync(b).equals(data); } catch {}
      if (!same) {
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.writeFileSync(b, data);
        changed++;
      }
    }
    // Remove arquivos de versões antigas da extensão (a pasta é do app; o LEIA-ME é mantido)
    const keep = new Set(files.map((f) => path.normalize(f)));
    for (const rel of listFiles(dest)) {
      if (rel === README || keep.has(path.normalize(rel))) continue;
      try { fs.unlinkSync(path.join(dest, rel)); changed++; } catch {}
    }
    const version = readVersion(src);
    const readme = `Extensão do navegador do MeetRec (versão ${version}).\r\n\r\n`
      + 'Esta pasta é mantida pelo app MeetRec: ela é atualizada sozinha quando o app é atualizado.\r\n'
      + 'Não mova nem apague esta pasta depois de instalar a extensão no navegador.\r\n\r\n'
      + 'Como instalar (Chrome, Edge, Brave):\r\n'
      + '1. Abra chrome://extensions (ou edge://extensions)\r\n'
      + '2. Ative o "Modo do desenvolvedor"\r\n'
      + '3. Clique em "Carregar sem compactação" e escolha ESTA pasta\r\n'
      + '4. Clique no ícone do MeetRec na barra do navegador e cole o código de pareamento\r\n'
      + '   (MeetRec → Configurações → Integrações)\r\n';
    try { if (fs.readFileSync(path.join(dest, README), 'utf8') !== readme) fs.writeFileSync(path.join(dest, README), readme); } catch { fs.writeFileSync(path.join(dest, README), readme); }
    return { dir: dest, version, changed };
  } catch (e) {
    return { dir: src, version: readVersion(src), changed: 0, error: e.message };
  }
}

// ───────── Abrir a página de extensões no navegador ─────────
// chrome://extensions não abre pelo sistema (não é um link comum): é preciso iniciar o navegador com ela.
function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || '';
    return [
      { id: 'chrome', name: 'Chrome', url: 'chrome://extensions', paths: [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${local}\\Google\\Chrome\\Application\\chrome.exe`] },
      { id: 'edge', name: 'Edge', url: 'edge://extensions', paths: [`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`] },
      { id: 'brave', name: 'Brave', url: 'brave://extensions', paths: [`${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${pf86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`] },
    ];
  }
  if (platform === 'darwin') {
    const home = env.HOME || '';
    const app = (n) => [`/Applications/${n}.app`, `${home}/Applications/${n}.app`];
    return [
      { id: 'chrome', name: 'Chrome', url: 'chrome://extensions', app: 'Google Chrome', paths: app('Google Chrome') },
      { id: 'edge', name: 'Edge', url: 'edge://extensions', app: 'Microsoft Edge', paths: app('Microsoft Edge') },
      { id: 'brave', name: 'Brave', url: 'brave://extensions', app: 'Brave Browser', paths: app('Brave Browser') },
    ];
  }
  const bins = (names) => names.flatMap((n) => [`/usr/bin/${n}`, `/usr/local/bin/${n}`, `/snap/bin/${n}`]);
  return [
    { id: 'chrome', name: 'Chrome', url: 'chrome://extensions', paths: bins(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) },
    { id: 'edge', name: 'Edge', url: 'edge://extensions', paths: bins(['microsoft-edge', 'microsoft-edge-stable']) },
    { id: 'brave', name: 'Brave', url: 'brave://extensions', paths: bins(['brave-browser', 'brave']) },
  ];
}

function findBrowsers() {
  return browserCandidates().map((b) => ({ ...b, path: b.paths.find((p) => p && fs.existsSync(p)) })).filter((b) => b.path)
    .map(({ id, name, url, app, path: p }) => ({ id, name, url, app, path: p }));
}

function openExtensionsPage(id) {
  const b = findBrowsers().find((x) => x.id === id);
  if (!b) return { ok: false, error: 'Navegador não encontrado.' };
  try {
    const child = process.platform === 'darwin'
      ? spawn('open', ['-a', b.app, b.url], { detached: true, stdio: 'ignore' })
      : spawn(b.path, [b.url], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
    return { ok: true, name: b.name, url: b.url };
  } catch (e) {
    return { ok: false, error: e.message, url: b.url };
  }
}

module.exports = { FOLDER_NAME, syncExtension, readVersion, browserCandidates, findBrowsers, openExtensionsPage };
