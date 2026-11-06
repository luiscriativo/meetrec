// Atalho do app no Menu Iniciar do Windows — é dele que a barra de tarefas tira o ícone.
//
// Na primeira notificação, o Electron grava %AppData%\Microsoft\Windows\Start Menu\Programs\
// <nome do app>.lnk para o Windows aceitar as notificações do app. Ele cria esse atalho do
// zero e NÃO define o ícone; e o Windows prefere esse atalho (do usuário) ao do instalador
// (em ProgramData). Depois de uma atualização trocar o .exe, o ícone da barra virava uma
// folha em branco. O desinstalador padrão também não conhece esse atalho, que ficava órfão.
//
// O Electron só deixa o atalho em paz se alvo, pasta, AppUserModelId e ToastActivatorCLSID
// baterem com os dele. Então o app grava o atalho antes, já com ícone e com um CLSID fixo
// (app.setToastActivatorCLSID), e confere de novo depois de cada notificação.
'use strict';

const path = require('path');

let identity = null;

/**
 * Identidade do app no Windows (barra de tarefas e notificações). Chamar antes do app.whenReady().
 * A versão de desenvolvimento (electron.exe) usa outra identidade, senão o Windows mostra o
 * ícone do Electron no lugar do app.
 * @param {{ appUserModelId: string, toastActivatorClsid: string }} id
 */
function windowsIdentity({ appUserModelId, toastActivatorClsid }) {
  if (process.platform !== 'win32') return;
  const { app } = require('electron');
  app.setAppUserModelId(app.isPackaged ? appUserModelId : `${appUserModelId}.dev`);
  if (!app.isPackaged) return;
  if (typeof app.setToastActivatorCLSID === 'function') app.setToastActivatorCLSID(toastActivatorClsid);
  identity = { appUserModelId, toastActivatorClsid };
}

/** Caminho do atalho que o Electron usa: <AppData>\Microsoft\Windows\Start Menu\Programs\<nome>.lnk */
function shortcutPath(appDataDir, appName) {
  return path.join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${appName}.lnk`);
}

/** O atalho como deve ficar: o que o Electron confere + o ícone (o próprio .exe). */
function wantedShortcut({ exe, appName, appUserModelId, toastActivatorClsid }) {
  return { target: exe, cwd: path.dirname(exe), description: appName, icon: exe, iconIndex: 0, appUserModelId, toastActivatorClsid };
}

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** true se o atalho atual (shell.readShortcutLink) já é exatamente o que queremos. */
function shortcutUpToDate(current, wanted) {
  if (!current) return false;
  return same(current.target, wanted.target) && same(current.cwd, wanted.cwd)
    && same(current.icon, wanted.icon) && Number(current.iconIndex || 0) === wanted.iconIndex
    && current.appUserModelId === wanted.appUserModelId
    && same(current.toastActivatorClsid, wanted.toastActivatorClsid);
}

/**
 * Garante o atalho; só grava quando algo difere. `io` = { exists, read, write } (testável sem o Electron).
 * @returns {boolean} true se gravou
 */
function ensureShortcut(io, lnk, wanted) {
  let current = null;
  try { if (io.exists(lnk)) current = io.read(lnk); } catch { current = null; }
  if (shortcutUpToDate(current, wanted)) return false;
  io.write(lnk, wanted);
  return true;
}

/** Garante o atalho do app instalado (só no Windows, só com windowsIdentity() chamado). */
function ensureStartMenuShortcut() {
  if (!identity) return false;
  const { app, shell } = require('electron');
  const fs = require('fs');
  const lnk = shortcutPath(app.getPath('appData'), app.name);
  const wanted = wantedShortcut({ exe: process.execPath, appName: app.name, ...identity });
  try {
    return ensureShortcut({
      exists: (p) => fs.existsSync(p),
      read: (p) => shell.readShortcutLink(p),
      write: (p, w) => { if (!shell.writeShortcutLink(p, 'create', w)) throw new Error('writeShortcutLink falhou'); },
    }, lnk, wanted);
  } catch {
    return false;
  }
}

module.exports = { windowsIdentity, shortcutPath, wantedShortcut, shortcutUpToDate, ensureShortcut, ensureStartMenuShortcut };
