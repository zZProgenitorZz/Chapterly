import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_CACHE_NAME, audioKey, createAudioStore } from '../src/player/audio-store.js';

/** Minimal CacheStorage: stores body bytes + headers, returns a fresh Response per match. */
function fakeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const map = stores.get(name);
    return {
      async match(url) {
        const hit = map.get(String(url));
        return hit ? new Response(hit.body.slice(0), { headers: hit.headers }) : undefined;
      },
      async put(url, response) {
        map.set(String(url), { body: await response.arrayBuffer(), headers: Object.fromEntries(response.headers) });
      },
      async delete(url) {
        return map.delete(String(url));
      },
      async keys() {
        return [...map.keys()].map((url) => ({ url }));
      },
    };
  };
  return {
    stores,
    open,
    async delete(name) {
      return stores.delete(name);
    },
  };
}

const KOKORO = { provider: 'kokoro', voice: 'af_heart' };
const mp3 = (size, fill = 1) => new Blob([new Uint8Array(size).fill(fill)], { type: 'audio/mpeg' });

test('keys: same provider, voice and text -> same synthetic URL; anything else differs', async () => {
  const a = await audioKey(KOKORO, 'Hello.');
  assert.match(a, /^https:\/\/chapterly\.cache\/[0-9a-f]{64}$/);
  assert.equal(await audioKey({ ...KOKORO }, 'Hello.'), a);
  assert.notEqual(await audioKey(KOKORO, 'Hello!'), a);
  assert.notEqual(await audioKey({ provider: 'kokoro', voice: 'bm_george' }, 'Hello.'), a);
  assert.notEqual(await audioKey(null, 'Hello.'), a);
});

test('put then get returns the audio with provider and voice', async () => {
  const store = createAudioStore({ caches: fakeCaches() });
  assert.equal(await store.get(KOKORO, 'Hi'), null);
  assert.equal(await store.put(KOKORO, 'Hi', { blob: mp3(100), provider: 'kokoro', voice: 'af_heart' }), true);
  const hit = await store.get(KOKORO, 'Hi');
  assert.equal(hit.blob.size, 100);
  assert.equal(hit.provider, 'kokoro');
  assert.equal(hit.voice, 'af_heart');
  assert.equal(hit.fallback, false);
  assert.equal(await store.get({ provider: 'azure', voice: 'x' }, 'Hi'), null, 'other voice: miss');
});

test('fallback audio and empty blobs are not stored', async () => {
  const store = createAudioStore({ caches: fakeCaches() });
  assert.equal(await store.put(KOKORO, 'A', { blob: mp3(10), provider: 'azure', fallback: true }), false);
  assert.equal(await store.put(KOKORO, 'B', { blob: mp3(0), provider: 'kokoro' }), false);
  assert.equal(await store.get(KOKORO, 'A'), null);
  assert.deepEqual(await store.usage(), { entries: 0, bytes: 0 });
});

test('least recently used entries are evicted above the size limit', async () => {
  let t = 0;
  const store = createAudioStore({ caches: fakeCaches(), maxBytes: 250, now: () => ++t });
  await store.put(KOKORO, 'one', { blob: mp3(100), provider: 'kokoro' });
  await store.put(KOKORO, 'two', { blob: mp3(100), provider: 'kokoro' });
  await store.get(KOKORO, 'one'); // "one" is now more recent than "two"
  await store.put(KOKORO, 'three', { blob: mp3(100), provider: 'kokoro' });

  assert.ok(await store.get(KOKORO, 'one'));
  assert.equal(await store.get(KOKORO, 'two'), null, 'least recently used: evicted');
  assert.ok(await store.get(KOKORO, 'three'));
  assert.deepEqual(await store.usage(), { entries: 2, bytes: 200 });
});

test('the LRU index survives a new store instance (offscreen document recreated)', async () => {
  const caches = fakeCaches();
  let t = 0;
  const first = createAudioStore({ caches, maxBytes: 250, now: () => ++t });
  await first.put(KOKORO, 'one', { blob: mp3(100), provider: 'kokoro' });
  await first.put(KOKORO, 'two', { blob: mp3(100), provider: 'kokoro' });
  await first.flush();

  const second = createAudioStore({ caches, maxBytes: 250, now: () => ++t + 100 });
  assert.deepEqual(await second.usage(), { entries: 2, bytes: 200 });
  await second.put(KOKORO, 'three', { blob: mp3(100), provider: 'kokoro' });
  assert.equal(await second.get(KOKORO, 'one'), null, 'oldest entry from the first instance evicted');
});

test('a missing index is rebuilt from the stored entries', async () => {
  const caches = fakeCaches();
  const first = createAudioStore({ caches });
  await first.put(KOKORO, 'one', { blob: mp3(64), provider: 'kokoro' });
  // No flush: the index was never written.
  const second = createAudioStore({ caches });
  assert.deepEqual(await second.usage(), { entries: 1, bytes: 64 });
});

test('clear() deletes the whole cache', async () => {
  const caches = fakeCaches();
  const store = createAudioStore({ caches });
  await store.put(KOKORO, 'one', { blob: mp3(10), provider: 'kokoro' });
  await store.clear();
  assert.equal(caches.stores.has(AUDIO_CACHE_NAME), false);
  assert.equal(await store.get(KOKORO, 'one'), null);
  assert.deepEqual(await store.usage(), { entries: 0, bytes: 0 });
});

test('a broken Cache Storage never throws from get/put', async () => {
  const broken = { open: async () => { throw new Error('SecurityError'); }, delete: async () => false };
  const store = createAudioStore({ caches: broken });
  assert.equal(await store.get(KOKORO, 'x'), null);
  assert.equal(await store.put(KOKORO, 'x', { blob: mp3(5), provider: 'kokoro' }), false);
});
