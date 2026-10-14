// Leva a biblioteca de uma pasta para outra (ex.: Documentos → Google Drive), juntando com o que já
// estiver lá (a biblioteca do outro PC). Nada é sobrescrito: reunião com o mesmo nome no destino fica
// como está e a daqui permanece na pasta antiga. Sem Electron — testável com node --test.
const fs = require('fs');
const path = require('path');
const F = require('./folders');
const S = require('./sync');

const hasMeta = (d) => fs.existsSync(path.join(d, 'meta.json'));
const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

// Reuniões e pastas do usuário dentro de uma biblioteca
function scanLibrary(root) {
  const meetings = []; const folders = [];
  for (const n of dirs(root)) {
    if (n === F.CTX_DIR || n.startsWith('.') || S.isConflictMeetingDir(n, F.MEETING_DIR)) continue;
    const full = path.join(root, n);
    if (hasMeta(full)) meetings.push({ id: n, folder: '' });
    else if (!F.MEETING_DIR.test(n) && !n.startsWith('_')) {
      folders.push(n);
      for (const m of dirs(full)) if (m !== F.CTX_DIR && !m.startsWith('.') && hasMeta(path.join(full, m))) meetings.push({ id: m, folder: n });
    }
  }
  return { meetings, folders };
}

const countMeetings = (root) => scanLibrary(root).meetings.length;

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (child, parent) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

function countFiles(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(d, e.name)) : 1;
  return n;
}

// Renomeia quando dá (mesmo disco); entre discos (C: → G:) copia, confere e só então apaga a original
async function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); return; } catch (e) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) throw e;
  }
  await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
  if (countFiles(to) < countFiles(from)) throw new Error(`A cópia de ${path.basename(from)} ficou incompleta.`);
  await fs.promises.rm(from, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}

function readFolderData(root, name) {
  try { return F.normalizeFolderData(JSON.parse(fs.readFileSync(path.join(root, name, F.CTX_DIR, 'pasta.json'), 'utf8'))); } catch { return null; }
}

function writeFolderData(root, name, data) {
  const dir = path.join(root, name, F.CTX_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pasta.json'), JSON.stringify(data, null, 2));
}

// mode: 'move' = leva as reuniões daqui para o destino (juntando) · 'switch' = só passa a usar o destino
async function migrateLibrary(from, to, mode = 'move', onProgress = () => {}) {
  if (samePath(from, to)) throw new Error('Essa já é a pasta das gravações.');
  if (inside(to, from)) throw new Error('A nova pasta não pode ficar dentro da pasta atual das gravações.');
  fs.mkdirSync(to, { recursive: true });
  const res = { moved: 0, skipped: [], mergedFolders: [] };
  if (mode !== 'move' || !fs.existsSync(from)) return res;

  const { meetings, folders } = scanLibrary(from);
  // Contexto/glossário: o geral (raiz) e o de cada pasta. Se a pasta já existe no destino, junta.
  for (const name of ['', ...folders]) {
    const src = readFolderData(from, name);
    fs.mkdirSync(path.join(to, name), { recursive: true });
    if (!src) continue;
    const dst = readFolderData(to, name);
    writeFolderData(to, name, dst ? S.mergeFolderData(dst, src) : src);
    if (dst) res.mergedFolders.push(name);
  }
  for (const [i, { id, folder }] of meetings.entries()) {
    onProgress({ done: i, total: meetings.length });
    const dst = path.join(to, folder, id);
    if (fs.existsSync(dst)) { res.skipped.push(id); continue; }
    await moveDir(path.join(from, folder, id), dst);
    res.moved++;
  }
  onProgress({ done: meetings.length, total: meetings.length });

  // Limpa o que ficou vazio na pasta antiga (contexto já foi levado)
  for (const name of folders) {
    const base = path.join(from, name);
    let rest = [];
    try { rest = fs.readdirSync(base).filter((n) => n !== F.CTX_DIR); } catch { continue; }
    if (!rest.length) { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} }
  }
  return res;
}

module.exports = { scanLibrary, countMeetings, migrateLibrary, moveDir };
