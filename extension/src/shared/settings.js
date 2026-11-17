// User settings stored in chrome.storage.sync. Keep every setting in DEFAULTS.
// The content script (src/content/page-controls.js) reads arrowKeysControl and
// clickToJump directly and duplicates their defaults.

export const DEFAULTS = Object.freeze({
  backendUrl: 'http://localhost:8080',
  provider: 'kokoro', // TTS provider tried first by the backend
  voice: 'af_heart', // voice id of that provider
  playbackRate: 1, // audio element speed (no new TTS request)
  autoNextChapter: false, // "Continue with the next chapter"
  arrowKeysControl: true, // "Arrow keys control reading" on the page
  clickToJump: true, // "Click a paragraph to read from there"
});

/** Settings keys that change which voice is used. */
export const VOICE_KEYS = Object.freeze(['provider', 'voice']);

export const SPEED = Object.freeze({ min: 0.75, max: 2.5, step: 0.1 });

/** Clamps to [0.75, 2.5] and rounds to 0.05 (steps of 0.1 from 1 stay exact). */
export function normalizeRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return DEFAULTS.playbackRate;
  return Math.round(Math.min(SPEED.max, Math.max(SPEED.min, r)) * 20) / 20;
}

/** One step faster (+1) or slower (-1). */
export function stepRate(rate, direction) {
  return normalizeRate(Math.round((Number(rate) + direction * SPEED.step) * 100) / 100);
}

/** "1.2x", "1x", "0.75x". */
export function formatRate(rate) {
  return `${Number(normalizeRate(rate).toFixed(2))}x`;
}

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
  if ('playbackRate' in next) next.playbackRate = normalizeRate(next.playbackRate);
  for (const key of ['autoNextChapter', 'arrowKeysControl', 'clickToJump']) {
    if (key in next) next[key] = Boolean(next[key]);
  }
  if ('provider' in next || 'voice' in next) {
    const current = await getSettings();
    Object.assign(next, normalizeVoiceSelection({ provider: current.provider, voice: current.voice, ...next }));
  }
  await chrome.storage.sync.set(next);
  return getSettings();
}
