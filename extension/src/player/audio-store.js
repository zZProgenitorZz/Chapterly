// Persistent audio cache: finished MP3 chunks in the Cache Storage API, so resuming after a
// long pause (Chrome closes the offscreen document after ~30 s of silence), going back and
// re-reading a chapter need no new request. Works in the offscreen document, the service
// worker and the options page (they share the extension origin). No chrome.* APIs.
//
// Key: https://chapterly.cache/<sha256 of [provider, voice, text]>, where provider/voice are
// the *requested* selection (what the player knows before asking). Fallback audio (another
// provider answered) is never stored, so a later request can still get the chosen voice.
//
// An LRU index {url: {size, used}} lives in the same cache under INDEX_URL. Above maxBytes
// the least recently used entries are deleted. The index is kept in memory and written back
// shortly after changes; all operations of one store run one at a time.

import { createSerialQueue } from '../shared/serial.js';

export const AUDIO_CACHE_NAME = 'chapterly-audio-v1';
export const MAX_AUDIO_CACHE_BYTES = 150 * 1024 * 1024;
const KEY_ORIGIN = 'https://chapterly.cache/';
const INDEX_URL = `${KEY_ORIGIN}__index__`;
const INDEX_WRITE_DELAY_MS = 250;

/** Stable key for one chunk in one voice selection ({provider, voice} or null = backend default). */
export async function audioKey(selection, text, subtle = globalThis.crypto.subtle) {
  const parts = JSON.stringify([selection?.provider ?? '', selection?.voice ?? '', String(text)]);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(parts));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return KEY_ORIGIN + hex;
}

/**
 * @param {object} [deps]
 * @param {CacheStorage} [deps.caches]
 * @param {number} [deps.maxBytes]
 * @param {() => number} [deps.now]
 */
export function createAudioStore({
  caches = globalThis.caches,
  maxBytes = MAX_AUDIO_CACHE_BYTES,
  now = () => Date.now(),
  subtle = globalThis.crypto?.subtle,
  indexWriteDelayMs = INDEX_WRITE_DELAY_MS,
} = {}) {
  const serial = createSerialQueue();

  let index = null; // {url: {size, used}}, loaded on first use
  let writeTimer = null;
  const open = () => caches.open(AUDIO_CACHE_NAME);

  async function loadIndex(cache) {
    if (index) return index;
    const stored = await cache.match(INDEX_URL);
    if (stored) {
      try {
        index = (await stored.json()) ?? {};
        return index;
      } catch {
        // corrupt: rebuild below
      }
    }
    // Missing (first run, or cleared elsewhere): rebuild from the stored responses' headers.
    index = {};
    for (const req of await cache.keys()) {
      const url = typeof req === 'string' ? req : req.url;
      if (url === INDEX_URL) continue;
      const res = await cache.match(url);
      index[url] = { size: Number(res?.headers.get('X-Chapterly-Size')) || 0, used: 0 };
    }
    return index;
  }

  function scheduleIndexWrite() {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      void serial(writeIndex);
    }, indexWriteDelayMs);
  }

  async function writeIndex() {
    if (!index) return;
    const cache = await open();
    await cache.put(INDEX_URL, new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
  }

  const totalBytes = (idx) => Object.values(idx).reduce((sum, e) => sum + (e.size || 0), 0);

  async function evict(cache, idx) {
    let total = totalBytes(idx);
    if (total <= maxBytes) return;
    const oldestFirst = Object.entries(idx).sort((a, b) => a[1].used - b[1].used);
    for (const [url, entry] of oldestFirst) {
      if (total <= maxBytes) break;
      await cache.delete(url);
      delete idx[url];
      total -= entry.size || 0;
    }
  }

  return {
    /** {blob, provider, voice, fallback: false} or null. Never throws. */
    get: (selection, text) =>
      serial(async () => {
        const url = await audioKey(selection, text, subtle);
        const cache = await open();
        const res = await cache.match(url);
        if (!res) return null;
        const blob = await res.blob();
        if (!blob.size) return null;
        const idx = await loadIndex(cache);
        idx[url] = { size: blob.size, used: now() };
        scheduleIndexWrite();
        return {
          blob,
          provider: res.headers.get('X-TTS-Provider') ?? 'unknown',
          voice: res.headers.get('X-TTS-Voice'),
          fallback: false,
        };
      }).catch(() => null),

    /** Stores a finished chunk (skipped for fallback audio). Never throws. */
    put: (selection, text, { blob, provider, voice = null, fallback = false }) =>
      serial(async () => {
        if (fallback || !blob?.size) return false;
        const url = await audioKey(selection, text, subtle);
        const cache = await open();
        const headers = { 'Content-Type': 'audio/mpeg', 'X-Chapterly-Size': String(blob.size) };
        if (provider) headers['X-TTS-Provider'] = provider;
        if (voice) headers['X-TTS-Voice'] = voice;
        await cache.put(url, new Response(blob, { headers }));
        const idx = await loadIndex(cache);
        idx[url] = { size: blob.size, used: now() };
        await evict(cache, idx);
        scheduleIndexWrite();
        return true;
      }).catch(() => false),

    /** {entries, bytes} from the index. */
    usage: () =>
      serial(async () => {
        const idx = await loadIndex(await open());
        return { entries: Object.keys(idx).length, bytes: totalBytes(idx) };
      }),

    /** Deletes every stored chunk. */
    clear: () =>
      serial(async () => {
        clearTimeout(writeTimer);
        writeTimer = null;
        index = null;
        await caches.delete(AUDIO_CACHE_NAME);
      }),

    /** Writes a pending index change now (tests, page unload). */
    flush: () => {
      clearTimeout(writeTimer);
      writeTimer = null;
      return serial(writeIndex);
    },
  };
}
