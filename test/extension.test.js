const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncExtension } = require('../src/main/extension');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'meetrec-ext-')); }
function write(dir, rel, txt) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); }

test('syncExtension copia, atualiza só o que mudou e remove arquivos antigos', () => {
  const src = tmp(), base = tmp();
  const dest = path.join(base, 'MeetRec - Extensão do navegador');
  write(src, 'manifest.json', JSON.stringify({ version: '1.0.2' }));
  write(src, 'background.js', 'v1');
  write(src, 'icons/16.png', 'png');

  let r = syncExtension(src, dest);
  assert.equal(r.dir, dest);
  assert.equal(r.version, '1.0.2');
  assert.equal(r.changed, 3);
  assert.equal(fs.readFileSync(path.join(dest, 'icons/16.png'), 'utf8'), 'png');
  assert.match(fs.readFileSync(path.join(dest, 'LEIA-ME.txt'), 'utf8'), /versão 1\.0\.2/);

  // Nada mudou: não reescreve
  assert.equal(syncExtension(src, dest).changed, 0);

  // Nova versão do app: arquivo alterado + arquivo removido
  write(src, 'background.js', 'v2');
  write(dest, 'velho.js', 'x');
  r = syncExtension(src, dest);
  assert.equal(r.changed, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'background.js'), 'utf8'), 'v2');
  assert.equal(fs.existsSync(path.join(dest, 'velho.js')), false);
  assert.equal(fs.existsSync(path.join(dest, 'LEIA-ME.txt')), true); // o LEIA-ME fica

  // Pasta apagada pelo usuário: recria
  fs.rmSync(dest, { recursive: true });
  assert.equal(syncExtension(src, dest).changed, 3);
});

test('syncExtension devolve a pasta original quando não consegue copiar', () => {
  const src = tmp();
  const r = syncExtension(src, path.join(tmp(), 'x'));
  assert.equal(r.dir, src);
  assert.ok(r.error);
});
