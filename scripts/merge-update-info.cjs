#!/usr/bin/env node
/**
 * Junta o resultado dos builds de cada máquina do CI numa pasta de release.
 *
 * Cada arquitetura é gerada numa máquina própria (o ffmpeg embutido é baixado
 * para a arquitetura de quem faz o build), e cada uma escreve o seu
 * latest.yml / latest-mac.yml listando só os próprios arquivos. O auto-update
 * lê um arquivo por sistema, então eles precisam ser combinados:
 *   - `files` = arquivos de todas as arquiteturas (o electron-updater escolhe
 *     pelo nome: "arm64" / "x64");
 *   - o x64 vem primeiro, e `path`/`sha512` (formato antigo) apontam para ele:
 *     é o que um updater antigo, que não olha a arquitetura, vai baixar.
 * Os demais arquivos (instaladores, .zip, .blockmap) são copiados como estão.
 *
 * Uso: node scripts/merge-update-info.cjs <pasta-dos-builds> <pasta-de-saída>
 * Precisa do js-yaml (dependência do electron-builder; no CI é instalado à parte).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const [inDir, outDir] = process.argv.slice(2);
if (!inDir || !outDir) {
  console.error('Uso: node scripts/merge-update-info.cjs <pasta-dos-builds> <pasta-de-saída>');
  process.exit(1);
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const isUpdateInfo = (name) => /^latest.*\.yml$/.test(name);
const isArm64 = (url) => /arm64/i.test(url);

fs.mkdirSync(outDir, { recursive: true });
const all = walk(inDir);

// Instaladores e afins: copiados; o mesmo nome com conteúdo diferente é erro
const copied = new Map();
for (const file of all.filter((f) => !isUpdateInfo(path.basename(f)))) {
  const name = path.basename(file);
  if (name === 'builder-debug.yml' || name === 'builder-effective-config.yaml') continue;
  const h = hash(file);
  if (copied.has(name)) {
    if (copied.get(name) !== h) throw new Error(`Dois arquivos diferentes com o mesmo nome: ${name}`);
    continue;
  }
  copied.set(name, h);
  fs.copyFileSync(file, path.join(outDir, name));
}

// latest*.yml: um por sistema, com os arquivos de todas as arquiteturas
const groups = new Map();
for (const file of all.filter((f) => isUpdateInfo(path.basename(f)))) {
  const name = path.basename(file);
  groups.set(name, [...(groups.get(name) || []), yaml.load(fs.readFileSync(file, 'utf8'))]);
}
for (const [name, docs] of groups) {
  const versions = [...new Set(docs.map((d) => d.version))];
  if (versions.length !== 1) throw new Error(`${name}: versões diferentes entre os builds (${versions.join(', ')})`);
  const byUrl = new Map();
  for (const d of docs) for (const f of d.files || []) byUrl.set(f.url, f);
  const files = [...byUrl.values()].sort((a, b) => Number(isArm64(a.url)) - Number(isArm64(b.url)));
  const missing = files.filter((f) => !copied.has(f.url));
  if (missing.length) throw new Error(`${name}: arquivos listados mas não encontrados: ${missing.map((f) => f.url).join(', ')}`);
  const merged = {
    ...docs[0],
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: docs.map((d) => d.releaseDate).filter(Boolean).sort().pop(),
  };
  fs.writeFileSync(path.join(outDir, name), yaml.dump(merged, { lineWidth: -1 }));
  console.log(`${name}: ${files.map((f) => f.url).join(', ')}`);
}

console.log(`${copied.size} arquivos + ${groups.size} arquivo(s) de atualização em ${outDir}`);
