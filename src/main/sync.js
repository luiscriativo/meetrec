// Sincronização entre computadores por uma pasta na nuvem (Google Drive para computador).
// O app não fala com a nuvem: o Drive copia os arquivos e aqui ficam as regras para dois PCs
// usarem a mesma pasta sem pisar um no outro. Sem Electron — testável com node --test.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Uma máquina "dona" de uma gravação/processamento renova o sinal de vida (busyAt) a cada HEARTBEAT.
// Sem sinal por mais de LEASE, a reunião é considerada travada e pode ser liberada no outro PC.
const HEARTBEAT_MS = 2 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;
// Presença: "esta reunião está aberta no PC X"
const PRESENCE_MS = 6 * 60 * 1000;
const SYNC_DIR = '.sync';
const ACTIVE = ['recording', 'paused', 'processing'];

const isActive = (m) => ACTIVE.includes(m?.status);

// Quem está trabalhando nesta reunião agora: null (ninguém/este PC) ou { name, at, stale }
function remoteOwner(meta, machineId, now = Date.now()) {
  if (!isActive(meta) || !meta.busyBy?.id || meta.busyBy.id === machineId) return null;
  const at = Date.parse(meta.busyAt || '') || 0;
  return { id: meta.busyBy.id, name: meta.busyBy.name || 'outro computador', at: meta.busyAt || null, stale: now - at > LEASE_MS };
}

// Ao abrir o app: só as reuniões deste PC (ou de versões antigas, sem dono) podem estar "interrompidas"
function ownedHere(meta, machineId) {
  return !meta.busyBy?.id || meta.busyBy.id === machineId;
}

// Arquivos que o Drive/Windows/o próprio app criam e que nunca devem disparar recarga
const JUNK = [
  /\.tmp$/i, /\.drivedownload$/i, /\.drive(upload|tmp)/i, /^~\$/, /^\.~lock/, /^desktop\.ini$/i,
  /^thumbs\.db$/i, /^\.ds_store$/i, /^icon\r?$/i, /\.part$/i, /\.crdownload$/i,
];
function isJunk(file) {
  const base = path.basename(String(file || ''));
  return !base || JUNK.some((r) => r.test(base));
}

// Cópias de conflito do Drive: "meta (1).json", "2026-10-12_012542 (1)"
const CONFLICT = /\s\(\d+\)(\.[^.]+)?$/;
const isConflictCopy = (name) => CONFLICT.test(String(name || ''));
// Pasta de reunião duplicada pelo Drive (a original continua valendo)
const isConflictMeetingDir = (name, meetingDirRe) => isConflictCopy(name) && meetingDirRe.test(String(name).replace(/\s\(\d+\)$/, ''));

// Junta duas versões de uma reunião: a do disco (outro PC) é a base; `patch` aplica o que este PC mudou.
// Listas que crescem nos dois lados (marcadores, chat, avisos) viram a união.
function mergeMeta(disk, mine) {
  if (!disk) return mine;
  const out = { ...disk, ...mine };
  const unionBy = (a = [], b = [], key) => {
    const seen = new Set(); const res = [];
    for (const x of [...a, ...b]) { const k = key(x); if (!seen.has(k)) { seen.add(k); res.push(x); } }
    return res;
  };
  out.markers = unionBy(disk.markers, mine.markers, (m) => `${Math.round((m?.t || 0) * 10)}`).sort((a, b) => a.t - b.t);
  out.chat = unionBy(disk.chat, mine.chat, (c) => `${c?.at || ''}|${c?.role || ''}|${String(c?.text || '').slice(0, 80)}`);
  out.warnings = [...new Set([...(disk.warnings || []), ...(mine.warnings || [])])];
  // Dúvidas: a resolvida vence a aberta
  if (disk.doubts || mine.doubts) {
    const byId = new Map((disk.doubts || []).map((d) => [d.id, d]));
    for (const d of mine.doubts || []) {
      const o = byId.get(d.id);
      byId.set(d.id, !o || o.status === 'open' || !d.status || d.status !== 'open' ? d : o);
    }
    out.doubts = [...byId.values()];
  }
  return out;
}

// Junta o contexto de uma pasta que existe nos dois PCs: glossário vira a união; o resto fica com o destino
function mergeFolderData(target, source) {
  const out = { ...target };
  const terms = new Map(target.glossary.map((g) => [g.term.toLowerCase(), { ...g, heard: [...g.heard] }]));
  for (const g of source.glossary || []) {
    const cur = terms.get(g.term.toLowerCase());
    if (cur) { cur.heard = [...new Set([...cur.heard, ...g.heard])]; cur.uses = Math.max(cur.uses || 1, g.uses || 1); } else terms.set(g.term.toLowerCase(), g);
  }
  out.glossary = [...terms.values()];
  if (!out.context && source.context) { out.context = source.context; out.contextAt = source.contextAt; }
  if (!out.history && source.history) { out.history = source.history; out.historyAt = source.historyAt; }
  if (!out.description && source.description) out.description = source.description;
  return out;
}

// Onde o Google Drive para computador montou o "Meu Drive" (null se não estiver instalado)
function findGoogleDrive({ platform = process.platform, home = os.homedir(), exists = fs.existsSync, readdir = (p) => fs.readdirSync(p) } = {}) {
  const names = ['Meu Drive', 'My Drive', 'Mi unidad', 'Mon Drive'];
  const cands = [];
  if (platform === 'win32') {
    for (const l of 'GHIJKLMNOPQRSTUVWXYZDEF') for (const n of names) cands.push(`${l}:\\${n}`);
    cands.push(path.join(home, 'Google Drive'), path.join(home, 'Meu Drive'));
  } else if (platform === 'darwin') {
    const cs = path.join(home, 'Library', 'CloudStorage');
    let acc = [];
    try { acc = readdir(cs).filter((d) => d.startsWith('GoogleDrive')); } catch {}
    for (const a of acc) for (const n of names) cands.push(path.join(cs, a, n));
    cands.push(path.join(home, 'Google Drive'));
  } else {
    cands.push(path.join(home, 'Google Drive'), path.join(home, 'GoogleDrive'));
  }
  return cands.find((p) => { try { return exists(p); } catch { return false; } }) || null;
}

// O Google Drive para computador está instalado (mesmo que fechado agora)?
function googleDriveInstalled({ platform = process.platform, exists = fs.existsSync, env = process.env } = {}) {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const cands = platform === 'win32'
    ? [path.join(pf, 'Google', 'Drive File System'), path.join(pf, 'Google', 'Drive File Stream'), path.join(env.LOCALAPPDATA || '', 'Google', 'DriveFS')]
    : platform === 'darwin' ? ['/Applications/Google Drive.app'] : [];
  return cands.some((p) => { try { return exists(p); } catch { return false; } });
}

// A pasta parece estar dentro de um serviço de nuvem? (para mostrar o status na tela)
function cloudKind(dir) {
  const d = String(dir || '');
  if (/google\s?drive|[\\/](meu drive|my drive|mi unidad|mon drive)([\\/]|$)/i.test(d)) return 'Google Drive';
  if (/onedrive/i.test(d)) return 'OneDrive';
  if (/dropbox/i.test(d)) return 'Dropbox';
  return null;
}

function machineName() {
  return os.hostname().replace(/\.local$/i, '') || 'Este computador';
}

module.exports = {
  HEARTBEAT_MS, LEASE_MS, PRESENCE_MS, SYNC_DIR, ACTIVE,
  isActive, remoteOwner, ownedHere, isJunk, isConflictCopy, isConflictMeetingDir,
  mergeMeta, mergeFolderData, findGoogleDrive, googleDriveInstalled, cloudKind, machineName,
};
