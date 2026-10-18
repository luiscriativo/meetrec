const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const W = require('../src/main/whisper');

test('Turbo é o modelo padrão e ids desconhecidos/antigos caem nele', () => {
  assert.equal(W.DEFAULT_MODEL, 'large-v3-turbo');
  assert.ok(W.MODELS[W.DEFAULT_MODEL].recommended);
  assert.equal(W.modelId('tiny'), 'large-v3-turbo'); // "tiny" existia no app antigo
  assert.equal(W.modelId(undefined), 'large-v3-turbo');
  assert.equal(W.modelId('small'), 'small');
  for (const m of Object.values(W.MODELS)) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.size > 1e7 && m.file.startsWith('ggml-'));
  }
});

test('padrão das configurações novas é o Turbo', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'store.js'), 'utf8');
  assert.match(store, /localModel: 'large-v3-turbo'/);
});

test('argumentos do whisper-cli: caminhos relativos, VAD e sem contexto anterior', () => {
  const a = W.buildArgs({ model: '../models/m.bin', vad: '../models/v.bin', input: 'audio-1.wav', outBase: 'out-1', language: 'pt', prompt: 'Vocabulário: x', threads: 6 });
  const val = (k) => a[a.indexOf(k) + 1];
  assert.equal(val('-m'), '../models/m.bin');
  assert.equal(val('-f'), 'audio-1.wav');
  assert.equal(val('-of'), 'out-1');
  assert.equal(val('-l'), 'pt');
  assert.equal(val('-t'), '6');
  assert.equal(val('-mc'), '0');
  assert.ok(a.includes('-oj') && a.includes('--vad'));
  assert.equal(val('-vm'), '../models/v.bin');
  assert.equal(val('--prompt'), 'Vocabulário: x');
  const b = W.buildArgs({ model: 'm', input: 'i', outBase: 'o', language: '' });
  assert.equal(b[b.indexOf('-l') + 1], 'auto');
  assert.ok(!b.includes('--vad') && !b.includes('--prompt'));
});

test('texto com acento para o Windows: os bytes UTF-8 chegam intactos pela página 1252', () => {
  const s = 'Conceição, orçamento, Ánimo';
  const enc = W.argText(s, 1252);
  // Simula a conversão do Windows (UTF-16 → cp1252): cada caractere vira um byte
  const back = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'Ÿ': 0x9f };
  const bytes = Buffer.from([...enc].map((c) => back[c] ?? c.charCodeAt(0)));
  assert.equal(bytes.toString('utf8'), s);
  assert.equal(W.argText(s, 65001), s);
  assert.equal(W.argText(s, null), s); // macOS/Linux
  assert.equal(W.argText(s, 932), 'Conceicao, orcamento, Animo');
  assert.equal(W.argText('', 1252), '');
});

test('lê os trechos impressos e o JSON do whisper-cli', () => {
  assert.deepEqual(W.parseSegmentLine('[00:01:02.340 --> 01:00:05.000]   Bom dia, pessoal.'), { start: 62.34, end: 3605, text: 'Bom dia, pessoal.' });
  assert.equal(W.parseSegmentLine('whisper_init: carregando'), null);
  const segs = W.segmentsFromJson({ transcription: [
    { offsets: { from: 3650, to: 11180 }, text: ' Bom dia.' },
    { offsets: { from: 11180, to: 12000 }, text: '   ' },
    { offsets: { from: 12000, to: 16020 }, text: ' A pauta é o SAP.' },
  ] });
  assert.deepEqual(segs, [{ start: 3.65, end: 11.18, text: 'Bom dia.' }, { start: 12, end: 16.02, text: 'A pauta é o SAP.' }]);
  assert.deepEqual(W.segmentsFromJson({}), []);
});

test('fmtBytes', () => {
  assert.equal(W.fmtBytes(574041195), '574 MB');
  assert.equal(W.fmtBytes(1081140203), '1,1 GB');
});

// ─────────── Download dos modelos (servidor falso, sem internet) ───────────
function fakeServer(files, { failAt } = {}) {
  let calls = 0;
  const impl = async (url, { headers = {}, signal } = {}) => {
    calls++;
    const name = url.split('/').pop();
    const data = files[name];
    if (!data) return new Response('nao', { status: 404 });
    const start = headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)[1]) : 0;
    const slice = data.subarray(start);
    let i = 0;
    const body = new ReadableStream({
      // Entrega aos poucos (como a rede): o que chegou antes de cair fica no .part
      pull(ctrl) {
        if (signal?.aborted) return ctrl.error(new Error('abortado'));
        if (failAt != null && start === 0 && i >= failAt) return ctrl.error(new Error('conexão caiu'));
        if (i >= slice.length) return ctrl.close();
        ctrl.enqueue(slice.subarray(i, i + 1000));
        i += 1000;
      },
    });
    return new Response(body, { status: start ? 206 : 200 });
  };
  return { impl, calls: () => calls };
}

function withFakeCatalog(fn) {
  const model = crypto.randomBytes(25000);
  const vad = crypto.randomBytes(3000);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const saved = { m: { ...W.MODELS.base }, v: { ...W.VAD } };
  Object.assign(W.MODELS.base, { size: model.length, sha256: sha(model) });
  Object.assign(W.VAD, { size: vad.length, sha256: sha(vad) });
  const files = { [W.MODELS.base.file]: model, [W.VAD.file]: vad };
  return Promise.resolve(fn(files)).finally(() => { Object.assign(W.MODELS.base, saved.m); Object.assign(W.VAD, saved.v); });
}

test('baixa modelo + VAD, confere o SHA-256 e reaproveita o download em andamento', () => withFakeCatalog(async (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelos-ç-'));
  const srv = fakeServer(files);
  const mm = new W.ModelManager(dir, { fetchImpl: srv.impl });
  const events = [];
  mm.on('progress', (s) => events.push(s));
  assert.equal(mm.isReady('base'), false);
  const p1 = mm.ensure('base');
  assert.equal(mm.ensure('base'), p1, 'pedido repetido usa o mesmo download');
  await p1;
  assert.equal(mm.isReady('base'), true);
  assert.equal(srv.calls(), 2);
  assert.ok(events.at(-1).ready && events.at(-1).received === events.at(-1).total);
  assert.deepEqual(mm.downloaded(), ['base']);
  await mm.ensure('base'); // já pronto: não baixa de novo
  assert.equal(srv.calls(), 2);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('conexão caindo: o download continua de onde parou na nova tentativa', () => withFakeCatalog(async (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelos-'));
  const failing = fakeServer(files, { failAt: 12000 });
  const mm = new W.ModelManager(dir, { fetchImpl: failing.impl });
  await assert.rejects(mm.ensure('base'), (e) => e.code === 'network');
  const part = fs.statSync(mm.file('base') + '.part').size;
  assert.ok(part >= 11000 && part < files[W.MODELS.base.file].length);
  const ranges = [];
  const ok = fakeServer(files);
  mm.fetch = (url, opts) => { ranges.push(opts.headers?.Range || null); return ok.impl(url, opts); };
  await mm.ensure('base');
  assert.equal(mm.isReady('base'), true);
  assert.deepEqual(ranges, [`bytes=${part}-`]);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('arquivo corrompido é descartado (SHA-256 não confere)', () => withFakeCatalog(async (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelos-'));
  const bad = { ...files, [W.MODELS.base.file]: Buffer.alloc(files[W.MODELS.base.file].length, 7) };
  const mm = new W.ModelManager(dir, { fetchImpl: fakeServer(bad).impl });
  await assert.rejects(mm.ensure('base'), (e) => e.code === 'checksum');
  assert.equal(fs.existsSync(mm.file('base')), false);
  assert.equal(fs.existsSync(mm.file('base') + '.part'), false);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('cancelar interrompe e removeOthers apaga só os outros modelos', () => withFakeCatalog(async (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelos-'));
  const slow = async (url, opts) => { await new Promise((r) => setTimeout(r, 30)); return fakeServer(files).impl(url, opts); };
  const mm = new W.ModelManager(dir, { fetchImpl: slow });
  const p = mm.ensure('base');
  assert.equal(mm.cancel('base'), true);
  await assert.rejects(p, (e) => e.code === 'cancelled');
  assert.equal(mm.status('base').downloading, false);
  // removeOthers
  fs.writeFileSync(mm.file('small'), Buffer.alloc(10));
  mm.fetch = fakeServer(files).impl;
  await mm.ensure('base');
  const saved = W.MODELS.small.size;
  W.MODELS.small.size = 10;
  try {
    assert.deepEqual(mm.downloaded().sort(), ['base', 'small']);
    assert.equal(mm.removeOthers('base'), 10);
    assert.deepEqual(mm.downloaded(), ['base']);
  } finally { W.MODELS.small.size = saved; }
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('electron-builder leva o whisper.cpp e não leva mais o Python', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /from: vendor\/whisper\s+to: whisper/);
  assert.doesNotMatch(yml, /python/i);
  const fetchScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fetch-whisper.js'), 'utf8');
  for (const dll of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']) assert.ok(fetchScript.includes(dll), `runtime ${dll} embutido`);
});
