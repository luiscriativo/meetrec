'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { shortcutPath, wantedShortcut, shortcutUpToDate, ensureShortcut } = require('../src/main/win-shortcut');

const exe = 'C:\\Program Files\\MeetRec\\MeetRec.exe';
const id = { appUserModelId: 'io.github.luiscriativo.meetrec', toastActivatorClsid: '{C201D095-2F7C-479E-ADA2-CE4B9F047AF3}' };
const wanted = wantedShortcut({ exe, appName: 'MeetRec', ...id });

test('atalho fica no Menu Iniciar do usuário, com o nome do app', () => {
  assert.equal(shortcutPath('C:\\Users\\x\\AppData\\Roaming', 'MeetRec'),
    path.join('C:\\Users\\x\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'MeetRec.lnk'));
});

test('atalho desejado: o que o Electron confere mais o ícone do próprio .exe', () => {
  assert.deepEqual(wanted, {
    target: exe, cwd: 'C:\\Program Files\\MeetRec', description: 'MeetRec',
    icon: exe, iconIndex: 0, ...id,
  });
});

test('atalho igual (mesmo com maiúsculas diferentes nos caminhos) não precisa ser regravado', () => {
  assert.equal(shortcutUpToDate({ ...wanted }, wanted), true);
  assert.equal(shortcutUpToDate({ ...wanted, target: exe.toUpperCase(), icon: exe.toLowerCase(), toastActivatorClsid: id.toastActivatorClsid.toLowerCase() }, wanted), true);
});

test('atalho que o Electron criou (sem ícone) ou de outra instalação precisa ser regravado', () => {
  assert.equal(shortcutUpToDate(null, wanted), false);
  assert.equal(shortcutUpToDate({ ...wanted, icon: undefined, iconIndex: undefined }, wanted), false);
  assert.equal(shortcutUpToDate({ ...wanted, toastActivatorClsid: undefined }, wanted), false);
  assert.equal(shortcutUpToDate({ ...wanted, target: 'C:\\Users\\x\\AppData\\Local\\Programs\\MeetRec\\MeetRec.exe' }, wanted), false);
  assert.equal(shortcutUpToDate({ ...wanted, appUserModelId: 'io.github.luiscriativo.meetrec.dev' }, wanted), false);
});

test('ensureShortcut só grava quando falta ou difere, e tolera atalho ilegível', () => {
  const writes = [];
  const io = (current, { readThrows } = {}) => ({
    exists: () => current !== null,
    read: () => { if (readThrows) throw new Error('corrompido'); return current; },
    write: (p, w) => writes.push([p, w]),
  });
  assert.equal(ensureShortcut(io({ ...wanted }), 'x.lnk', wanted), false);
  assert.equal(writes.length, 0);
  assert.equal(ensureShortcut(io(null), 'x.lnk', wanted), true);
  assert.equal(ensureShortcut(io({ ...wanted, icon: undefined }), 'x.lnk', wanted), true);
  assert.equal(ensureShortcut(io({}, { readThrows: true }), 'x.lnk', wanted), true);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0], ['x.lnk', wanted]);
});
