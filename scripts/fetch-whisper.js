#!/usr/bin/env node
/**
 * Prepara o motor de transcrição local (whisper.cpp) em vendor/whisper/ para o sistema e a
 * arquitetura desta máquina. O electron-builder copia a pasta para resources/whisper/.
 *
 *   npm run whisper            baixa/compila se ainda não existir
 *   npm run whisper -- --force refaz do zero
 *
 * Windows x64: usa o binário oficial do whisper.cpp (zip conferido por SHA-256) e embute o runtime
 *   do Visual C++ (msvcp140, vcruntime140, vcomp140…) — PCs "limpos" muitas vezes não têm, e sem
 *   ele o motor nem abre.
 * macOS e Linux: compila a mesma versão a partir do código-fonte (precisa de git, cmake e um
 *   compilador C++; as máquinas do GitHub Actions já têm). No Mac o Metal (GPU) vem ligado; no
 *   Linux x64 e no Mac Intel saem variantes para cada geração de CPU, escolhidas ao rodar.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Versão fixa do whisper.cpp: atualize as três linhas juntas
const TAG = 'b5454';
const COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
const WIN_ZIP = { url: `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-bin-x64.zip`, sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' };

const root = path.join(__dirname, '..');
const out = path.join(root, 'vendor', 'whisper');
const isWin = process.platform === 'win32';
const exe = path.join(out, isWin ? 'whisper-cli.exe' : 'whisper-cli');
const force = process.argv.includes('--force');

function sh(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} falhou (código ${r.status ?? r.error?.message})`);
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download falhou (${res.status}): ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function windows() {
  if (process.arch !== 'x64') throw new Error(`Sem binário do whisper.cpp preparado para win-${process.arch}.`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  try {
    const zip = path.join(tmp, 'whisper.zip');
    console.log(`Baixando ${WIN_ZIP.url}`);
    await download(WIN_ZIP.url, zip);
    const got = sha256(zip);
    if (got !== WIN_ZIP.sha256) throw new Error(`SHA-256 do zip não confere (${got}).`);
    // O tar do Windows 10+ (bsdtar) abre .zip — pelo caminho completo, porque o do Git Bash não abre
    sh(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]);
    const rel = path.join(tmp, 'Release');
    fs.mkdirSync(out, { recursive: true });
    const keep = fs.readdirSync(rel).filter((f) => f === 'whisper-cli.exe' || /^(whisper|ggml.*)\.dll$/i.test(f));
    for (const f of keep) fs.copyFileSync(path.join(rel, f), path.join(out, f));
    // Runtime do Visual C++ ao lado do executável (distribuição "app-local" permitida pela Microsoft)
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    for (const f of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']) {
      const src = path.join(sys32, f);
      if (!fs.existsSync(src)) throw new Error(`${f} não encontrado em ${sys32} — instale o Visual C++ Redistributable nesta máquina de build.`);
      fs.copyFileSync(src, path.join(out, f));
    }
    console.log(`Copiados: ${keep.length} arquivos do whisper.cpp + runtime do Visual C++`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function unix() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
  try {
    const src = path.join(tmp, 'src');
    sh('git', ['clone', '--depth', '1', '--branch', TAG, 'https://github.com/ggml-org/whisper.cpp.git', src]);
    const head = spawnSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    if (head !== COMMIT) throw new Error(`A tag ${TAG} aponta para ${head}, esperado ${COMMIT}.`);
    const mac = process.platform === 'darwin';
    const x64 = process.arch === 'x64';
    const build = path.join(tmp, 'build');
    const args = [
      '-S', src, '-B', build,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=ON',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DWHISPER_BUILD_SERVER=OFF',
      '-DWHISPER_SDL2=OFF',
      '-DGGML_NATIVE=OFF', // o binário roda em outros PCs, não só nesta máquina
      '-DGGML_OPENMP=OFF', // dispensa a libgomp, que nem toda distribuição Linux tem
      // Bibliotecas ao lado do executável
      `-DCMAKE_INSTALL_RPATH=${mac ? '@loader_path' : '$ORIGIN'}`,
      '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
    ];
    // Em x64 há gerações de CPU muito diferentes (com e sem AVX2/AVX-512): compila uma variante
    // para cada e o ggml escolhe a melhor ao abrir
    if (x64) args.push('-DGGML_BACKEND_DL=ON', '-DGGML_CPU_ALL_VARIANTS=ON');
    if (mac) args.push('-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON');
    sh('cmake', args);
    sh('cmake', ['--build', build, '--config', 'Release', '-j', String(os.cpus().length), '--target', 'whisper-cli']);
    if (x64) sh('cmake', ['--build', build, '--config', 'Release', '-j', String(os.cpus().length)]); // variantes de CPU

    fs.mkdirSync(out, { recursive: true });
    const bin = path.join(build, 'bin');
    fs.copyFileSync(path.join(bin, 'whisper-cli'), exe);
    fs.chmodSync(exe, 0o755);
    // Bibliotecas: copia o arquivo real com todos os nomes (o executável procura pelo SONAME, ex. libwhisper.so.1)
    const libs = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(so(\.\d+)*|dylib)$/.test(e.name)) libs.push(p); } };
    walk(build);
    for (const p of libs) {
      const dest = path.join(out, path.basename(p));
      if (!fs.existsSync(dest)) fs.copyFileSync(fs.realpathSync(p), dest);
    }
    console.log(`Copiados: whisper-cli + ${libs.length} bibliotecas`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  if (fs.existsSync(exe) && !force) { console.log(`whisper.cpp já preparado em ${path.relative(root, out)} (use --force para refazer).`); return; }
  fs.rmSync(out, { recursive: true, force: true });
  if (isWin) await windows(); else unix();
  fs.writeFileSync(path.join(out, 'VERSION.txt'), `whisper.cpp ${TAG} (${COMMIT})\n${process.platform}-${process.arch}\n`);
  // Confere se abre (falta de biblioteca aparece aqui, não no PC do usuário)
  const r = spawnSync(exe, ['--help'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`whisper-cli não executou: ${r.error?.message || r.stderr?.slice(-400)}`);
  console.log(`✓ whisper.cpp ${TAG} pronto em ${path.relative(root, out)}`);
})().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
