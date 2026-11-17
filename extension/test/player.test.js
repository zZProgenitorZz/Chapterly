import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, Status } from '../src/player/player.js';
import { BackendError } from '../src/player/tts-client.js';
import { FakeAudio, controllableFetch, fakeUrls, flush } from './helpers/fakes.js';

function setup(n = 5, playerOptions = {}) {
  const net = controllableFetch();
  const audios = [new FakeAudio(), new FakeAudio()];
  const urls = fakeUrls();
  const events = [];
  const player = new Player({ fetchSpeech: net.fetchSpeech, audios, urls, retryDelayMs: 0, prefetchMaxChunks: 2, onEvent: (e) => events.push(e), ...playerOptions });
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
    ['chunk 0', 'chunk 1'],
  );
  net.byText('chunk 0').resolve();
  await flush();
  const state = player.getState();
  assert.equal(state.status, Status.PLAYING);
  assert.equal(state.provider, 'azure');
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

test('seekToChunk aborts prefetches outside the new window', async () => {
  const { player, net } = setup(20);
  player.play();
  await flush();
  const [r0, r1] = net.pending();
  player.seekToChunk(10);
  await flush();
  assert.ok(r0.aborted && r1.aborted);
  assert.deepEqual(
    net.pending().map((r) => r.text),
    ['chunk 10', 'chunk 11'],
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
    [
      ['kokoro', 'af_heart'],
      ['kokoro', 'af_heart'],
    ],
  );
  // The backend fell back to Azure for chunk 0.
  net.byText('chunk 0').resolve('azure', { voice: 'en-US-BrianNeural', fallback: true });
  await flush();
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
    [
      ['chunk 1', 'azure', 'en-US-BrianNeural'],
      ['chunk 2', 'azure', 'en-US-BrianNeural'],
    ],
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
