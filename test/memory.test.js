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

test('capHistory corta numa quebra de linha e avisa', () => {
  const h = Array.from({ length: 200 }, (_, i) => `• Pendência número ${i} com algum texto`).join('\n');
  const r = F.capHistory(h, 500);
  assert.equal(r.cut, true);
  assert.ok(r.text.length <= 500);
  assert.match(r.text, /Enxugar com o Claude/);
  assert.ok(r.text.split('\n').slice(0, -1).every((l) => l.startsWith('• Pendência')));
  assert.deepEqual(F.capHistory('  curto  '), { text: 'curto', cut: false });
});

test('folderSize mede a memória e indica quando enxugar', () => {
  assert.equal(F.folderSize({ history: '• a', context: null }).level, 'ok');
  const stale = Array.from({ length: 3 }, (_, i) => `• P${i} (últ. menção 01/09) (antiga)`).join('\n');
  const s = F.folderSize({ history: stale });
  assert.equal(s.stale, 3);
  assert.equal(s.level, 'warn');
  assert.equal(F.folderSize({ history: 'x'.repeat(F.HISTORY_MAX) }).level, 'big');
  assert.equal(F.folderSize({ history: 'x'.repeat(Math.round(F.HISTORY_MAX * 0.8)) }).level, 'warn');
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
