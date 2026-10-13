const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/main/folders');

test('sanitizeFolderName limpa e valida nomes', () => {
  assert.deepEqual(F.sanitizeFolderName('  Cliente  Tecius  '), { name: 'Cliente Tecius' });
  assert.deepEqual(F.sanitizeFolderName('Projeto: A/B?'), { name: 'Projeto A B' });
  assert.equal(F.sanitizeFolderName('Fim.').name, 'Fim');
  assert.ok(F.sanitizeFolderName('').error);
  assert.ok(F.sanitizeFolderName('_contexto').error);
  assert.ok(F.sanitizeFolderName('.oculta').error);
  assert.ok(F.sanitizeFolderName('CON').error);
  assert.ok(F.sanitizeFolderName('2026-10-13_093000').error);
  assert.ok(F.sanitizeFolderName('x'.repeat(61)).error);
});

test('normalizeContext aceita o formato do Claude em português', () => {
  const c = F.normalizeContext({ resumo: 'Rebranding', participantes: [{ nome: 'Ana', papel: 'PM' }, 'Bruno', { nome: '' }], objetivos: ['Lançar site'], observacoes: 'x' });
  assert.deepEqual(c, { about: 'Rebranding', participants: [{ name: 'Ana', role: 'PM' }, { name: 'Bruno', role: '' }], goals: ['Lançar site'], notes: 'x' });
  assert.equal(F.contextIsEmpty(F.normalizeContext({})), true);
  assert.equal(F.contextIsEmpty(c), false);
});

test('addGlossaryTerm agrupa variantes e não duplica', () => {
  let g = [];
  g = F.addGlossaryTerm(g, { term: 'Tecius', heard: 'Técios' });
  g = F.addGlossaryTerm(g, { term: 'tecius', heard: 'Tessius' });
  g = F.addGlossaryTerm(g, { term: 'Tecius', heard: 'técios' });
  g = F.addGlossaryTerm(g, { term: 'Tecius', heard: 'Tecios' });
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].heard, ['Técios', 'Tessius', 'Tecios']);
  assert.equal(g[0].uses, 4);
  g = F.addGlossaryTerm(g, { term: 'Kanban', heard: 'Kanban' });
  assert.deepEqual(g[1].heard, []);
});

test('addGlossaryTerm remove "ouvido como" que virou termo correto', () => {
  let g = F.addGlossaryTerm([], { term: 'Ana', heard: 'Hana' });
  g = F.addGlossaryTerm(g, { term: 'Hana', heard: '' });
  assert.deepEqual(g.find((x) => x.term === 'Ana').heard, []);
});

test('replaceWord respeita limites de palavra e acentos', () => {
  assert.deepEqual(F.replaceWord('Falei com o Técios e a Técios.', 'Técios', 'Tecius'), { text: 'Falei com o Tecius e a Tecius.', count: 2 });
  assert.equal(F.replaceWord('Técioss não muda', 'Técios', 'Tecius').count, 0);
  assert.equal(F.replaceWord('ação', 'aç', 'X').count, 0);
  assert.equal(F.replaceWord('PREÇO 15', 'preço', 'Preço').text, 'Preço 15');
  assert.equal(F.replaceWord('a (c++) b', 'c++', 'C++').text, 'a (C++) b');
});

test('correctionPairs + applyCorrections aplicam correções da reunião e do glossário', () => {
  const glossary = [{ term: 'Tecius', heard: ['Técios', 'Tecios'] }, { term: 'Kanban', heard: [] }];
  const corrections = [{ heard: 'Sprint Review', answer: 'Sprint Review' }, { heard: 'jira', answer: 'Jira' }];
  const pairs = F.correctionPairs(glossary, corrections);
  assert.deepEqual(pairs.map((p) => p.from), ['Técios', 'Tecios', 'jira']);
  assert.equal(F.correctionPairs([{ term: 'A', heard: ['x'] }], [{ heard: 'X', answer: 'B' }]).length, 1); // a correção da reunião tem prioridade
  const segs = [{ start: 0, text: 'O Técios usa jira.' }, { start: 2, text: 'Nada aqui' }];
  const r = F.applyCorrections(segs, pairs);
  assert.equal(r.count, 2);
  assert.equal(r.segments[0].text, 'O Tecius usa Jira.');
  assert.equal(r.segments[1], segs[1]); // trecho sem mudança mantém o mesmo objeto
});

test('buildVocabulary junta vocabulário, glossário e participantes sem estourar o limite', () => {
  const v = F.buildVocabulary('MeetRec, Claude', [[{ term: 'Tecius', uses: 1 }, { term: 'Kanban', uses: 5 }], [{ term: 'claude', uses: 9 }]], { participants: [{ name: 'Ana' }] });
  assert.equal(v, 'MeetRec, Claude, Kanban, Tecius, Ana');
  const long = F.buildVocabulary('', [Array.from({ length: 200 }, (_, i) => ({ term: `Termo${i}` }))], null, 50);
  assert.ok(long.length <= 50);
});

test('splitSummary separa o resumo do bloco meetrec', () => {
  const text = '📋 REUNIÃO\n• ponto\n\n```meetrec\n{"duvidas":[{"tipo":"termo","tempo":"12:40","ouvido":"Técios","sugestao":"Tecius","pergunta":"É Tecius?"}],"historico":"- decidido X"}\n```\n';
  const r = F.splitSummary(text);
  assert.equal(r.summary, '📋 REUNIÃO\n• ponto');
  assert.equal(r.data.historico, '- decidido X');
  assert.equal(r.error, null);
  assert.deepEqual(F.splitSummary('só texto'), { summary: 'só texto', data: null, error: null });
  const broken = F.splitSummary('📋 A\n```meetrec\n{"duvidas": [');
  assert.equal(broken.summary, '📋 A');
  assert.equal(broken.data, null);
  assert.ok(broken.error);
  const noClose = F.splitSummary('📋 A\n```meetrec\n{"historico":"ok"}');
  assert.equal(noClose.data.historico, 'ok');
});

test('visiblePart esconde o bloco durante o streaming', () => {
  assert.equal(F.visiblePart('📋 A\n• b\n```meetrec\n{"du'), '📋 A\n• b');
  assert.equal(F.visiblePart('📋 A\n• b\n``'), '📋 A\n• b');
  assert.equal(F.visiblePart('📋 A\n• b\n```me'), '📋 A\n• b');
  assert.equal(F.visiblePart('📋 A'), '📋 A');
});

test('normalizeDoubts valida tipos, tempos e limite', () => {
  const d = F.normalizeDoubts([
    { tipo: 'termo', tempo: '12:40', ouvido: 'Técios', sugestao: 'Tecius', pergunta: 'É Tecius?' },
    { tipo: 'NÚMERO', tempo: '1:02:03', pergunta: '15 ou 50 mil?' },
    { tipo: 'outro', ouvido: 'xpto' },
    { tipo: 'termo' },
    null,
  ]);
  assert.equal(d.length, 3);
  assert.equal(d[0].t, 760);
  assert.equal(d[0].status, 'open');
  assert.equal(d[1].kind, 'numero');
  assert.equal(d[1].t, 3723);
  assert.equal(d[2].kind, 'trecho');
  assert.equal(d[2].question, '"xpto" está certo?');
  assert.notEqual(d[0].id, d[1].id);
  assert.equal(F.normalizeDoubts(Array.from({ length: 30 }, () => ({ pergunta: 'p' }))).length, 10);
  assert.deepEqual(F.normalizeDoubts('x'), []);
});

test('normalizeFolderData tolera arquivo antigo ou corrompido', () => {
  const d = F.normalizeFolderData({ description: 'x', glossary: [{ term: 'A', heard: ['a', 'a', ''] }, { heard: ['b'] }] });
  assert.equal(d.description, 'x');
  assert.equal(d.glossary.length, 1);
  assert.deepEqual(d.glossary[0].heard, ['a']);
  assert.equal(d.context, null);
  assert.equal(F.normalizeFolderData(null).history, '');
});

test('arquivos .md legíveis', () => {
  const d = { description: 'Cliente', context: { about: 'Site', participants: [{ name: 'Ana', role: 'PM' }], goals: ['Lançar'], notes: '' }, glossary: [{ term: 'Tecius', heard: ['Técios'] }], history: '- X' };
  assert.match(F.renderContextMd('P', d), /Ana — PM/);
  assert.match(F.renderGlossaryMd('P', d), /Tecius \(a transcrição costuma escrever: Técios\)/);
  assert.match(F.renderHistoryMd('P', d), /- X/);
  assert.match(F.renderContextMd('P', { description: '', context: null }), /Ainda sem contexto/);
});
