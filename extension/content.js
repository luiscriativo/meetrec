// MeetRec — lê o Teams/Meet no navegador: chamada ativa, quem fala, legendas com nome e participantes.
// Os seletores do Teams/Meet mudam com frequência; por isso há vários sinais alternativos.
(() => {
  if (window.__meetrec) return;
  window.__meetrec = true;

  const host = location.hostname;
  const PLATFORM = host.includes('meet.google') ? 'Google Meet' : 'Teams (navegador)';
  const isTeams = PLATFORM.startsWith('Teams');

  let queue = [];
  let inCall = false;
  let speakingNow = new Set();
  let participants = new Set();
  const captionState = new WeakMap(); // elemento -> { id, text, speaker }
  let captionSeq = 0;
  let lastSend = 0;
  const stats = { captions: 0, speaking: 0, lastCaption: null };

  const txt = (el) => (el?.innerText || el?.textContent || '').trim();
  const cleanName = (n) => (n || '')
    .replace(/\s*\((?:Convidado|Guest|Externo|External|Não verificado|Unverified|Organizador|Organizer)\)\s*/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  const qa = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };

  function push(ev) { queue.push({ ...ev, at: Date.now() }); }

  // ───────── Chamada ativa ─────────
  function detectCall() {
    if (isTeams) {
      return !!(document.querySelector('#hangup-button, [data-tid="hangup-main-btn"], [data-tid="call-hangup"], button[data-tid="hangup-button"], [data-tid="call-duration"], [data-tid="calling-stage"]')
        || qa('button[aria-label]').some((b) => /^(Sair|Leave|Desligar|Hang up)\b/i.test(b.getAttribute('aria-label'))));
    }
    return !!(document.querySelector('[jsname="CQylAd"], [data-call-ended="false"]')
      || qa('button[aria-label]').some((b) => /(Sair da chamada|Leave call|Encerrar chamada)/i.test(b.getAttribute('aria-label'))));
  }

  function meetingTitle() {
    if (isTeams) {
      const t = txt(document.querySelector('[data-tid="call-title"], [data-tid="meeting-title"], [data-tid="call-status-container-test-id"] h2'));
      if (t) return t.slice(0, 120);
      return document.title.replace(/\s*\|\s*Microsoft Teams.*$/i, '').replace(/^\(\d+\)\s*/, '').trim().slice(0, 120) || null;
    }
    const t = txt(document.querySelector('[data-meeting-title]')) || document.querySelector('[data-meeting-title]')?.getAttribute('data-meeting-title');
    return (t || document.title.replace(/^Meet\s*[-–]\s*/i, '')).trim().slice(0, 120) || null;
  }

  // ───────── Legendas (melhor fonte de nomes) ─────────
  function captionBlocks() {
    const out = [];
    if (isTeams) {
      for (const textEl of qa('[data-tid="closed-caption-text"], [data-tid="closed-captions-text"]')) {
        let box = textEl.parentElement, author = null;
        for (let i = 0; i < 6 && box; i++) {
          author = box.querySelector('[data-tid="author"], .ui-chat__message__author, [data-tid="closed-caption-author"]');
          if (author) break;
          box = box.parentElement;
        }
        out.push({ el: textEl, speaker: cleanName(txt(author)), text: txt(textEl) });
      }
    } else {
      const regions = qa('[role="region"][aria-label], div[jsname="dsyhDe"], .a4cQT').filter((r) => /legenda|caption|subtit/i.test(r.getAttribute('aria-label') || '') || r.matches('div[jsname="dsyhDe"], .a4cQT'));
      for (const reg of regions) {
        for (const blk of qa(':scope > div, .nMcdL, .TBMuR', reg)) {
          const nameEl = blk.querySelector('.NWpY1d, .zs7s8d, .KcIKyf, [data-speaker-name]');
          const textEl = blk.querySelector('.bh44bd, .iTTPOb, .ygicle, [data-caption-text]');
          let speaker = cleanName(txt(nameEl)), text = txt(textEl);
          if (!speaker || !text) {
            const lines = txt(blk).split('\n').map((s) => s.trim()).filter(Boolean);
            if (lines.length >= 2) { speaker = speaker || cleanName(lines[0]); text = text || lines.slice(1).join(' '); }
          }
          if (speaker && text) out.push({ el: textEl || blk, speaker, text });
        }
      }
    }
    return out;
  }

  function scanCaptions() {
    for (const b of captionBlocks()) {
      if (!b.text) continue;
      const st = captionState.get(b.el);
      if (!st) {
        const id = `c${++captionSeq}`;
        captionState.set(b.el, { id, text: b.text, speaker: b.speaker });
        push({ type: 'caption', id, speaker: b.speaker, text: b.text });
        stats.captions++; stats.lastCaption = `${b.speaker}: ${b.text.slice(0, 60)}`;
        if (b.speaker) participants.add(b.speaker);
      } else if (st.text !== b.text) {
        st.text = b.text;
        push({ type: 'caption', id: st.id, speaker: st.speaker || b.speaker, text: b.text });
      }
    }
  }

  // ───────── Quem está falando (indicadores visuais) ─────────
  function nameFromTile(tile) {
    if (!tile) return null;
    const n = tile.querySelector('[data-tid="participant-name"], [data-tid="calling-participant-name"], [data-tid="display-name"], [data-self-name], .zWGUib, .XEazBc');
    let name = txt(n) || n?.getAttribute?.('data-self-name');
    if (!name) {
      const al = tile.getAttribute('aria-label') || '';
      const m = al.match(/^([^,.;]+?)(?:,|\s+(?:está|is)\b|$)/i);
      if (m) name = m[1];
    }
    name = cleanName(name);
    return name && name.length > 1 && !/^(você|you|eu)$/i.test(name) ? name : null;
  }

  function scanSpeaking() {
    const now = new Set();
    if (isTeams) {
      for (const o of qa('[data-tid="voice-level-stream-outline"], [data-tid="speaking-indicator"], [data-tid*="voice-level"]')) {
        if (!visible(o)) continue;
        const tile = o.closest('[data-tid^="video-tile"], [data-cid="calling-participant-stream"], [data-stream-type], [role="menuitem"], [data-tid*="participant"]');
        const n = nameFromTile(tile);
        if (n) now.add(n);
      }
      for (const el of qa('[data-tid="roster-participant-mic-speaking"], [data-tid*="mic-speaking"]')) {
        const n = nameFromTile(el.closest('[role="treeitem"], [data-tid^="participantsInCall"], li'));
        if (n) now.add(n);
      }
    } else {
      for (const tile of qa('[data-participant-id]')) {
        const ind = tile.querySelector('.IisKdb, [data-speaking="true"], .kssMZb');
        if (ind && visible(ind) && !ind.classList.contains('gjg47c')) { const n = nameFromTile(tile); if (n) now.add(n); }
      }
    }
    // Sinal genérico por aria-label (“Fulano está falando” / “Fulano is speaking”)
    for (const el of qa('[aria-label*="falando"], [aria-label*="speaking"]')) {
      const m = (el.getAttribute('aria-label') || '').match(/^(.+?)\s+(?:está falando|is speaking)/i);
      if (m) { const n = cleanName(m[1]); if (n) now.add(n); }
    }
    for (const n of now) if (!speakingNow.has(n)) { push({ type: 'speaking', speaker: n, on: true }); stats.speaking++; participants.add(n); }
    for (const n of speakingNow) if (!now.has(n)) push({ type: 'speaking', speaker: n, on: false });
    speakingNow = now;
  }

  // ───────── Participantes ─────────
  let lastRoster = '';
  function scanParticipants() {
    const names = new Set(participants);
    const tiles = isTeams
      ? qa('[data-tid^="video-tile"], [data-cid="calling-participant-stream"], [role="treeitem"][data-tid^="participantsInCall"], [data-tid^="participantsInCall-"]')
      : qa('[data-participant-id]');
    for (const t of tiles) { const n = nameFromTile(t); if (n) names.add(n); }
    const key = [...names].sort().join('|');
    if (key !== lastRoster && names.size) { lastRoster = key; push({ type: 'participants', names: [...names] }); }
  }

  // ───────── Loop ─────────
  function tick() {
    const wasInCall = inCall;
    inCall = detectCall();
    if (inCall) {
      try { scanCaptions(); } catch {}
      try { scanSpeaking(); } catch {}
    } else if (speakingNow.size) {
      for (const n of speakingNow) push({ type: 'speaking', speaker: n, on: false });
      speakingNow.clear();
    }
    const now = Date.now();
    if (inCall && now % 5000 < 400) { try { scanParticipants(); } catch {} }
    // Só o frame que contém a chamada reporta (ou o topo, para manter a conexão viva)
    if ((inCall || wasInCall || window === window.top) && (queue.length || inCall !== wasInCall || now - lastSend > 3000)) {
      const events = queue; queue = [];
      lastSend = now;
      try {
        chrome.runtime.sendMessage({ type: 'events', tab: { platform: PLATFORM, inCall, title: inCall ? meetingTitle() : null, url: location.origin }, events });
      } catch { /* extensão recarregada: ignora */ }
    }
  }

  setInterval(tick, 400);

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'debug') {
      if (!inCall && window !== window.top) return;
      reply({ platform: PLATFORM, inCall, title: meetingTitle(), speaking: [...speakingNow], participants: [...participants].slice(0, 30), captions: stats.captions, lastCaption: stats.lastCaption, speakingEvents: stats.speaking });
    }
  });
})();
