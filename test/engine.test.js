const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/main/engine');

const root = path.join(__dirname, '..');

test('mesmo motor de sempre: faster-whisper e ctranslate2 travados nas versões em uso', () => {
  for (const pkg of ['faster-whisper==1.2.1', 'ctranslate2==4.8.2']) {
    assert.ok(E.PACKAGES_EXACT.includes(pkg), `${pkg} na lista exata`);
    assert.ok(E.PACKAGES_CORE.includes(pkg), `${pkg} também no plano B (Mac)`);
  }
  // Tudo com versão fixa: nada de "a mais nova do dia"
  for (const p of [...E.PACKAGES_EXACT, ...E.PACKAGES_CORE]) assert.match(p, /^[a-z0-9-]+==\d+(\.\d+)*$/);
});

test('o script de transcrição usa os mesmos parâmetros de sempre', () => {
  const py = fs.readFileSync(path.join(root, 'python', 'transcribe.py'), 'utf8');
  for (const s of ['compute_type="int8"', 'vad_filter=True', '"min_silence_duration_ms": 500', 'beam_size=5', 'condition_on_previous_text=False']) {
    assert.ok(py.includes(s), `transcribe.py mantém ${s}`);
  }
});

test('Turbo é o padrão de instalações novas e todos os modelos usam os repositórios do faster-whisper', () => {
  assert.equal(E.DEFAULT_MODEL, 'large-v3-turbo');
  assert.ok(E.MODELS['large-v3-turbo'].recommended);
  assert.equal(E.MODELS['large-v3-turbo'].repo, 'mobiuslabsgmbh/faster-whisper-large-v3-turbo');
  for (const id of ['tiny', 'base', 'small', 'medium', 'large-v3']) assert.equal(E.MODELS[id].repo, `Systran/faster-whisper-${id}`);
  assert.equal(E.modelId('inexistente'), 'large-v3-turbo');
  assert.equal(E.modelId('small'), 'small'); // quem escolheu o Small continua no Small
  assert.match(fs.readFileSync(path.join(root, 'src', 'main', 'store.js'), 'utf8'), /localModel: 'large-v3-turbo'/);
});

test('uv: um instalador conferido por SHA-256 para cada sistema do app', () => {
  for (const [plat, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    const a = E.uvAsset(plat, arch);
    assert.ok(a, `${plat}-${arch}`);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.match(a.file, plat === 'win32' ? /\.zip$/ : /\.tar\.gz$/);
  }
  assert.equal(E.uvAsset('freebsd', 'x64'), null);
  assert.match(E.UV_VERSION, /^\d+\.\d+\.\d+$/);
});

test('pasta de cache do Hugging Face igual à do huggingface_hub', () => {
  assert.equal(E.hfCacheDir({ HF_HUB_CACHE: '/x/hub' }, '/home/a'), '/x/hub');
  assert.equal(E.hfCacheDir({ HF_HOME: '/y' }, '/home/a'), path.join('/y', 'hub'));
  assert.equal(E.hfCacheDir({ XDG_CACHE_HOME: '/c' }, '/home/a'), path.join('/c', 'huggingface', 'hub'));
  assert.equal(E.hfCacheDir({}, '/home/a'), path.join('/home/a', '.cache', 'huggingface', 'hub'));
});

test('modelo baixado = model.bin presente num snapshot do cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-ç-'));
  assert.equal(E.modelCached('large-v3-turbo', dir), false);
  const snap = path.join(dir, 'models--mobiuslabsgmbh--faster-whisper-large-v3-turbo', 'snapshots', 'abc');
  fs.mkdirSync(snap, { recursive: true });
  assert.equal(E.modelCached('large-v3-turbo', dir), false); // pasta sem o model.bin (download pela metade)
  fs.writeFileSync(path.join(snap, 'model.bin'), 'x');
  assert.equal(E.modelCached('large-v3-turbo', dir), true);
  assert.equal(E.modelCached('small', dir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mensagens de erro da instalação dizem o que fazer', () => {
  assert.match(E.installErrorMessage('error: Failed to fetch: dns error'), /internet/);
  assert.match(E.installErrorMessage('OSError: [Errno 28] No space left on device'), /espaço/);
  assert.match(E.installErrorMessage('Access is denied. (os error 5)'), /permissão/);
  assert.match(E.installErrorMessage('qualquer coisa'), /tente de novo/);
});

test('cancelar sem instalação em andamento não faz nada; pedidos repetidos usam a mesma instalação', () => {
  const e = new E.Engine(path.join(os.tmpdir(), 'meetrec-engine-test'));
  assert.equal(e.cancel(), false);
  e._install = () => new Promise(() => {}); // instalação "em andamento" de mentira
  assert.equal(e.install(), e.install());
});

test('electron-builder leva o script Python e não leva o whisper.cpp', () => {
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /- python\/\*\*\/\*/);
  assert.doesNotMatch(yml, /whisper\.cpp|vendor\/whisper/i);
});
