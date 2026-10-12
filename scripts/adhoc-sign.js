#!/usr/bin/env node
/**
 * afterSign do electron-builder (macOS): assinatura ad-hoc do app inteiro.
 *
 * Sem certificado da Apple, o electron-builder pula a assinatura e o pacote fica
 * só com a assinatura parcial do binário do Electron. Baixado da internet num Mac
 * Apple Silicon, isso aparece como "MeetRec está danificado e não pode ser aberto".
 * Com a assinatura ad-hoc do pacote todo, o macOS mostra o aviso comum de
 * desenvolvedor não identificado (abrir com clique direito → Abrir).
 *
 * Só age quando não há assinatura de verdade: com um certificado Developer ID
 * configurado (CSC_LINK / keychain), o app já sai assinado e este passo não faz nada.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // codesign escreve os detalhes no stderr; com certificado aparece um TeamIdentifier
  const r = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
  const info = `${r.stdout || ''}${r.stderr || ''}`;
  if (/TeamIdentifier=(?!not set)/.test(info)) return;

  console.log(`  • ad-hoc signing  app=${path.relative(process.cwd(), appPath)}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
