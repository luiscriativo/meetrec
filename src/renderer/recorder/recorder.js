// Janela oculta responsável pela captura: microfone + áudio do sistema, mixagem e gravação em blocos.
// Cada faixa passa por um nó de ganho próprio, o que permite trocar o microfone no meio da gravação
// (ex.: fone desconectado) sem corromper os arquivos.
// `api` é exposto globalmente pelo preload (contextBridge)

let S = null; // sessão atual

const MIME = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';

function errMsg(e, what) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return `Permissão negada para ${what}.`;
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return `Nenhum dispositivo de ${what} encontrado.`;
  if (n === 'NotReadableError' || n === 'TrackStartError') return `O ${what} está ocupado ou indisponível (outro app pode estar usando com exclusividade).`;
  if (n === 'OverconstrainedError') return `O ${what} selecionado não existe mais.`;
  return `Falha ao acessar ${what}: ${e && e.message ? e.message : e}`;
}

async function getMic(opts, deviceId) {
  const audio = {
    echoCancellation: opts.echoCancellation, noiseSuppression: opts.noiseSuppression, autoGainControl: true, channelCount: 1,
  };
  if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}

async function getSystem(opts) {
  if (opts.platform === 'linux') {
    if (!opts.systemDeviceId) throw new Error('No Linux, selecione um dispositivo "Monitor of …" em Configurações → Áudio.');
    return navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: opts.systemDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) {
    throw new Error(opts.platform === 'darwin'
      ? 'O macOS não liberou o áudio do sistema. Permita "Gravação de Tela e Áudio do Sistema" para o MeetRec.'
      : 'O sistema não forneceu o áudio do computador.');
  }
  return new MediaStream(stream.getAudioTracks());
}

function beep(kind) {
  if (!S?.opts?.sounds && kind !== 'force') return;
  try {
    const ctx = new AudioContext();
    const tones = { start: [660, 880], stop: [880, 523], marker: [988] }[kind] || [700];
    tones.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t0 = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.08, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.2);
    });
    setTimeout(() => ctx.close(), 800);
  } catch {}
}

function makeRecorder(track, stream, bits) {
  const r = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: bits });
  let chain = Promise.resolve();
  r.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    chain = chain.then(() => e.data.arrayBuffer()).then((buf) => api.recorder.chunk(track, new Uint8Array(buf)));
  };
  r.onerror = (e) => api.recorder.warning({ message: `Erro no gravador (${track}): ${e.error?.message || 'desconhecido'}`, level: 'error', persist: true });
  r.done = new Promise((res) => { r.onstop = () => chain.then(res); });
  return r;
}

function level(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0, peak = 0;
  for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
  const rms = Math.sqrt(sum / buf.length);
  const db = 20 * Math.log10(rms || 1e-8);
  return { level: Math.max(0, Math.min(1, (db + 60) / 60)), peak };
}

function attachMic(stream) {
  const S_ = S;
  if (S_.micSource) { try { S_.micSource.disconnect(); } catch {} }
  S_.micStream = stream;
  S_.micSource = S_.ctx.createMediaStreamSource(stream);
  S_.micSource.connect(S_.micGain);
  const track = stream.getAudioTracks()[0];
  S_.micLabel = track.label;
  track.onended = () => onMicLost();
}

async function onMicLost() {
  if (!S || S.stopping) return;
  api.recorder.warning({ message: 'O microfone foi desconectado. Tentando usar o microfone padrão…', level: 'warn', key: 'mic-lost' });
  await new Promise((r) => setTimeout(r, 1200));
  if (!S || S.stopping) return;
  try {
    const st = await getMic(S.opts, 'default');
    attachMic(st);
    api.recorder.warning({ message: `Microfone trocado para: ${st.getAudioTracks()[0].label || 'padrão'}. A gravação continua.`, level: 'info', key: 'mic-lost', persist: true });
  } catch (e) {
    api.recorder.trackEnded('mic', 'Microfone perdido e nenhum outro disponível. Gravando apenas o som do computador.');
  }
}

async function start(opts) {
  if (S) return api.recorder.started({ ok: false, error: 'Já existe uma gravação ativa.' });
  const warnings = [];
  let mic = null, sys = null;

  try { mic = await getMic(opts, opts.micDeviceId); }
  catch (e) {
    if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
      try { mic = await getMic(opts, 'default'); warnings.push('O microfone escolhido não foi encontrado — usando o microfone padrão.'); }
      catch (e2) { warnings.push(errMsg(e2, 'microfone')); }
    } else warnings.push(errMsg(e, 'microfone'));
  }

  if (opts.captureSystem) {
    try { sys = await getSystem(opts); }
    catch (e) { warnings.push(`Som do computador não capturado: ${e.message || errMsg(e, 'áudio do sistema')}`); }
  }

  if (!mic && !sys) {
    return api.recorder.started({ ok: false, error: warnings.join(' ') || 'Nenhuma fonte de áudio disponível.' });
  }

  const ctx = new AudioContext({ sampleRate: 48000 });
  if (ctx.state === 'suspended') await ctx.resume();
  S = { opts, ctx, recorders: {}, stopping: false, paused: false };

  const mixDest = ctx.createMediaStreamDestination();
  const micGain = ctx.createGain(), sysGain = ctx.createGain();
  const micDest = ctx.createMediaStreamDestination(), sysDest = ctx.createMediaStreamDestination();
  const micAn = ctx.createAnalyser(), sysAn = ctx.createAnalyser();
  micAn.fftSize = sysAn.fftSize = 1024;
  micGain.connect(micDest); micGain.connect(mixDest); micGain.connect(micAn);
  sysGain.connect(sysDest); sysGain.connect(mixDest); sysGain.connect(sysAn);
  Object.assign(S, { micGain, sysGain, micAn, sysAn });

  const tracks = { mic: false, system: false, micLabel: null };
  if (mic) { attachMic(mic); tracks.mic = true; tracks.micLabel = S.micLabel; }
  if (sys) {
    S.sysStream = sys;
    S.sysSource = ctx.createMediaStreamSource(sys);
    S.sysSource.connect(sysGain);
    tracks.system = true;
    sys.getAudioTracks()[0].onended = () => { if (S && !S.stopping) api.recorder.trackEnded('system', 'A captura do som do computador foi interrompida pelo sistema.'); };
  }

  try {
    if (tracks.mic) S.recorders.mic = makeRecorder('mic', micDest.stream, 48000);
    if (tracks.system) S.recorders.system = makeRecorder('system', sysDest.stream, 48000);
    S.recorders.mix = makeRecorder('mix', mixDest.stream, 64000);
    Object.values(S.recorders).forEach((r) => r.start(1000));
  } catch (e) {
    cleanup();
    return api.recorder.started({ ok: false, error: `Falha ao iniciar o gravador: ${e.message}` });
  }

  beep('start');
  startMeters();
  api.recorder.started({ ok: true, tracks, warnings });
}

function startMeters() {
  const bufM = new Float32Array(S.micAn.fftSize), bufS = new Float32Array(S.sysAn.fftSize);
  let micSilentSince = Date.now(), sysSilentSince = Date.now();
  let micWarned = false, sysWarned = false;
  S.meter = setInterval(() => {
    if (!S) return;
    const m = level(S.micAn, bufM), s = level(S.sysAn, bufS);
    api.recorder.levels({ mic: m.level, system: s.level, micClip: m.peak > 0.98 });
    if (S.paused) { micSilentSince = sysSilentSince = Date.now(); return; }
    const now = Date.now();
    if (m.level > 0.12) {
      micSilentSince = now;
      if (micWarned) { micWarned = false; api.recorder.warning({ message: 'Microfone captando novamente ✓', level: 'ok', key: 'mic-silent' }); }
    } else if (!micWarned && S.recorders.mic && now - micSilentSince > 45000) {
      micWarned = true;
      api.recorder.warning({ message: 'Não estou captando sua voz há 45 s. O microfone está mudo?', level: 'warn', key: 'mic-silent' });
    }
    if (s.level > 0.08) {
      sysSilentSince = now;
      if (sysWarned) { sysWarned = false; api.recorder.warning({ message: 'Som do computador detectado ✓', level: 'ok', key: 'sys-silent' }); }
    } else if (!sysWarned && S.recorders.system && now - sysSilentSince > 120000) {
      sysWarned = true;
      api.recorder.warning({ message: 'Nenhum som do computador há 2 min. Os participantes estão sendo ouvidos neste PC?', level: 'warn', key: 'sys-silent' });
    }
  }, 80);
}

function cleanup() {
  if (!S) return;
  clearInterval(S.meter);
  for (const st of [S.micStream, S.sysStream]) st?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  try { S.ctx.close(); } catch {}
  S = null;
}

async function stop() {
  if (!S) return api.recorder.stopped();
  S.stopping = true;
  const recs = Object.values(S.recorders);
  for (const r of recs) { try { if (r.state !== 'inactive') r.stop(); } catch {} }
  await Promise.race([Promise.all(recs.map((r) => r.done)), new Promise((r) => setTimeout(r, 8000))]);
  beep('stop');
  cleanup();
  api.recorder.stopped();
}

api.on((type, payload) => {
  if (type === 'recorder-start') start(payload).catch((e) => api.recorder.started({ ok: false, error: e.message }));
  else if (type === 'recorder-stop') stop();
  else if (type === 'recorder-pause' && S) { S.paused = true; Object.values(S.recorders).forEach((r) => r.state === 'recording' && r.pause()); }
  else if (type === 'recorder-resume' && S) { S.paused = false; Object.values(S.recorders).forEach((r) => r.state === 'paused' && r.resume()); }
  else if (type === 'play-sound') beep(payload);
});
