// User settings stored in chrome.storage.sync.
// Step 5 adds e.g. playback speed here; keep every setting in DEFAULTS.

export const DEFAULTS = Object.freeze({
  backendUrl: 'http://localhost:8080',
});

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

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(partial) {
  const next = { ...partial };
  if ('backendUrl' in next) next.backendUrl = normalizeBackendUrl(next.backendUrl);
  await chrome.storage.sync.set(next);
  return getSettings();
}
