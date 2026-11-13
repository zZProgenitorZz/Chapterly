import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, Status } from '../src/player/player.js';
import { BackendError } from '../src/player/tts-client.js';
import { FakeAudio, controllableFetch, fakeUrls, flush } from './helpers/fakes.js';

function setup(n = 5) {
  const net = controllableFetch();
  const audios = [new FakeAudio(), new FakeAudio()];
  const urls = fakeUrls();
  const events = [];
  const player = new Player({ fetchSpeech: net.fetchSpeech, audios, urls, retryDelayMs: 0, onEvent: (e) => events.push(e) });
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
  assert.deepEqual(events.find((e) => e.type === 'chunkStarted').data, { index: 0, paragraphIndexes: [0, 1] });
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
