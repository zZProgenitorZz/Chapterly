import { DEFAULTS, getSettings, saveSettings } from '../shared/settings.js';
import { fetchSpeech, fetchVoices, toErrorInfo } from '../player/tts-client.js';
import { describeError } from '../shared/error-messages.js';
import { describeVoice, parseVoiceKey, renderVoiceOptions } from '../shared/voices.js';

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
    catalog = await fetchVoices(settings.backendUrl);
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
    const { backendUrl } = await getSettings();
    const result = await fetchSpeech(SAMPLE, { baseUrl: backendUrl, signal: previewAbort.signal, ...selection });
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

getSettings().then((s) => {
  input.value = s.backendUrl;
  void loadVoices();
});
