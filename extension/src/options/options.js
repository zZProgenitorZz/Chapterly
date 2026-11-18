import { DEFAULTS, formatRate, getApiToken, getSettings, saveApiToken, saveSettings } from '../shared/settings.js';
import { positions } from '../shared/session-store.js';
import { fetchSpeech, fetchVoices, toErrorInfo } from '../player/tts-client.js';
import { describeError } from '../shared/error-messages.js';
import { describeVoice, parseVoiceKey, renderVoiceOptions } from '../shared/voices.js';
import { createAudioStore } from '../player/audio-store.js';
import { MessageType, toBackground } from '../shared/messages.js';

const SAMPLE = 'This is how chapters will sound with this voice.';

const form = document.getElementById('form');
const input = document.getElementById('backendUrl');
const message = document.getElementById('message');
const voiceSelect = document.getElementById('voice');
const previewButton = document.getElementById('preview');
const voiceMessage = document.getElementById('voice-message');
const previewAudio = document.getElementById('preview-audio');

let catalog = null;
let previewUrl = null;
let previewAbort = null;

function show(el, text, kind) {
  el.textContent = text;
  el.dataset.kind = kind;
}

async function save(url) {
  try {
    const saved = await saveSettings({ backendUrl: url });
    input.value = saved.backendUrl;
    show(message, 'Saved', 'ok');
    await loadVoices();
  } catch (err) {
    show(message, err.message, 'error');
  }
}

/** Fills the voice select from GET /api/voices. On failure the stored choice is kept. */
async function loadVoices() {
  const settings = await getSettings();
  const selection = { provider: settings.provider, voice: settings.voice };
  voiceSelect.disabled = true;
  show(voiceMessage, 'Loading voices…', 'info');
  try {
    catalog = await fetchVoices(settings.backendUrl, { apiToken: settings.apiToken });
    renderVoiceOptions(voiceSelect, catalog, selection);
    voiceSelect.disabled = false;
    previewButton.disabled = false;
    show(voiceMessage, '', 'info');
  } catch (err) {
    catalog = null;
    renderVoiceOptions(voiceSelect, null, selection); // only the stored choice
    previewButton.disabled = true;
    show(voiceMessage, `${describeError(toErrorInfo(err))}. Your voice choice is kept.`, 'error');
  }
}

voiceSelect.addEventListener('change', async () => {
  const selection = parseVoiceKey(voiceSelect.value);
  if (!selection) return;
  try {
    await saveSettings(selection);
    show(voiceMessage, 'Voice saved', 'ok');
  } catch (err) {
    show(voiceMessage, err.message, 'error');
  }
});

previewButton.addEventListener('click', async () => {
  const selection = parseVoiceKey(voiceSelect.value);
  if (!selection) return;
  previewAbort?.abort();
  previewAbort = new AbortController();
  previewButton.disabled = true;
  show(voiceMessage, 'Generating preview…', 'info');
  try {
    const { backendUrl, apiToken } = await getSettings();
    const result = await fetchSpeech(SAMPLE, { baseUrl: backendUrl, apiToken, signal: previewAbort.signal, ...selection });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(result.blob);
    previewAudio.src = previewUrl;
    await previewAudio.play();
    show(voiceMessage, `Playing: ${describeVoice(result, catalog).replace(/^Voice: /, '')}`, result.fallback ? 'error' : 'ok');
  } catch (err) {
    if (err?.name !== 'AbortError') show(voiceMessage, describeError(toErrorInfo(err)), 'error');
  } finally {
    previewButton.disabled = false;
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void save(input.value);
});

document.getElementById('reset').addEventListener('click', () => save(DEFAULTS.backendUrl));

// ---------- speed, reading behaviour, shortcuts, positions ----------

const speed = document.getElementById('speed');
const speedValue = document.getElementById('speed-value');
const CHECKBOXES = ['autoNextChapter', 'arrowKeysControl', 'clickToJump'];

function renderSpeed(rate) {
  speed.value = String(rate);
  speedValue.textContent = formatRate(rate);
}

speed.addEventListener('input', () => (speedValue.textContent = formatRate(speed.value)));
speed.addEventListener('change', () => saveSettings({ playbackRate: speed.value }).then((s) => renderSpeed(s.playbackRate)));
document.getElementById('speed-reset').addEventListener('click', () =>
  saveSettings({ playbackRate: DEFAULTS.playbackRate }).then((s) => renderSpeed(s.playbackRate)),
);

for (const key of CHECKBOXES) {
  const box = document.getElementById(key);
  box.addEventListener('change', () => saveSettings({ [key]: box.checked }));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if ('playbackRate' in changes) renderSpeed(changes.playbackRate.newValue ?? DEFAULTS.playbackRate);
  for (const key of CHECKBOXES) {
    if (key in changes) document.getElementById(key).checked = Boolean(changes[key].newValue ?? DEFAULTS[key]);
  }
});

async function loadShortcuts() {
  const list = document.getElementById('shortcut-list');
  const commands = (await chrome.commands?.getAll?.().catch(() => [])) ?? [];
  list.replaceChildren(
    ...commands
      .filter((c) => c.description)
      .map((c) => {
        const li = document.createElement('li');
        li.textContent = `${c.description}: ${c.shortcut || 'not set'}`;
        return li;
      }),
  );
}

document.getElementById('edit-shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

const positionsMessage = document.getElementById('positions-message');
async function showPositionCount() {
  const count = Object.keys(await positions().getAll()).length;
  document.getElementById('positions-info').textContent =
    `Chapterly remembers where you stopped in each novel (${count} saved, at most 200).`;
}
document.getElementById('forget-positions').addEventListener('click', async () => {
  await positions().forget();
  show(positionsMessage, 'Forgotten', 'ok');
  await showPositionCount();
});

const audioCacheMessage = document.getElementById('audio-cache-message');
async function showAudioCacheUsage() {
  try {
    const { entries, bytes } = await createAudioStore().usage();
    document.getElementById('audio-cache-info').textContent =
      `Finished audio is kept on this computer, so resuming after a long pause, going back and reading a chapter ` +
      `again need no new request. Now: ${entries} chunks, ${(bytes / (1024 * 1024)).toFixed(1)} MB of at most 150 MB.`;
  } catch {
    // Cache Storage unavailable: keep the static text
  }
}
document.getElementById('clear-audio-cache').addEventListener('click', async () => {
  try {
    // Through the service worker, so a running player drops its in-memory index too.
    await toBackground(MessageType.CLEAR_AUDIO_CACHE);
    show(audioCacheMessage, 'Cleared', 'ok');
  } catch (err) {
    show(audioCacheMessage, String(err?.message ?? err), 'error');
  }
  await showAudioCacheUsage();
});

// ---------- API token (chrome.storage.local: a secret, never synced) ----------

const tokenInput = document.getElementById('apiToken');
const tokenMessage = document.getElementById('token-message');
document.getElementById('token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const token = await saveApiToken(tokenInput.value);
    tokenInput.value = token;
    show(tokenMessage, token ? 'Saved' : 'Removed', 'ok');
    await loadVoices(); // shows at once whether the backend accepts it
  } catch (err) {
    show(tokenMessage, err.message, 'error');
  }
});
document.getElementById('token-show').addEventListener('change', (e) => {
  tokenInput.type = e.target.checked ? 'text' : 'password';
});
void getApiToken().then((token) => (tokenInput.value = token));

getSettings().then((s) => {
  input.value = s.backendUrl;
  renderSpeed(s.playbackRate);
  for (const key of CHECKBOXES) document.getElementById(key).checked = s[key];
  void loadVoices();
});
void loadShortcuts();
void showPositionCount();
void showAudioCacheUsage();
