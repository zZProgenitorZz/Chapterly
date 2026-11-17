// User settings stored in chrome.storage.sync.
// Step 5 adds e.g. playback speed here; keep every setting in DEFAULTS.

export const DEFAULTS = Object.freeze({
  backendUrl: 'http://localhost:8080',
  provider: 'kokoro', // TTS provider tried first by the backend
  voice: 'af_heart', // voice id of that provider
});

/** Settings keys that change which voice is used. */
export const VOICE_KEYS = Object.freeze(['provider', 'voice']);

/** Trims and removes trailing slashes. Throws if the URL is not http(s). */
export function normalizeBackendUrl(input) {
  const raw = String(input ?? '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a full URL, e.g. http://localhost:8080');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The backend URL must start with http:// or https://');
  }
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

/** Validates a {provider, voice} pair (ids as returned by GET /api/voices). */
export function normalizeVoiceSelection({ provider, voice } = {}) {
  const id = /^[A-Za-z0-9_.-]{1,64}$/;
  if (!id.test(String(provider ?? '')) || !id.test(String(voice ?? ''))) {
    throw new Error('Invalid voice selection');
  }
  return { provider: String(provider), voice: String(voice) };
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

/** The voice the backend should try first: {provider, voice}. */
export async function getVoiceSelection() {
  const { provider, voice } = await getSettings();
  return { provider, voice };
}

export async function saveSettings(partial) {
  const next = { ...partial };
  if ('backendUrl' in next) next.backendUrl = normalizeBackendUrl(next.backendUrl);
  if ('provider' in next || 'voice' in next) {
    const current = await getSettings();
    Object.assign(next, normalizeVoiceSelection({ provider: current.provider, voice: current.voice, ...next }));
  }
  await chrome.storage.sync.set(next);
  return getSettings();
}
