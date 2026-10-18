#!/usr/bin/env node
/**
 * Teste de fumaça da instalação automática do motor (usado no CI de cada sistema):
 * instala, do zero e numa pasta com acento no nome, o Python do MeetRec + faster-whisper pelo
 * mesmo código do app (src/main/engine.js), baixa o modelo Tiny com progresso e transcreve um
 * áudio de verdade com python/transcribe.py.
 *
 *   node scripts/smoke-engine.js            áudio gerado aqui (voz do sistema no macOS)
 *   SMOKE_AUDIO=arquivo.wav node scripts/…  usa um áudio seu
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Engine } = require('../src/main/engine');
const { ffmpegPath, run } = require('../src/main/tools');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunião-ç-'));
  // Cache de modelos isolado: o teste também baixa o modelo, como num PC novo
  process.env.HF_HOME = path.join(dir, 'hf');
  const script = path.join(__dirname, '..', 'python', 'transcribe.py');
  const engine = new Engine(path.join(dir, 'engine'), { script });

  let last = '';
  engine.on('state', (s) => { const k = `${s.phase} ${s.step || ''} ${s.message || ''}`; if (k !== last) { last = k; console.log(`  ${k}`); } });
  const t0 = Date.now();
  try { await engine.install(); } catch (e) { console.error(engine.log.slice(-3000)); throw e; }
  const py = await engine.find({}, { fresh: true });
  if (!py || py.source !== 'app') throw new Error(`o Python do MeetRec não foi encontrado depois de instalar (${JSON.stringify(py)})`);
  console.log(`  instalado em ${((Date.now() - t0) / 1000).toFixed(0)} s: ${py.version} · faster-whisper ${py.fw}`);

  let pct = -1;
  engine.on('model-progress', (s) => { const p = s.total ? Math.floor((s.received / s.total) * 4) * 25 : 0; if (p !== pct) { pct = p; console.log(`  modelo ${p}%`); } });
  await engine.ensureModel('tiny', py.cmd);
  if (!engine.modelStatus('tiny').ready) throw new Error('modelo não ficou pronto');

  let wav = process.env.SMOKE_AUDIO;
  let expect = null, language = 'pt';
  if (!wav && process.platform === 'darwin') {
    const aiff = path.join(dir, 'fala.aiff');
    if (spawnSync('say', ['-o', aiff, 'Good morning everyone. This is a short test meeting about the budget.']).status === 0) {
      wav = path.join(dir, 'fala.wav');
      spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '16000', wav]);
      expect = /morning|test|meeting|budget/i; language = 'en';
    }
  }
  if (!wav) {
    wav = path.join(dir, 'tom.wav');
    spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ac', '1', '-ar', '16000', wav]);
  }
  const out = path.join(dir, 'saída.json');
  const r = await run(py.cmd, ['-u', script, '--input', wav, '--output', out, '--model', 'tiny', '--language', language, '--prompt', 'Vocabulário: Conceição, orçamento'], { env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, timeout: 10 * 60e3 });
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`a transcrição falhou: ${(r.out + r.err).slice(-1500)}`);
  const segs = JSON.parse(fs.readFileSync(out, 'utf8')).segments || [];
  const text = segs.map((s) => s.text).join(' ');
  console.log(`  ${segs.length} trecho(s): ${text.slice(0, 200)}`);
  if (expect && !expect.test(text)) throw new Error(`a fala não foi reconhecida (esperado ${expect})`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ instalação automática e transcrição funcionando');
})().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
