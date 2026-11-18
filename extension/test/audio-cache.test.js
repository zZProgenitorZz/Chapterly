import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioCache } from '../src/player/audio-cache.js';
import { BackendError } from '../src/player/tts-client.js';
import { controllableFetch, fakeUrls, flush, memoryAudioStore } from './helpers/fakes.js';

const texts = (n) => Array.from({ length: n }, (_, i) => `chunk ${i}`);

function setup(n = 10, opts = {}) {
  const net = controllableFetch();
  const urls = fakeUrls();
  // prefetchMaxChunks: 2 keeps these tests on a small, fixed window; size-based tests below.
  const cache = new AudioCache({ fetchSpeech: net.fetchSpeech, texts: texts(n), urls, retryDelayMs: 0, prefetchMaxChunks: 2, ...opts });
  return { cache, net, urls };
}

const pendingTexts = (net) => net.pending().map((r) => r.text);

/** Resolves whatever is pending, a few rounds, so the window fills up. */
async function settle(net, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await flush();
    for (const r of net.pending()) r.resolve();
  }
  await flush();
}

test('the current chunk goes first; prefetches wait for it, then run one at a time', async () => {
  const { cache, net } = setup();
  cache.setCurrent(0);
  await flush();
  assert.deepEqual(pendingTexts(net), ['chunk 0'], 'only the chunk the listener waits for');
  assert.deepEqual(cache.indexes(), [0, 1, 2]);
  assert.equal(cache.state(1), 'queued');
  assert.equal(net.byText('chunk 0').priority, 'now');

  net.byText('chunk 0').resolve();
  await flush();
  assert.deepEqual(pendingTexts(net), ['chunk 1'], 'one prefetch at a time, closest first');
  assert.equal(net.byText('chunk 1').priority, 'prefetch');
  assert.equal(cache.inFlight, 1);

  net.byText('chunk 1').resolve();
  await flush();
  assert.deepEqual(pendingTexts(net), ['chunk 2']);
});

test('every request carries its own request id', async () => {
  const { cache, net } = setup();
  cache.setCurrent(0);
  await settle(net);
  const ids = net.requests.map((r) => r.requestId);
  assert.equal(ids.length, 3);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 10));
  assert.equal(new Set(ids).size, ids.length);
});

test('the current chunk is requested at once even with a prefetch in flight', async () => {
  const { cache, net } = setup(20);
  cache.setCurrent(0);
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  net.byText('chunk 1').resolve();
  await flush();
  const prefetch = net.byText('chunk 2');
  assert.equal(prefetch.priority, 'prefetch');
  assert.equal(cache.inFlight, 1, 'the prefetch slot (maxInFlight 1) is taken');

  cache.setCurrent(4); // chunk 2 is within 3 of the new window: it keeps loading
  await flush();
  assert.deepEqual(pendingTexts(net).sort(), ['chunk 2', 'chunk 4']);
  assert.equal(net.byText('chunk 4').priority, 'now');
  assert.ok(!prefetch.aborted);
});

test('get() resolves with an object URL and the provider', async () => {
  const { cache, net, urls } = setup();
  cache.setCurrent(0);
  const audio = cache.get(0);
  await flush();
  net.byText('chunk 0').resolve('azure');
  const { url, provider } = await audio;
  assert.equal(provider, 'azure');
  assert.ok(urls.live.has(url));
});

test('moving forward keeps a back buffer of 5 chunks and revokes older ones', async () => {
  const { cache, net, urls } = setup(20);
  const url = {};
  for (let i = 0; i <= 8; i++) {
    cache.setCurrent(i);
    await settle(net, 3);
    url[i] = (await cache.get(i)).url;
  }
  assert.deepEqual(cache.indexes(), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(!urls.live.has(url[2]), 'chunk 2 is 6 behind: revoked');
  for (const i of [3, 4, 5, 6, 7]) assert.ok(urls.live.has(url[i]), `chunk ${i} kept`);
});

test('the back buffer stops at 2000 characters, but always keeps the previous chunk', () => {
  const lengths = [900, 900, 900, 900, 900, 2500, 10];
  const cache = new AudioCache({ fetchSpeech: () => new Promise(() => {}), texts: lengths.map((n) => 'x'.repeat(n)), urls: fakeUrls() });
  assert.equal(cache.backStart(5), 3, '900 + 900 = 1800; one more would be 2700');
  assert.equal(cache.backStart(6), 5, 'the previous chunk alone is 2500: still kept');
  assert.equal(cache.backStart(0), 0, 'nothing behind the first chunk');
  const short = new AudioCache({ fetchSpeech: () => new Promise(() => {}), texts: texts(20), urls: fakeUrls() });
  assert.equal(short.backStart(10), 5, 'short chunks: 5 behind');
});

test('going back 3 chunks after playing forward is served from memory, no request', async () => {
  const { cache, net } = setup(20);
  for (let i = 0; i <= 6; i++) {
    cache.setCurrent(i);
    await settle(net, 3);
  }
  const before = net.requests.length;
  cache.setCurrent(3);
  assert.equal(cache.state(3), 'ready');
  await cache.get(3);
  await flush();
  assert.equal(net.requests.filter((r) => r.text === 'chunk 3').length, 1, 'chunk 3 was fetched once, on the way forward');
  assert.equal(net.requests.length, before, 'nothing new requested: 3..5 window and 6..8 are all ready');
});

test('after a backward seek, ready chunks up to windowEnd + 3 are kept', async () => {
  const { cache, net, urls } = setup(30);
  cache.setCurrent(10);
  await settle(net);
  const url12 = (await cache.get(12)).url;
  cache.setCurrent(6); // window 6..8; 12 is windowEnd + 4, 11 is + 3
  assert.ok(urls.live.has((await cache.get(11)).url) || cache.state(11) === 'ready');
  assert.equal(cache.state(11), 'ready');
  assert.ok(!urls.live.has(url12), 'beyond windowEnd + 3: revoked');
  assert.equal(cache.state(12), null);
});

test('seeking far away aborts in-flight prefetches; nearby ones keep loading', async () => {
  const { cache, net } = setup(30);
  cache.setCurrent(0);
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  const far = net.byText('chunk 1');

  cache.setCurrent(10);
  await flush();
  assert.ok(far.aborted, 'chunk 1 is more than 3 chunks outside 10..12: aborted');
  assert.deepEqual(pendingTexts(net), ['chunk 10'], 'prefetches wait for the new current chunk');
  assert.deepEqual(cache.indexes(), [10, 11, 12]);

  net.byText('chunk 10').resolve();
  await flush();
  const near = net.byText('chunk 11');
  cache.setCurrent(8); // window 8..10; 11 is just outside
  await flush();
  assert.ok(!near.aborted, 'chunk 11 is close to the window: it finishes');
  assert.deepEqual(pendingTexts(net).sort(), ['chunk 11', 'chunk 8']);
});

test('a dropped (aborted) entry does not cause unhandled rejections', async () => {
  const { cache } = setup();
  cache.setCurrent(0);
  cache.clear();
  await flush();
  assert.deepEqual(cache.indexes(), []);
});

test('a failed request is retried once', async () => {
  const { cache, net } = setup();
  const audio = cache.get(0);
  await flush();
  net.byText('chunk 0').reject(new BackendError('http://x', 503, 'QUOTA', 'quota'));
  await flush();
  const attempts = net.requests.filter((r) => r.text === 'chunk 0');
  assert.equal(attempts.length, 2, 'retried');
  assert.notEqual(attempts[0].requestId, attempts[1].requestId, 'the retry is a new request');
  net.byText('chunk 0').resolve();
  assert.equal((await audio).provider, 'azure');
});

test('a second failure rejects with the chunk index; get() then tries again', async () => {
  const { cache, net } = setup();
  const audio = cache.get(3);
  await flush();
  net.byText('chunk 3').reject(new BackendError('http://x', 502, 'UPSTREAM_ERROR', 'boom'));
  await flush();
  net.byText('chunk 3').reject(new BackendError('http://x', 502, 'UPSTREAM_ERROR', 'boom'));
  const err = await audio.catch((e) => e);
  assert.equal(err.chunkIndex, 3);
  assert.equal(err.reason, 'UPSTREAM_ERROR');
  assert.equal(cache.state(3), 'failed');

  const again = cache.get(3);
  await flush();
  net.byText('chunk 3').resolve();
  assert.equal((await again).provider, 'azure');
});

test('clear() revokes every URL and aborts every request', async () => {
  const { cache, net, urls } = setup();
  cache.setCurrent(0);
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  cache.clear();
  await flush();
  assert.equal(urls.live.size, 0);
  assert.ok(net.requests.filter((r) => !r.settled).every((r) => r.aborted));
});

test('clearExcept() keeps only a ready current chunk', async () => {
  const { cache, net, urls } = setup();
  cache.setCurrent(0);
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  const inFlight = net.byText('chunk 1');
  cache.clearExcept(0);
  await flush();
  assert.deepEqual(cache.indexes(), [0]);
  assert.equal(urls.live.size, 1);
  assert.ok(inFlight.aborted, 'the prefetch was cancelled');
});

// ---------- persistent audio store ----------

test('a chunk in the persistent store is served without a request', async () => {
  const store = memoryAudioStore();
  await store.put(null, 'chunk 0', { blob: new Blob(['stored']), provider: 'kokoro', voice: 'af_heart' });
  const { cache, net } = setup(3, {
    persistent: { lookup: (text) => store.get(null, text), save: (text, r) => store.put(null, text, r) },
  });
  cache.setCurrent(0);
  const audio = await cache.get(0);
  assert.equal(audio.provider, 'kokoro');
  assert.equal(audio.voice, 'af_heart');
  assert.equal(net.requests.filter((r) => r.text === 'chunk 0').length, 0);
});

test('fetched audio is written to the persistent store, fallback audio is not', async () => {
  const store = memoryAudioStore();
  const { cache, net } = setup(3, {
    persistent: { lookup: (text) => store.get(null, text), save: (text, r) => store.put(null, text, r) },
  });
  cache.setCurrent(0);
  await flush();
  net.byText('chunk 0').resolve('kokoro');
  await flush();
  net.byText('chunk 1').resolve('azure', { fallback: true });
  await flush();
  assert.ok(await store.get(null, 'chunk 0'));
  assert.equal(await store.get(null, 'chunk 1'), null, 'fallback audio is not stored');
});

test('a failing persistent store never breaks playback', async () => {
  const { cache, net } = setup(3, {
    persistent: { lookup: async () => { throw new Error('quota'); }, save: () => { throw new Error('quota'); } },
  });
  cache.setCurrent(0);
  const audio = cache.get(0);
  await flush();
  net.byText('chunk 0').resolve();
  assert.ok((await audio).url);
});

// ---------- size-based window (defaults: 1500 chars or 6 chunks past the current one) ----------

function sized(lengths, opts = {}) {
  const net = controllableFetch();
  const cache = new AudioCache({ fetchSpeech: net.fetchSpeech, texts: lengths.map((n, i) => `${i}:`.padEnd(n, 'x')), urls: fakeUrls(), retryDelayMs: 0, ...opts });
  return { cache, net };
}

test('window: short chunks -> 6 chunks ahead', () => {
  const { cache } = sized(Array(20).fill(50));
  cache.setCurrent(0);
  assert.deepEqual(cache.indexes(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(cache.windowEnd(10), 16);
});

test('window: long chunks -> until at least 1500 characters are queued ahead', () => {
  const { cache } = sized(Array(20).fill(600));
  cache.setCurrent(0);
  assert.deepEqual(cache.indexes(), [0, 1, 2, 3], '600+600 < 1500, +600 = 1800 >= 1500');
});

test('window: mixed lengths stop at whichever limit comes first, and at the end of the session', () => {
  const { cache } = sized([10, 1400, 50, 50, 50, 50, 50, 50]);
  assert.equal(cache.windowEnd(0), 3, '1400, +50 = 1450 < 1500, +50 = 1500 -> stop');
  assert.equal(cache.windowEnd(5), 7, 'only 2 chunks left');
  assert.equal(cache.windowEnd(7), 7);
});

test('window: the whole window is fetched, one prefetch at a time, closest first', async () => {
  const { cache, net } = sized(Array(20).fill(50));
  cache.setCurrent(0);
  const order = [];
  for (let i = 0; i < 8; i++) {
    await flush();
    assert.ok(net.pending().length <= 1);
    for (const r of net.pending()) {
      order.push(r.text.split(':')[0]);
      r.resolve();
    }
  }
  assert.deepEqual(order, ['0', '1', '2', '3', '4', '5', '6']);
});
