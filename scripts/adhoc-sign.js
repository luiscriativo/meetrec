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
const fs = require('fs');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // codesign escreve os detalhes no stderr; com certificado aparece um TeamIdentifier
  const r = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
  const info = `${r.stdout || ''}${r.stderr || ''}`;
  if (/TeamIdentifier=(?!not set)/.test(info)) return;

  // O motor de transcrição (whisper.cpp) fica em Resources/, onde o --deep não entra: sem assinatura
  // o Mac Apple Silicon se recusa a executá-lo. Assina cada binário antes do pacote.
  const whisperDir = path.join(appPath, 'Contents', 'Resources', 'whisper');
  if (fs.existsSync(whisperDir)) {
    for (const f of fs.readdirSync(whisperDir)) {
      if (f === 'whisper-cli' || f.endsWith('.dylib')) execFileSync('codesign', ['--force', '--sign', '-', path.join(whisperDir, f)], { stdio: 'inherit' });
    }
  }

  console.log(`  • ad-hoc signing  app=${path.relative(process.cwd(), appPath)}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
