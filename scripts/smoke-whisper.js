#!/usr/bin/env node
/**
 * Teste de fumaça do motor local (usado no CI de cada sistema, depois do `npm run whisper`):
 * baixa o modelo Básico (≈ 60 MB) pelo mesmo código do app e transcreve um áudio de verdade,
 * numa pasta com acentos no nome. Falha se o whisper-cli não abrir, não carregar o modelo ou
 * não devolver o resultado.
 *
 *   node scripts/smoke-whisper.js               áudio gerado aqui (voz do sistema no macOS)
 *   SMOKE_AUDIO=arquivo.webm node scripts/...   usa um áudio seu
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { transcribe, configureLocal } = require('../src/main/transcribe');
const { ModelManager, binaryPath } = require('../src/main/whisper');
const { ffmpegPath } = require('../src/main/tools');

(async () => {
  const bin = binaryPath();
  if (!bin) throw new Error('whisper-cli não encontrado — rode "npm run whisper" antes.');
  console.log(`whisper-cli: ${bin}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reunião-ç-'));
  const models = new ModelManager(path.join(process.env.SMOKE_MODELS || path.join(os.homedir(), '.cache', 'meetrec-smoke'), 'models'));
  configureLocal({ models, workDir: path.join(dir, 'whisper-work') });

  let audio = process.env.SMOKE_AUDIO;
  let expect = null;
  let language = 'pt';
  if (!audio && process.platform === 'darwin' && !spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).error) {
    audio = path.join(dir, 'fala.aiff');
    const r = spawnSync('say', ['-o', audio, 'Good morning everyone. This is a short test meeting about the budget.']);
    if (r.status === 0) { expect = /morning|test|meeting|budget/i; language = 'en'; } else audio = null;
  }
  if (!audio) {
    // Tom de 4 s: confere que o motor abre, carrega o modelo e devolve o resultado (sem fala, sem texto)
    audio = path.join(dir, 'tom.wav');
    const r = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', audio]);
    if (r.status !== 0) throw new Error('ffmpeg não gerou o áudio de teste');
  }

  let lastPct = -1;
  models.on('progress', (s) => { const p = Math.floor((s.received / s.total) * 10) * 10; if (p !== lastPct) { lastPct = p; console.log(`  download ${p}%`); } });
  const t0 = Date.now();
  const segs = await transcribe({
    file: audio, duration: 0,
    settings: { engine: 'local', localModel: 'base', language, vocabulary: 'Conceição, orçamento' },
    onStatus: (m, code) => { if (code !== 'segment' && code !== 'downloading') console.log(`  ${m}`); },
  });
  const text = segs.map((s) => s.text).join(' ');
  console.log(`  ${segs.length} trecho(s) em ${((Date.now() - t0) / 1000).toFixed(1)} s: ${text.slice(0, 200)}`);
  if (!Array.isArray(segs)) throw new Error('resultado inválido');
  if (expect && !expect.test(text)) throw new Error(`a fala não foi reconhecida (esperado ${expect})`);
  if (fs.readdirSync(path.join(dir, 'whisper-work')).length) throw new Error('arquivos temporários ficaram para trás');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ motor local funcionando');
})().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
