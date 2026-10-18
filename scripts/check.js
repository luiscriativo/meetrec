#!/usr/bin/env node
// Checagem rápida usada no CI: sintaxe de todo o JavaScript (CommonJS e módulos ES),
// do script Python e dos JSON do projeto.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let failed = 0;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function nodeCheck(file, asModule) {
  let target = file;
  if (asModule) {
    // node --check só trata como módulo ES arquivos .mjs
    target = path.join(os.tmpdir(), `meetrec-check-${path.basename(file, '.js')}-${process.pid}.mjs`);
    fs.copyFileSync(file, target);
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (asModule) fs.rmSync(target, { force: true });
  if (r.status !== 0) { failed++; console.error(`✗ ${path.relative(root, file)}\n${r.stderr}`); }
}

const appModules = path.join(root, 'src', 'renderer', 'app');
const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'extension')), ...walk(path.join(root, 'scripts'))]
  .filter((f) => f.endsWith('.js'));
for (const f of files) nodeCheck(f, f.startsWith(appModules));

for (const f of ['package.json', 'extension/manifest.json']) {
  try { JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch (e) { failed++; console.error(`✗ ${f}: ${e.message}`); }
}

const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'py_compile', path.join(root, 'python', 'transcribe.py')], { encoding: 'utf8', shell: process.platform === 'win32' });
if (py.error || py.status !== 0) {
  if (py.error || /not found|não é reconhecido/i.test(py.stderr)) console.warn('! Python não encontrado — pulando python/transcribe.py');
  else { failed++; console.error(`✗ python/transcribe.py\n${py.stderr}`); }
}

if (failed) { console.error(`\n${failed} arquivo(s) com erro.`); process.exit(1); }
console.log(`✓ ${files.length} arquivos JavaScript, JSON e Python sem erros de sintaxe.`);
