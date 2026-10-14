const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Se a identidade do app no Windows for diferente do appId do instalador, a barra de tarefas
// não liga a janela ao atalho do MeetRec e mostra outro ícone (ex.: o do Electron)
test('AppUserModelID do app é igual ao appId do electron-builder', () => {
  const appId = read('electron-builder.yml').match(/^appId:\s*(\S+)/m)?.[1];
  const main = read('src/main/main.js');
  const m = main.match(/setAppUserModelId\(app\.isPackaged \? '([^']+)'/);
  assert.ok(appId, 'appId não encontrado no electron-builder.yml');
  assert.ok(m, 'setAppUserModelId(app.isPackaged ? ...) não encontrado no main.js');
  assert.equal(m[1], appId);
});

test('ícone do Windows existe e é grande o bastante para o instalador', () => {
  const icon = read('electron-builder.yml').match(/^win:[\s\S]*?^\s+icon:\s*(\S+)/m)?.[1];
  assert.ok(icon);
  const buf = fs.readFileSync(path.join(root, icon));
  // PNG: largura e altura nos bytes 16–23
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  assert.ok(buf.readUInt32BE(16) >= 256 && buf.readUInt32BE(20) >= 256, 'o electron-builder exige pelo menos 256×256');
});
