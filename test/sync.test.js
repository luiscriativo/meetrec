const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/main/sync');
const F = require('../src/main/folders');
const { migrateLibrary, countMeetings } = require('../src/main/migrate');

const ME = 'aaa', OTHER = 'bbb';
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('remoteOwner: só reunião ativa de outro PC tem dono remoto', () => {
  const m = (status, id, at = ago(1000)) => ({ status, busyBy: id ? { id, name: 'NOTE' } : undefined, busyAt: at });
  assert.equal(S.remoteOwner(m('ready', OTHER), ME), null);
  assert.equal(S.remoteOwner(m('processing', ME), ME), null);
  assert.equal(S.remoteOwner(m('processing', null), ME), null);
  const o = S.remoteOwner(m('recording', OTHER), ME);
  assert.equal(o.name, 'NOTE');
  assert.equal(o.stale, false);
  assert.equal(S.remoteOwner(m('processing', OTHER, ago(S.LEASE_MS + 1000)), ME).stale, true);
});

test('ownedHere: não recupera como "interrompida" o que está rodando no outro PC', () => {
  assert.equal(S.ownedHere({ status: 'recording', busyBy: { id: OTHER } }, ME), false);
  assert.equal(S.ownedHere({ status: 'recording', busyBy: { id: ME } }, ME), true);
  assert.equal(S.ownedHere({ status: 'recording' }, ME), true); // versão antiga, sem dono
});

test('isJunk e cópias de conflito do Drive', () => {
  for (const f of ['meta.json.tmp', 'x/desktop.ini', '~$resumo.docx', 'a.drivedownload', '.DS_Store']) assert.equal(S.isJunk(f), true, f);
  for (const f of ['meta.json', 'summary.md', '2026-10-12_012542/mix.webm']) assert.equal(S.isJunk(f), false, f);
  assert.equal(S.isConflictMeetingDir('2026-10-12_012542 (1)', F.MEETING_DIR), true);
  assert.equal(S.isConflictMeetingDir('2026-10-12_012542', F.MEETING_DIR), false);
  assert.equal(S.isConflictMeetingDir('Projeto (2)', F.MEETING_DIR), false);
});

test('mergeMeta junta marcadores/chat e mantém dúvida resolvida', () => {
  const older = { title: 'A', markers: [{ t: 10, label: 'x' }], chat: [{ at: '1', role: 'user', text: 'oi' }], doubts: [{ id: 'd1', status: 'fixed', answer: 'Tecius' }, { id: 'd2', status: 'open' }], warnings: ['w1'] };
  const newer = { title: 'B', markers: [{ t: 5, label: 'y' }, { t: 10, label: 'x' }], chat: [{ at: '1', role: 'user', text: 'oi' }, { at: '2', role: 'assistant', text: 'olá' }], doubts: [{ id: 'd1', status: 'open' }, { id: 'd2', status: 'ignored' }], warnings: ['w2'] };
  const m = S.mergeMeta(older, newer);
  assert.equal(m.title, 'B');
  assert.deepEqual(m.markers.map((x) => x.t), [5, 10]);
  assert.equal(m.chat.length, 2);
  assert.equal(m.doubts.find((d) => d.id === 'd1').status, 'fixed');
  assert.equal(m.doubts.find((d) => d.id === 'd2').status, 'ignored');
  assert.deepEqual(m.warnings, ['w1', 'w2']);
});

test('mergeFolderData soma glossário e preserva o contexto do destino', () => {
  const t = { ...F.emptyFolderData(), context: { about: 'destino', participants: [], goals: [], notes: '' }, glossary: [{ term: 'Tecius', heard: ['Técios'], uses: 2 }] };
  const s = { ...F.emptyFolderData(), context: { about: 'origem', participants: [], goals: [], notes: '' }, history: 'h', glossary: [{ term: 'tecius', heard: ['Tessius'], uses: 5 }, { term: 'PlanMat', heard: [], uses: 1 }] };
  const m = S.mergeFolderData(t, s);
  assert.equal(m.context.about, 'destino');
  assert.equal(m.history, 'h');
  assert.equal(m.glossary.length, 2);
  assert.deepEqual(m.glossary[0].heard.sort(), ['Tessius', 'Técios']);
  assert.equal(m.glossary[0].uses, 5);
});

test('findGoogleDrive e cloudKind', () => {
  const ex = (set) => (p) => set.includes(p);
  assert.equal(S.findGoogleDrive({ platform: 'win32', home: 'C:\\Users\\x', exists: ex(['G:\\Meu Drive']) }), 'G:\\Meu Drive');
  assert.equal(S.findGoogleDrive({ platform: 'win32', home: 'C:\\Users\\x', exists: ex([]) }), null);
  const mac = S.findGoogleDrive({ platform: 'darwin', home: '/Users/x', readdir: () => ['GoogleDrive-a@b.com'], exists: ex([path.join('/Users/x', 'Library', 'CloudStorage', 'GoogleDrive-a@b.com', 'My Drive')]) });
  assert.ok(mac && mac.endsWith('My Drive'));
  assert.equal(S.cloudKind('G:\\Meu Drive\\MeetRec - Reuniões'), 'Google Drive');
  assert.equal(S.cloudKind('C:\\Users\\x\\OneDrive\\MeetRec'), 'OneDrive');
  assert.equal(S.cloudKind('C:\\Users\\x\\Documents\\MeetRec - Reuniões'), null);
});

// ───────── Migração para a pasta do Drive ─────────
function mkLib(root, spec) {
  for (const [rel, files] of Object.entries(spec)) {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), typeof c === 'string' ? c : JSON.stringify(c));
  }
}

test('migrateLibrary junta as duas bibliotecas sem sobrescrever nada', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meetrec-sync-'));
  const from = path.join(tmp, 'local'), to = path.join(tmp, 'drive');
  try {
    mkLib(from, {
      '2026-10-01_100000': { 'meta.json': { title: 'local A' }, 'mix.webm': 'aaa' },
      '2026-10-02_100000': { 'meta.json': { title: 'local B (duplicada)' } },
      'Profit/2026-10-03_100000': { 'meta.json': { title: 'Profit local' }, 'summary.md': '# r' },
      'Profit/_contexto': { 'pasta.json': { glossary: [{ term: 'Tecius', heard: ['Técios'] }] } },
    });
    mkLib(to, {
      '2026-10-02_100000': { 'meta.json': { title: 'drive B' } },
      'Profit/2026-10-04_100000': { 'meta.json': { title: 'Profit drive' } },
      'Profit/_contexto': { 'pasta.json': { glossary: [{ term: 'PlanMat', heard: [] }] } },
    });
    const seen = [];
    const r = await migrateLibrary(from, to, 'move', (p) => seen.push(p));
    assert.equal(r.moved, 2);
    assert.deepEqual(r.skipped, ['2026-10-02_100000']);
    assert.deepEqual(r.mergedFolders, ['Profit']);
    assert.equal(countMeetings(to), 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(to, '2026-10-02_100000', 'meta.json'), 'utf8')).title, 'drive B');
    assert.equal(fs.readFileSync(path.join(to, '2026-10-01_100000', 'mix.webm'), 'utf8'), 'aaa');
    assert.ok(fs.existsSync(path.join(to, 'Profit', '2026-10-03_100000', 'summary.md')));
    const g = JSON.parse(fs.readFileSync(path.join(to, 'Profit', '_contexto', 'pasta.json'), 'utf8')).glossary.map((x) => x.term).sort();
    assert.deepEqual(g, ['PlanMat', 'Tecius']);
    // A duplicada ficou na pasta antiga; a pasta Profit esvaziou e saiu
    assert.ok(fs.existsSync(path.join(from, '2026-10-02_100000', 'meta.json')));
    assert.equal(fs.existsSync(path.join(from, 'Profit')), false);
    assert.deepEqual(seen.at(-1), { done: 3, total: 3 });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('migrateLibrary recusa destino dentro da pasta atual e "switch" não move nada', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meetrec-sync-'));
  try {
    mkLib(tmp, { 'a/2026-10-01_100000': { 'meta.json': {} } });
    await assert.rejects(migrateLibrary(path.join(tmp, 'a'), path.join(tmp, 'a', 'sub')));
    await assert.rejects(migrateLibrary(path.join(tmp, 'a'), path.join(tmp, 'a')));
    const r = await migrateLibrary(path.join(tmp, 'a'), path.join(tmp, 'b'), 'switch');
    assert.equal(r.moved, 0);
    assert.equal(countMeetings(path.join(tmp, 'a')), 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
