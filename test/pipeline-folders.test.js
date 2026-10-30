// Pipeline × pastas, sem IA: escolha automática da pasta antes do resumo, arquivo do que sai
// do histórico e agendamento da limpeza automática da memória.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/main/folders');
const { Pipeline, blockRules } = require('../src/main/pipeline');

function fakeAtlasry({ meetings, folders, transcripts = {} }) {
  const metas = new Map(meetings.map((m) => [m.id, { ...m }]));
  const fdata = new Map(Object.entries(folders).map(([n, d]) => [n, F.normalizeFolderData(d)]));
  return {
    moved: [],
    get: (id) => metas.get(id) || null,
    list: () => [...metas.values()],
    listFolders: () => [...fdata.keys()].map((name) => ({ name })),
    getFolder: (n) => fdata.get(n || '') || null,
    readJson: (id, f) => (f === 'transcript.json' ? transcripts[id] || null : null),
    async move(id, folder) { if (this.failMove) throw new Error('EBUSY'); metas.get(id).folder = folder; this.moved.push([id, folder]); return metas.get(id); },
    update(id, patch) { const m = metas.get(id); Object.assign(m, typeof patch === 'function' ? patch(m) : patch); return m; },
    updateFolder(n, patch) { const cur = fdata.get(n); const next = typeof patch === 'function' ? patch({ ...cur }) : { ...cur, ...patch }; fdata.set(n, F.normalizeFolderData(next)); return next; },
  };
}
const store = { get: (k) => (k ? { userName: 'Luis Melo' }[k] : { userName: 'Luis Melo' }) };

const ATLAS = { description: 'Projeto Atlas', history: '', glossary: [{ term: 'Orion' }] };
const pastAtlas = { id: 'old1', folder: 'Atlas', title: 'x', titleAuto: true, meetingTitle: 'ATLAS SEMANAL (EXTERNO)', participants: ['Ana Souza', 'Carlos Lima'] };

test('reunião recorrente sem pasta vai sozinha para a pasta certa antes do resumo', async () => {
  const lib = fakeAtlasry({ meetings: [pastAtlas, { id: 'new', folder: '', meetingTitle: 'ATLAS SEMANAL (EXTERNO): CRONOGRAMA', participants: ['Ana Souza'], titleAuto: true }], folders: { '': {}, Atlas: ATLAS, Tecius: {} } });
  const p = new Pipeline(lib, store);
  const events = [];
  p.on('folder-auto', (e) => events.push(e));
  assert.equal(await p._autoFolder('new'), 'Atlas');
  assert.deepEqual(lib.moved, [['new', 'Atlas']]);
  assert.equal(lib.get('new').folderPick, 'auto');
  assert.equal(events[0].name, 'Atlas');
});

test('sem certeza: fica sem pasta (com sugestão quando há algum sinal)', async () => {
  const lib = fakeAtlasry({ meetings: [pastAtlas, { id: 'new', folder: '', titleAuto: true, participants: ['Ana Souza', 'Carlos Lima', 'Fulano', 'Beltrano'] }, { id: 'none', folder: '', titleAuto: true, participants: [] }], folders: { '': {}, Atlas: ATLAS } });
  const p = new Pipeline(lib, store);
  assert.equal(await p._autoFolder('new'), null);
  assert.equal(lib.get('new').folderSuggestion.name, 'Atlas');
  assert.equal(await p._autoFolder('none'), null);
  assert.equal(lib.get('none').folderSuggestion, undefined);
  assert.deepEqual(lib.moved, []);
});

test('escolha do usuário é respeitada e arquivo em uso vira só sugestão', async () => {
  const lib = fakeAtlasry({ meetings: [pastAtlas, { id: 'mine', folder: '', folderPick: 'user', meetingTitle: 'ATLAS SEMANAL' }, { id: 'busy', folder: '', meetingTitle: 'ATLAS SEMANAL', participants: ['Ana Souza'] }], folders: { '': {}, Atlas: ATLAS } });
  const p = new Pipeline(lib, store);
  assert.equal(await p._autoFolder('mine'), null);
  lib.failMove = true;
  assert.equal(await p._autoFolder('busy'), null);
  assert.equal(lib.get('busy').folderSuggestion.name, 'Atlas');
});

test('o que sai do histórico vai para o arquivo e memória grande agenda a limpeza', () => {
  const lib = fakeAtlasry({ meetings: [], folders: { '': {}, Atlas: ATLAS } });
  const p = new Pipeline(lib, store);
  p._next = () => {}; // não roda a fila (sem IA no teste)
  const big = Array.from({ length: 80 }, (_, i) => `• Pendência ${i} com um texto razoavelmente comprido (últ. menção 01/10)`).join('\n');
  p._applyFolderBlock('Atlas', { historico: big, arquivar: ['• Decisão antiga'] }, { id: 'm1', title: 'Semanal' });
  const d = lib.getFolder('Atlas');
  assert.ok(d.history.length <= F.HISTORY_MAX);
  assert.equal(d.archive[0].text, 'Decisão antiga');
  assert.ok(d.archive.some((a) => a.why === 'cortado por tamanho'));
  assert.deepEqual(p.queue, [{ slim: 'Atlas' }]);
  // não agenda duas vezes
  p._applyFolderBlock('Atlas', { historico: big }, { id: 'm2', title: 'Semanal' });
  assert.equal(p.queue.length, 1);
  assert.deepEqual(p.status().queued, []);
});

test('o prompt pede a pasta só quando a reunião está sem pasta', () => {
  const none = blockRules({ name: '', data: null }, [{ name: 'Atlas', about: 'Implantação' }]);
  assert.match(none, /"pasta"/);
  assert.match(none, /- Atlas — Implantação/);
  const inFolder = blockRules({ name: 'Atlas', data: F.emptyFolderData() }, []);
  assert.doesNotMatch(inFolder, /"pasta"/);
  assert.match(inFolder, /"arquivar"/);
});
