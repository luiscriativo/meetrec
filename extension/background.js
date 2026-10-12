// MeetRec — service worker: repassa os eventos ao app (http://127.0.0.1:<porta>) com o código de pareamento.
const DEFAULTS = { port: 47321, token: '' };
let status = { ok: false, error: 'Ainda não conectado', recording: false, at: 0 };

async function cfg() { return { ...DEFAULTS, ...(await chrome.storage.local.get(['port', 'token'])) }; }

function browserName() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Brave/.test(ua) || navigator.brave) return 'Brave';
  return 'Chrome';
}

async function call(path, body) {
  const { port, token } = await cfg();
  if (!token) { status = { ok: false, error: 'Informe o código de pareamento', at: Date.now() }; return status; }
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MeetRec-Token': token },
      body: JSON.stringify({ browser: browserName(), ...body }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) status = { ok: false, error: r.status === 401 ? 'Código de pareamento incorreto' : `Erro ${r.status}`, at: Date.now() };
    else status = { ok: true, recording: !!data.recording, version: data.version, at: Date.now() };
  } catch {
    status = { ok: false, error: 'O app MeetRec não está aberto', at: Date.now() };
  }
  updateBadge();
  return status;
}

function updateBadge() {
  if (status.ok && status.recording) {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#EE2F4A' });
  } else if (!status.ok) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#9CA3AF' });
  } else chrome.action.setBadgeText({ text: '' });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'events') { call('/events', { tab: msg.tab, events: msg.events }); return false; }
  if (msg?.type === 'status') { call('/ping', {}).then(reply); return true; }
  if (msg?.type === 'command') { call('/command', { action: msg.action }).then(() => setTimeout(() => call('/ping', {}).then(reply), 600)); return true; }
  return false;
});

chrome.alarms.create('ping', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => call('/ping', {}));
chrome.runtime.onInstalled.addListener(() => { call('/ping', {}); chrome.action.openPopup?.().catch(() => {}); });
