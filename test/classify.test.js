const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/main/folders');

// Dados fictícios: pasta "Atlas" (reunião semanal externa) e pasta "Tecius" (app)
const atlas = {
  name: 'Atlas',
  description: 'Implantação do projeto Atlas',
  context: { about: '', participants: [{ name: 'Ana Souza', role: '' }, { name: 'Carlos Lima', role: '' }], goals: [], notes: '' },
  glossary: [{ term: 'Orion' }, { term: 'Cronograma' }],
  titles: ['ATLAS SEMANAL (EXTERNO): revisão do cronograma'],
  people: ['Ana Souza', 'Carlos Lima', 'Mariana Alves'],
};
const tecius = {
  name: 'Tecius',
  description: 'App de finanças',
  context: null,
  glossary: [{ term: 'Tecius' }],
  titles: ['Daily Tecius'],
  people: ['Bruno Costa'],
};

test('reunião recorrente com o nome da pasta no título vai sozinha para a pasta', () => {
  const r = F.scoreFolders({ title: 'ATLAS SEMANAL (EXTERNO): CRONOGRAMA E RISCOS', participants: ['Ana Souza', 'Luis Melo'], owner: 'Luis Melo', text: 'vamos abrir o orion' }, [atlas, tecius]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.best.name, 'Atlas');
  assert.ok(r.best.reasons.length >= 2);
});

test('sem sinais claros a reunião fica sem pasta', () => {
  const r = F.scoreFolders({ title: 'Reunião 30/10/2026 14:00', participants: ['Pedro Souza'], text: 'falamos sobre férias' }, [atlas, tecius]);
  assert.equal(r.decision, 'none');
  assert.equal(r.best, null);
});

test('sinal fraco vira sugestão, não decisão', () => {
  // só duas pessoas em comum, sem título: sugere mas não move
  const r = F.scoreFolders({ title: '', participants: ['Ana Souza', 'Carlos Lima', 'Fulano', 'Beltrano', 'Ciclano'], text: '' }, [atlas, tecius]);
  assert.equal(r.decision, 'suggest');
  assert.equal(r.best.name, 'Atlas');
});

test('empate entre pastas não decide sozinho', () => {
  const a = { ...atlas, name: 'Atlas A', titles: ['Semanal Atlas cronograma'] };
  const b = { ...atlas, name: 'Atlas B', titles: ['Semanal Atlas cronograma'] };
  const r = F.scoreFolders({ title: 'Semanal Atlas cronograma', participants: [] }, [a, b]);
  assert.notEqual(r.decision, 'auto');
});

test('o próprio usuário e "Participante" não contam como pessoa em comum', () => {
  const f = { ...tecius, people: ['Luis Melo', 'Participante'] };
  const r = F.scoreFolders({ title: '', participants: ['Luis Melo', 'Participante'], owner: 'Luis Melo' }, [f]);
  assert.equal(r.decision, 'none');
});

test('nomes parecidos contam: primeiro e último nome, ou só o primeiro', () => {
  const r = F.scoreFolders({ title: '', participants: ['Ana S. Souza', 'Carlos'] }, [atlas]);
  assert.ok(r.ranking[0].reasons.some((x) => /2 participantes/.test(x)));
});
