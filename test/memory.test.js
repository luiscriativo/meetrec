const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/main/folders');

test('relevantGlossary manda os termos da reunião + os mais usados', () => {
  const g = [
    { term: 'Tecius', heard: ['Técios'], uses: 1 },
    { term: 'Kanban', heard: [], uses: 9 },
    { term: 'Jira', heard: [], uses: 1 },
    ...Array.from({ length: 40 }, (_, i) => ({ term: `Velho${i}`, heard: [], uses: 1 })),
  ];
  const r = F.relevantGlossary(g, 'Falamos com a técios sobre o jira', { top: 3 });
  assert.deepEqual(r.map((x) => x.term), ['Tecius', 'Jira', 'Kanban']);
  // presentes nunca são cortados, mesmo passando do "top"
  const many = F.relevantGlossary(g, 'Velho1 Velho2 Velho3 Velho4', { top: 2 });
  assert.equal(many.length, 4);
  assert.deepEqual(F.relevantGlossary([], 'x'), []);
});

test('capHistory corta numa quebra de linha e devolve o que sobrou (vai para o arquivo)', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `• Pendência número ${i} com algum texto`);
  const r = F.capHistory(lines.join('\n'), 500);
  assert.equal(r.cut, true);
  assert.ok(r.text.length <= 500);
  const kept = r.text.split('\n');
  assert.ok(kept.every((l) => l.startsWith('• Pendência')));
  // nada se perde: o que ficou + o que saiu = tudo
  assert.equal(kept.length + r.dropped.length, 200);
  assert.equal(r.dropped[0], lines[kept.length]);
  assert.deepEqual(F.capHistory('  curto  '), { text: 'curto', cut: false, dropped: [] });
});

test('addToArchive guarda o que saiu com motivo e limite de tamanho', () => {
  const a = F.addToArchive([], ['• Pendência A', '', 'Decisão B'], 'resolvido');
  assert.deepEqual(a.map((x) => x.text), ['Pendência A', 'Decisão B']);
  assert.equal(a[0].why, 'resolvido');
  const big = F.addToArchive([], Array.from({ length: 400 }, (_, i) => `item ${i}`), 'x');
  assert.equal(big.length, 300);
  assert.equal(big[big.length - 1].text, 'item 399');
  assert.equal(F.normalizeFolderData({ archive: [{ text: 'a' }, null, { foo: 1 }] }).archive.length, 1);
});

test('folderSize indica quando a memória deve ser enxugada sozinha', () => {
  assert.equal(F.folderSize({ history: '• a', context: null }).level, 'ok');
  const stale = Array.from({ length: 3 }, (_, i) => `• P${i} (últ. menção 01/09) (antiga)`).join('\n');
  assert.equal(F.folderSize({ history: stale }).stale, 3);
  assert.equal(F.needsSlim({ history: stale }), true);
  assert.equal(F.needsSlim({ history: 'x'.repeat(F.SLIM_AT + 1) }), true);
  assert.equal(F.needsSlim({ history: 'x'.repeat(F.SLIM_AT - 1) }), false);
  const people = Array.from({ length: F.PEOPLE_MAX + 1 }, (_, i) => ({ name: `P${i}`, role: '' }));
  assert.equal(F.needsSlim({ context: { about: '', participants: people, goals: [], notes: '' } }), true);
  assert.equal(F.folderSize({ glossary: [{ term: 'a' }] }).glossary, 1);
  assert.equal(F.folderSize(null).level, 'ok');
});

test('normalizeFolderData preserva e valida a proposta de enxugar', () => {
  const d = F.normalizeFolderData({ slim: { history: 'novo', context: { resumo: 'x' }, removed: ['a'] } });
  assert.equal(d.slim.history, 'novo');
  assert.equal(d.slim.context.about, 'x');
  assert.equal(F.normalizeFolderData({ slim: { foo: 1 } }).slim, null);
  assert.equal(F.emptyFolderData().slim, null);
});
