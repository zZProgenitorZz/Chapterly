import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioCache } from '../src/player/audio-cache.js';
import { BackendError } from '../src/player/tts-client.js';
import { controllableFetch, fakeUrls, flush } from './helpers/fakes.js';

const texts = (n) => Array.from({ length: n }, (_, i) => `chunk ${i}`);

function setup(n = 10, opts = {}) {
  const net = controllableFetch();
  const urls = fakeUrls();
  // prefetchMaxChunks: 2 keeps these tests on a small, fixed window; size-based tests below.
  const cache = new AudioCache({ fetchSpeech: net.fetchSpeech, texts: texts(n), urls, retryDelayMs: 0, prefetchMaxChunks: 2, ...opts });
  return { cache, net, urls };
}

test('prefetch window: current + 2 ahead, at most 2 requests in flight', async () => {
  const { cache, net } = setup();
  cache.setCurrent(0);
  await flush();
  assert.deepEqual(
    net.pending().map((r) => r.text),
    ['chunk 0', 'chunk 1'],
    'closest first, capped at 2',
  );
  assert.deepEqual(cache.indexes(), [0, 1, 2]);
  assert.equal(cache.state(2), 'queued');

  net.byText('chunk 0').resolve();
  await flush();
  assert.deepEqual(
    net.pending().map((r) => r.text),
    ['chunk 1', 'chunk 2'],
    'the third starts when a slot frees up',
  );
  assert.equal(cache.inFlight, 2);
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

test('moving forward keeps the previous chunk and revokes older ones', async () => {
  const { cache, net, urls } = setup();
  cache.setCurrent(0);
  for (let i = 0; i < 4; i++) {
    await flush();
    for (const r of net.pending()) r.resolve();
  }
  await flush();
  const url0 = (await cache.get(0)).url;
  const url1 = (await cache.get(1)).url;

  cache.setCurrent(1);
  assert.ok(urls.live.has(url0), 'chunk 0 is only 1 behind: kept');
  cache.setCurrent(2);
  assert.ok(!urls.live.has(url0), 'chunk 0 is 2 behind: revoked');
  assert.ok(urls.live.has(url1));
  assert.deepEqual(cache.indexes(), [1, 2, 3, 4]);
});

test('seeking aborts in-flight prefetches that are no longer needed', async () => {
  const { cache, net } = setup(20);
  cache.setCurrent(0);
  await flush();
  const [r0, r1] = net.pending();

  cache.setCurrent(10);
  await flush();
  assert.ok(r0.signal.aborted && r1.signal.aborted, 'old requests aborted');
  assert.deepEqual(
    net.pending().map((r) => r.text),
    ['chunk 10', 'chunk 11'],
  );
  assert.deepEqual(cache.indexes(), [10, 11, 12]);
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
  assert.equal(net.requests.filter((r) => r.text === 'chunk 0').length, 2, 'retried');
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

test('window: still at most 2 requests in flight, closest first', async () => {
  const { cache, net } = sized(Array(20).fill(50));
  cache.setCurrent(0);
  await flush();
  assert.equal(net.pending().length, 2);
  assert.deepEqual(
    net.pending().map((r) => r.text.split(':')[0]),
    ['0', '1'],
  );
});
