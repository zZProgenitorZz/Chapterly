import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, Status } from '../src/player/player.js';
import { BackendError } from '../src/player/tts-client.js';
import { FakeAudio, controllableFetch, fakeUrls, flush, manualTimers, memoryAudioStore } from './helpers/fakes.js';

function setup(n = 5, playerOptions = {}) {
  const net = controllableFetch();
  const audios = [new FakeAudio(), new FakeAudio()];
  const urls = fakeUrls();
  const events = [];
  const player = new Player({ fetchSpeech: net.fetchSpeech, audios, urls, retryDelayMs: 0, prefetchMaxChunks: 2, seekDebounceMs: 0, onEvent: (e) => events.push(e), ...playerOptions });
  const session = {
    sessionId: 's1',
    title: 'Chapter',
    chunks: Array.from({ length: n }, (_, i) => ({ index: i, text: `chunk ${i}`, paragraphIndexes: [i * 2, i * 2 + 1] })),
  };
  player.load(session);
  const playing = () => audios.filter((a) => !a.paused);
  const resolveAll = async () => {
    for (let i = 0; i < 4; i++) {
      await flush();
      for (const r of net.pending()) r.resolve();
    }
    await flush();
  };
  return { player, net, audios, urls, events, playing, resolveAll };
}

test('starts with chunk 0 and prefetches the next ones', async () => {
  const { player, net, events } = setup();
  player.play();
  assert.equal(player.getState().status, Status.LOADING);
  await flush();
  assert.deepEqual(
    net.pending().map((r) => r.text),
    ['chunk 0'],
    'prefetches wait until the first chunk is ready',
  );
  net.byText('chunk 0').resolve();
  await flush();
  const state = player.getState();
  assert.equal(state.status, Status.PLAYING);
  assert.equal(state.provider, 'azure');
  assert.deepEqual(
    net.pending().map((r) => r.text),
    ['chunk 1'],
  );
  const started = events.find((e) => e.type === 'chunkStarted').data;
  assert.equal(started.index, 0);
  assert.deepEqual(started.paragraphIndexes, [0, 1]);
});

test('gapless: the next chunk is preloaded and starts synchronously on "ended"', async () => {
  const { player, audios, resolveAll, playing } = setup();
  player.play();
  await resolveAll();
  const [a, b] = audios;
  assert.ok(!a.paused && a.src, 'A plays chunk 0');
  assert.ok(b.paused && b.src, 'B already holds chunk 1');

  a.finish(); // no await: B must be playing immediately
  assert.equal(b.paused, false);
  assert.equal(player.getState().index, 1);
  assert.equal(player.getState().status, Status.PLAYING);
  assert.deepEqual(playing(), [b], 'exactly one element plays');

  await flush();
  assert.ok(a.src, 'A was reloaded with chunk 2');
  b.finish();
  assert.equal(a.paused, false);
  assert.equal(player.getState().index, 2);
});

test('buffering when the next chunk is not ready, then continues', async () => {
  const { player, net, audios, events } = setup();
  player.play();
  await flush();
  net.byText('chunk 0').resolve();
  await flush();

  audios[0].finish();
  assert.equal(player.getState().status, Status.BUFFERING);
  assert.ok(events.some((e) => e.type === 'buffering' && e.data.index === 1));

  net.byText('chunk 1').resolve();
  await flush();
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(player.getState().index, 1);
});

test('finishing the last chunk emits sessionFinished and frees every URL', async () => {
  const { player, audios, events, urls, resolveAll } = setup(2);
  player.play();
  await resolveAll();
  audios[0].finish();
  await resolveAll();
  audios[1].finish();
  assert.equal(player.getState().status, Status.IDLE);
  assert.deepEqual(events.at(-1), { type: 'sessionFinished', data: { sessionId: 's1' }, state: player.getState() });
  assert.equal(urls.live.size, 0);
});

test('a chunk failing twice stops with an error naming the chunk; play() resumes there', async () => {
  const { player, net, audios } = setup();
  player.play();
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  net.byText('chunk 1').resolve();
  await flush();
  audios[0].finish(); // -> chunk 1 (preloaded)
  await flush();
  // chunk 2 is being prefetched: fail it twice (retry after delay)
  net.byText('chunk 2').reject(new BackendError('http://x', 503, 'QUOTA', 'q'));
  await flush();
  net.byText('chunk 2').reject(new BackendError('http://x', 503, 'QUOTA', 'q'));
  await flush();
  assert.equal(player.getState().status, Status.PLAYING, 'a prefetch failure does not interrupt chunk 1');

  audios[1].finish();
  await flush();
  const state = player.getState();
  assert.equal(state.status, Status.ERROR);
  assert.equal(state.index, 2);
  assert.equal(state.error.chunkIndex, 2);
  assert.equal(state.error.reason, 'QUOTA');
  assert.equal(audios.filter((a) => !a.paused).length, 0);

  player.play();
  await flush();
  net.byText('chunk 2').resolve();
  await flush();
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(player.getState().index, 2);
});

test('next/previous/stop during an in-flight prefetch: no stray audio', async () => {
  const { player, net, audios, playing } = setup(6);
  player.play();
  await flush();
  const first = net.byText('chunk 0');

  player.next(); // while chunk 0 is still loading
  await flush();
  assert.ok(first.aborted || first.settled === false, 'chunk 0 request is no longer needed');
  first.resolve?.(); // late response must be ignored
  await flush();
  assert.equal(player.getState().index, 1);
  assert.equal(playing().length, 0);

  net.byText('chunk 1').resolve();
  await flush();
  assert.deepEqual(playing().length, 1);

  player.stop();
  await flush();
  for (const r of net.pending()) r.resolve(); // late responses after stop
  await flush();
  assert.equal(playing().length, 0);
  assert.equal(player.getState().status, Status.IDLE);
  assert.ok(audios.every((a) => !a.src));
});

test('seekToChunk aborts prefetches far outside the new window; the target goes first', async () => {
  const { player, net } = setup(20);
  player.play();
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  const prefetch = net.byText('chunk 1');
  player.seekToChunk(10);
  await flush();
  assert.ok(prefetch.aborted);
  assert.deepEqual(
    net.pending().map((r) => [r.text, r.priority]),
    [['chunk 10', 'now']],
  );
});

test('previous(): restarts the chunk after 3 s, else goes back one', async () => {
  const { player, audios, resolveAll } = setup();
  player.play();
  await resolveAll();
  audios[0].finish();
  await resolveAll(); // now on chunk 1 in element B
  const b = audios[1];

  b.currentTime = 5;
  player.previous();
  assert.equal(player.getState().index, 1);
  assert.equal(b.currentTime, 0);

  b.currentTime = 1;
  player.previous();
  await resolveAll();
  assert.equal(player.getState().index, 0);
  assert.equal(player.getState().status, Status.PLAYING);
});

test('pause and resume keep the current chunk without refetching', async () => {
  const { player, net, audios, resolveAll } = setup();
  player.play();
  await resolveAll();
  const before = net.requests.length;
  player.pause();
  assert.equal(player.getState().status, Status.PAUSED);
  assert.ok(audios.every((a) => a.paused));
  player.play();
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(net.requests.length, before);
});

test('pause while loading: audio arrives but does not start until play()', async () => {
  const { player, net, playing } = setup();
  player.play();
  player.pause();
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  assert.equal(player.getState().status, Status.PAUSED);
  assert.equal(playing().length, 0);
  player.play();
  assert.equal(playing().length, 1);
});

test('playbackRate applies to both elements, also after loading new chunks', async () => {
  const { player, audios, resolveAll } = setup();
  player.playbackRate = 1.5;
  player.play();
  await resolveAll();
  assert.ok(audios.every((a) => a.playbackRate === 1.5 && a.defaultPlaybackRate === 1.5));
  assert.equal(player.getState().playbackRate, 1.5);
});

test('load() can start mid-session at a saved position', async () => {
  const { player, net, audios } = setup(5);
  player.load({ sessionId: 's2', chunks: [0, 1, 2, 3, 4].map((i) => ({ index: i, text: `c${i}` })), startIndex: 3, startTime: 12.5 });
  player.play();
  await flush();
  net.byText('c3').resolve();
  await flush();
  assert.equal(player.getState().index, 3);
  assert.equal(audios.find((a) => !a.paused).currentTime, 12.5);
});

// ---------- voice selection (step 4) ----------

const KOKORO = { provider: 'kokoro', voice: 'af_heart' };
const AZURE = { provider: 'azure', voice: 'en-US-BrianNeural' };

function setupWithVoice(selection, n = 5) {
  const ctx = setup(n);
  ctx.player.load({
    sessionId: 'v1',
    title: 'Voices',
    chunks: Array.from({ length: n }, (_, i) => ({ index: i, text: `chunk ${i}`, paragraphIndexes: [i] })),
    voice: selection,
  });
  return ctx;
}

test('requests carry the voice selection; state reports voice and fallback', async () => {
  const { player, net } = setupWithVoice(KOKORO);
  player.play();
  await flush();
  assert.deepEqual(
    net.pending().map((r) => [r.askedProvider, r.askedVoice]),
    [['kokoro', 'af_heart']],
  );
  // The backend fell back to Azure for chunk 0.
  net.byText('chunk 0').resolve('azure', { voice: 'en-US-BrianNeural', fallback: true });
  await flush();
  assert.deepEqual(
    net.pending().map((r) => [r.text, r.askedProvider, r.askedVoice]),
    [['chunk 1', 'kokoro', 'af_heart']],
    'prefetches ask for the selected voice too',
  );
  const state = player.getState();
  assert.equal(state.provider, 'azure');
  assert.equal(state.voice, 'en-US-BrianNeural');
  assert.equal(state.fallback, true);
  assert.deepEqual(state.selection, KOKORO);
});

test('setVoice while playing: drops prefetched audio, restarts the current chunk in the new voice', async () => {
  const { player, net, audios, urls, playing, resolveAll } = setupWithVoice(KOKORO);
  player.play();
  await resolveAll();
  audios[0].finish(); // now on chunk 1, chunk 2 prefetched/in flight with Kokoro
  await resolveAll();
  assert.equal(player.getState().index, 1);
  const kokoroUrls = new Set(urls.live);
  assert.ok(kokoroUrls.size > 0);

  player.setVoice(AZURE);
  assert.equal(playing().length, 0, 'old audio stops immediately');
  assert.ok([...kokoroUrls].every((u) => !urls.live.has(u)), 'old-voice audio is revoked');
  assert.equal(player.getState().status, Status.LOADING);
  assert.equal(player.getState().index, 1, 'same chunk');

  await flush();
  assert.deepEqual(
    net.pending().map((r) => [r.text, r.askedProvider, r.askedVoice]),
    [['chunk 1', 'azure', 'en-US-BrianNeural']],
  );
  net.byText('chunk 1').resolve();
  await flush();
  assert.deepEqual(
    net.pending().map((r) => [r.text, r.askedProvider, r.askedVoice]),
    [['chunk 2', 'azure', 'en-US-BrianNeural']],
  );
  await resolveAll();
  const state = player.getState();
  assert.equal(state.status, Status.PLAYING);
  assert.equal(state.index, 1);
  assert.equal(state.voice, 'en-US-BrianNeural');
  assert.equal(state.position, 0, 'chunk restarts from the beginning');
  assert.equal(playing().length, 1, 'exactly one element plays');
});

test('setVoice while paused stays paused, with the new voice loaded', async () => {
  const { player, net, playing, resolveAll } = setupWithVoice(KOKORO);
  player.play();
  await resolveAll();
  player.pause();

  player.setVoice(AZURE);
  await flush();
  assert.equal(net.byText('chunk 0').askedVoice, 'en-US-BrianNeural');
  await resolveAll();
  assert.equal(player.getState().status, Status.PAUSED);
  assert.equal(playing().length, 0);

  player.play();
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(player.getState().voice, 'en-US-BrianNeural');
});

test('setVoice while loading: the late old-voice response is ignored', async () => {
  const { player, net, playing } = setupWithVoice(KOKORO);
  player.play();
  await flush();
  const oldRequest = net.byText('chunk 0');

  player.setVoice(AZURE);
  await flush();
  assert.ok(oldRequest.aborted, 'old request aborted');
  oldRequest.resolve('kokoro'); // arrives anyway
  await flush();
  assert.equal(playing().length, 0);

  net.byText('chunk 0').resolve();
  await flush();
  assert.equal(player.getState().voice, 'en-US-BrianNeural');
  assert.equal(playing().length, 1);
});

test('setVoice when idle only stores the selection; the same voice twice is a no-op', async () => {
  const { player, net } = setupWithVoice(KOKORO);
  player.setVoice(AZURE);
  await flush();
  assert.equal(net.requests.length, 0);
  assert.equal(player.getState().status, Status.IDLE);
  player.play();
  await flush();
  assert.equal(net.byText('chunk 0').askedProvider, 'azure');

  const before = net.requests.length;
  player.setVoice({ ...AZURE });
  await flush();
  assert.equal(net.requests.length, before, 'no restart for an unchanged voice');
});

// ---------- paragraph-aligned skipping ----------

/** Chunks: p0 (1 part), p1 (3 parts), p2 (1), p3 (1). */
function paragraphSession(player) {
  const parts = [
    [0, 0, 1],
    [1, 0, 3],
    [1, 1, 3],
    [1, 2, 3],
    [2, 0, 1],
    [3, 0, 1],
  ];
  player.load({
    sessionId: 'p',
    chunks: parts.map(([p, part, n], i) => ({ index: i, text: `chunk ${i}`, paragraphIndexes: [p], paragraphIndex: p, part, parts: n })),
  });
}

test('nextParagraph skips the remaining parts of the current paragraph', async () => {
  const { player, resolveAll } = setup(1, { prefetchMaxChunks: 6 });
  paragraphSession(player);
  player.seekToChunk(1);
  player.play();
  await resolveAll();
  assert.equal(player.getState().index, 1);
  player.nextParagraph();
  await resolveAll();
  assert.equal(player.getState().index, 4);
  assert.equal(player.getState().paragraphIndex, 2);
  assert.equal(player.getState().status, Status.PLAYING);
  player.nextParagraph();
  player.nextParagraph(); // already in the last paragraph: no-op
  await resolveAll();
  assert.equal(player.getState().index, 5);
});

test('previousParagraph: to the start of the current paragraph first, then the previous one', async () => {
  const { player, resolveAll } = setup(1, { prefetchMaxChunks: 6 });
  paragraphSession(player);
  player.seekToChunk(3); // p1, part 3/3
  player.play();
  await resolveAll();
  player.previousParagraph();
  await resolveAll();
  assert.equal(player.getState().index, 1, 'start of p1');
  player.previousParagraph();
  await resolveAll();
  assert.equal(player.getState().index, 0, 'p0');
});

test('a prefetched target plays immediately (no new request)', async () => {
  const { player, net, playing, resolveAll } = setup(6, { prefetchMaxChunks: 6 });
  player.play();
  await resolveAll();
  const requests = net.requests.length;
  player.next();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.getState().index, 1);
  assert.equal(player.getState().status, Status.PLAYING, 'playing within microtasks, no network wait');
  assert.equal(playing().length, 1);
  assert.equal(net.requests.length, requests, 'served from the cache');
});

test('five quick next() calls: lands on +5, exactly one element plays, no stale audio', async () => {
  const { player, net, audios, playing, resolveAll, events } = setup(12, { prefetchMaxChunks: 6 });
  player.play();
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  for (let i = 0; i < 5; i++) player.next(); // chunks 1..4 partly still in flight
  await resolveAll();
  await resolveAll();
  const state = player.getState();
  assert.equal(state.index, 5);
  assert.equal(state.status, Status.PLAYING);
  assert.deepEqual(playing().length, 1);
  const active = playing()[0];
  assert.match(active.src, /^blob:/);
  // Only chunk 0 and the final target ever started; the skipped ones never played.
  assert.deepEqual(
    events.filter((e) => e.type === 'chunkStarted').map((e) => e.data.index),
    [0, 5],
  );
  assert.ok(audios.every((a) => a === active || a.paused));
});

// ---------- speed ----------

test('playbackRate applies to both elements with preservesPitch, and survives new chunks', async () => {
  const { player, audios, resolveAll } = setup(4);
  assert.ok(audios.every((a) => a.preservesPitch === true));
  player.playbackRate = 1.3;
  player.play();
  await resolveAll();
  audios[0].finish();
  await resolveAll();
  assert.ok(audios.every((a) => a.playbackRate === 1.3 && a.defaultPlaybackRate === 1.3));
  assert.equal(player.getState().playbackRate, 1.3);
});

// ---------- seeking: debounce, back buffer, highlight while paused ----------

function debounced(n = 20, extra = {}) {
  const timers = manualTimers();
  const ctx = setup(n, { seekDebounceMs: 200, timers, prefetchMaxChunks: 2, ...extra });
  return { ...ctx, timers };
}

const requestsFor = (net, i) => net.requests.filter((r) => r.text === `chunk ${i}`).length;

test('five quick previous() calls request only the final chunk', async () => {
  const { player, net, events, playing, timers } = debounced(20);
  player.seekToChunk(10); // idle: just moves the index
  player.play();
  await flush();
  net.byText('chunk 10').resolve();
  await flush();
  assert.equal(player.getState().status, Status.PLAYING);

  for (let i = 0; i < 5; i++) player.previous();
  await flush();
  assert.equal(player.getState().index, 5, 'the index moves at once');
  assert.equal(player.getState().status, Status.LOADING);
  assert.equal(playing().length, 0, 'the old chunk stopped');
  assert.deepEqual(
    events.filter((e) => e.type === 'chunkSelected').map((e) => e.data.index),
    [9, 8, 7, 6, 5],
    'the highlight follows every press',
  );
  for (const i of [5, 6, 7, 8, 9]) assert.equal(requestsFor(net, i), 0, `nothing requested for chunk ${i} yet`);
  assert.equal(timers.size, 1, 'one pending seek');

  timers.tick(); // 200 ms without another seek
  await flush();
  assert.deepEqual(
    net.pending().map((r) => [r.text, r.priority]),
    [['chunk 5', 'now']],
  );
  for (const i of [6, 7, 8, 9]) assert.equal(requestsFor(net, i), 0, `chunk ${i} never requested`);
  net.byText('chunk 5').resolve();
  await flush();
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(player.getState().index, 5);
  assert.equal(playing().length, 1);
});

test('a ready target plays at once, without waiting for the debounce', async () => {
  const { player, net, playing, timers, resolveAll } = debounced(6, { prefetchMaxChunks: 6 });
  player.play();
  await resolveAll();
  const requests = net.requests.length;
  player.next();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.size, 0, 'no debounce for a cached chunk');
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(playing().length, 1);
  assert.equal(net.requests.length, requests);
});

test('going back 3 chunks after playing forward plays from memory, no request', async () => {
  const { player, net, audios, playing, timers, resolveAll } = debounced(12);
  player.play();
  await resolveAll();
  for (let i = 0; i < 6; i++) {
    audios.find((a) => !a.paused).finish();
    await resolveAll();
  }
  assert.equal(player.getState().index, 6);
  const before = net.requests.length;

  player.previous();
  player.previous();
  player.previous();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.getState().index, 3);
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(playing().length, 1);
  assert.equal(timers.size, 0);
  await flush();
  assert.equal(net.requests.length, before, 'chunks 3..5 came from the back buffer');
});

test('while paused, seeking moves the highlight and stays paused', async () => {
  const { player, events, playing, timers, resolveAll } = debounced(10);
  player.play();
  await resolveAll();
  player.pause();
  player.next();
  player.next();
  const selected = events.filter((e) => e.type === 'chunkSelected');
  assert.deepEqual(
    selected.map((e) => e.data.index),
    [1, 2],
  );
  assert.deepEqual(selected.at(-1).data.paragraphIndexes, [4, 5]);
  assert.equal(selected.at(-1).state.status, Status.PAUSED);
  timers.tick();
  await resolveAll();
  assert.equal(player.getState().status, Status.PAUSED);
  assert.equal(player.getState().index, 2);
  assert.equal(playing().length, 0);
  assert.ok(!events.some((e) => e.type === 'chunkStarted' && e.data.index === 2));

  player.play();
  assert.equal(player.getState().status, Status.PLAYING);
});

test('stop() cancels a pending seek', async () => {
  const { player, net, timers, resolveAll } = debounced(10);
  player.play();
  await resolveAll();
  player.seekToChunk(8);
  player.stop();
  assert.equal(timers.size, 0);
  const before = net.requests.length;
  timers.tick();
  await flush();
  assert.equal(net.requests.length, before);
});

test('the current chunk is requested even while a prefetch is in flight', async () => {
  const { player, net } = setup(20);
  player.play();
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  const prefetch = net.byText('chunk 1');
  assert.equal(prefetch.priority, 'prefetch');
  player.seekToChunk(3);
  await flush();
  assert.ok(!prefetch.aborted, 'close to the new window: it finishes');
  assert.deepEqual(
    net.pending().map((r) => [r.text, r.priority]).sort(),
    [
      ['chunk 1', 'prefetch'],
      ['chunk 3', 'now'],
    ],
  );
});

// ---------- restore after a long pause, prepared chapters ----------

const numbered = (n) => Array.from({ length: n }, (_, i) => ({ index: i, text: `c${i}`, paragraphIndexes: [i] }));

test('load({paused}) restores the chunk at its position without playing', async () => {
  const { player, net, audios, playing } = setup(6);
  player.load({ sessionId: 'r', chunks: numbered(6), startIndex: 3, startTime: 7.5, paused: true });
  assert.equal(player.getState().status, Status.PAUSED);
  await flush();
  assert.equal(net.byText('c3').priority, 'now');
  net.byText('c3').resolve();
  await flush();
  assert.equal(player.getState().status, Status.PAUSED);
  assert.equal(playing().length, 0);
  assert.equal(audios.find((a) => a.src).currentTime, 7.5);

  player.play();
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(playing()[0].currentTime, 7.5, 'continues from the stored spot');
});

test('restored paused: next() moves the highlight and stays paused', async () => {
  const { player, net, playing, events } = setup(6);
  player.load({ sessionId: 'r', chunks: numbered(6), startIndex: 2, paused: true });
  await flush();
  net.byText('c2').resolve();
  await flush();
  player.next();
  assert.equal(player.getState().index, 3);
  assert.equal(player.getState().status, Status.PAUSED);
  const selected = events.findLast((e) => e.type === 'chunkSelected');
  assert.equal(selected.data.index, 3);
  await flush();
  net.byText('c3').resolve();
  await flush();
  assert.equal(playing().length, 0);
});

test('a restored chunk comes from the persistent store: no request', async () => {
  const store = memoryAudioStore();
  await store.put(null, 'c2', { blob: new Blob(['x']), provider: 'kokoro', voice: 'af_heart' });
  const { player, net } = setup(1, { audioStore: store });
  player.load({ sessionId: 'r', chunks: numbered(3), startIndex: 2, paused: true });
  await flush();
  assert.equal(net.requests.filter((r) => r.text === 'c2').length, 0);
  player.play();
  assert.equal(player.getState().status, Status.PLAYING);
  assert.equal(player.getState().voice, 'af_heart');
});

test('fetched chunks are written to the persistent store under the selected voice', async () => {
  const store = memoryAudioStore();
  const { player, resolveAll } = setup(3, { audioStore: store });
  player.load({ sessionId: 'v', chunks: numbered(3), voice: { provider: 'kokoro', voice: 'af_heart' } });
  player.play();
  await resolveAll();
  assert.ok(await store.get({ provider: 'kokoro', voice: 'af_heart' }, 'c0'));
  assert.equal(await store.get(null, 'c0'), null, 'keyed by voice');
});

test('a prepared session is reused by load() of the same session: no second request', async () => {
  const { player, net, playing } = setup(1);
  const session = { sessionId: 'prep', chunks: numbered(3) };
  player.load({ ...session, prepared: true });
  assert.equal(player.getState().prepared, true);
  await flush();
  net.byText('c0').resolve();
  await flush();
  assert.equal(player.getState().status, Status.PAUSED);
  assert.equal(playing().length, 0);

  player.load({ ...session, startIndex: 0 });
  assert.equal(player.getState().prepared, false);
  player.play();
  assert.equal(player.getState().status, Status.PLAYING, 'the prepared audio plays at once');
  assert.equal(net.requests.filter((r) => r.text === 'c0').length, 1);
});

test('a prepared session is not reused for another chunk; unload() forgets it', async () => {
  const { player } = setup(1);
  const chunks = numbered(3);
  player.load({ sessionId: 'prep', chunks, prepared: true });
  await flush();
  player.load({ sessionId: 'prep', chunks, startIndex: 2 });
  assert.equal(player.getState().index, 2);
  assert.equal(player.getState().status, Status.IDLE, 'a normal load');
  player.load({ sessionId: 'prep', chunks, prepared: true });
  player.unload();
  assert.equal(player.getState().sessionId, null);
  assert.equal(player.getState().prepared, false);
});

test('dropPrefetches() cancels prefetches but keeps the current chunk; resume refills', async () => {
  const { player, net, playing } = setup(10);
  player.play();
  await flush();
  net.byText('chunk 0').resolve();
  await flush();
  const prefetch = net.byText('chunk 1');
  player.pause();
  player.dropPrefetches();
  await flush();
  assert.ok(prefetch.aborted);
  assert.equal(net.pending().length, 0);

  player.play();
  assert.equal(playing().length, 1, 'the current chunk was kept');
  await flush();
  assert.deepEqual(
    net.pending().map((r) => r.text),
    ['chunk 1'],
    'the window is requested again',
  );
});
