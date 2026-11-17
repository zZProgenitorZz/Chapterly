import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_POSITIONS,
  buildRestorePayload,
  createPositionStore,
  createSessionStore,
  novelKey,
  resumeOffer,
  toPlayerSession,
} from '../src/shared/session-store.js';

/** In-memory stand-in for chrome.storage.session. */
function fakeArea() {
  const data = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
  };
}

const session = {
  sessionId: 's1',
  kind: 'chapter',
  tabId: 7,
  url: 'https://www.royalroad.com/fiction/1/chapter/2',
  title: 'Chapter 2',
  extractorId: 'royalroad',
  nextChapterUrl: 'https://www.royalroad.com/fiction/1/chapter/3',
  prevChapterUrl: null,
  chunks: Array.from({ length: 10 }, (_, i) => ({ index: i, text: `c${i}`, paragraphIndexes: [i] })),
  currentIndex: 0,
};

test('updatePosition stores currentIndex for the active session only', async () => {
  const store = createSessionStore(fakeArea());
  await store.saveActiveSession(session);
  await store.updatePosition('s1', 4);
  assert.equal((await store.getActiveSession()).currentIndex, 4);
  await store.updatePosition('other-session', 9);
  assert.equal((await store.getActiveSession()).currentIndex, 4);
});

test('concurrent position updates apply in order', async () => {
  const store = createSessionStore(fakeArea());
  await store.saveActiveSession(session);
  await Promise.all([1, 2, 3, 4, 5].map((i) => store.updatePosition('s1', i)));
  assert.equal((await store.getActiveSession()).currentIndex, 5);
});

test('restore: offscreen document was closed -> reload at currentIndex', () => {
  const stored = { ...session, currentIndex: 6 };
  const emptyPlayer = { status: 'idle', sessionId: null };
  const payload = buildRestorePayload(stored, emptyPlayer, null, 'http://localhost:8080');
  assert.equal(payload.startIndex, 6);
  assert.equal(payload.startTime, 0);
  assert.equal(payload.backendUrl, 'http://localhost:8080');
  assert.deepEqual(payload.session, toPlayerSession(stored));
  assert.deepEqual(payload.session.meta, { kind: 'chapter', extractorId: 'royalroad', url: stored.url, seriesTitle: null, nextChapterUrl: stored.nextChapterUrl });
});

test('restore: paused snapshot at the same chunk also restores the position', () => {
  const stored = { ...session, currentIndex: 6 };
  const snapshot = { sessionId: 's1', status: 'paused', index: 6, position: 4.2 };
  assert.equal(buildRestorePayload(stored, null, snapshot, 'u').startTime, 4.2);
  assert.equal(buildRestorePayload(stored, null, { ...snapshot, index: 5 }, 'u').startTime, 0);
});

test('restore: nothing to do when the player already has the session', () => {
  assert.equal(buildRestorePayload(session, { sessionId: 's1' }, null, 'u'), null);
  assert.equal(buildRestorePayload(null, null, null, 'u'), null);
});

test('restore: the payload carries the voice selection', () => {
  const voice = { provider: 'azure', voice: 'en-US-BrianNeural' };
  const payload = buildRestorePayload({ ...session, currentIndex: 3 }, null, null, 'http://localhost:8080', voice);
  assert.deepEqual(payload.voice, voice);
  assert.equal(payload.startIndex, 3);
});

test('restore: currentIndex is clamped to the chunk range', () => {
  assert.equal(buildRestorePayload({ ...session, currentIndex: 99 }, null, null, 'u').startIndex, 9);
});

// ---------- speed in the restore payload ----------

test('restore: the payload carries the playback rate', () => {
  const payload = buildRestorePayload({ ...session, currentIndex: 2 }, null, null, 'u', null, 1.4);
  assert.equal(payload.playbackRate, 1.4);
  assert.equal(buildRestorePayload({ ...session, currentIndex: 2 }, null, null, 'u').playbackRate, 1, 'default 1x');
});

// ---------- remembered positions ----------

function fakeLocalArea() {
  const data = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(key) {
      delete data[key];
    },
  };
}

test('novelKey: extractor + series when known, else the chapter URL', () => {
  assert.equal(novelKey({ extractorId: 'royalroad', seriesTitle: 'Mother of Learning', url: 'u1' }), 'royalroad:Mother of Learning');
  assert.equal(novelKey({ extractorId: 'generic', seriesTitle: null, url: 'https://x/ch-3' }), 'url:https://x/ch-3');
});

test('positions: save, match by exact chapter URL, one entry per novel', async () => {
  let t = 1000;
  const store = createPositionStore(fakeLocalArea(), { now: () => t++ });
  const ch2 = { ...session, url: 'https://rr/ch2', seriesTitle: 'Orchard' };
  const ch3 = { ...session, url: 'https://rr/ch3', seriesTitle: 'Orchard' };
  await store.save(ch2, { paragraphIndex: 7, chunkIndex: 9, paragraphCount: 40 });
  assert.equal((await store.findForUrl('https://rr/ch2')).paragraphIndex, 7);

  await store.save(ch3, { paragraphIndex: 3, chunkIndex: 3, paragraphCount: 50 });
  assert.equal(await store.findForUrl('https://rr/ch2'), null, 'the novel moved on to chapter 3');
  const p = await store.findForUrl('https://rr/ch3');
  assert.deepEqual(
    { url: p.url, seriesTitle: p.seriesTitle, paragraphIndex: p.paragraphIndex, chunkIndex: p.chunkIndex },
    { url: 'https://rr/ch3', seriesTitle: 'Orchard', paragraphIndex: 3, chunkIndex: 3 },
  );
  assert.equal(Object.keys(await store.getAll()).length, 1);
});

test('positions: keeps at most 200 entries, dropping the oldest', async () => {
  let t = 0;
  const store = createPositionStore(fakeLocalArea(), { now: () => ++t });
  for (let i = 0; i < 205; i++) {
    await store.save({ extractorId: 'generic', seriesTitle: null, url: `https://x/${i}` }, { paragraphIndex: 1, chunkIndex: 1 });
  }
  const all = await store.getAll();
  assert.equal(Object.keys(all).length, MAX_POSITIONS);
  assert.equal(await store.findForUrl('https://x/0'), null, 'oldest dropped');
  assert.ok(await store.findForUrl('https://x/204'));
});

test('positions: forget removes everything', async () => {
  const area = fakeLocalArea();
  const store = createPositionStore(area);
  await store.save({ ...session, url: 'https://x/1' }, { paragraphIndex: 4, chunkIndex: 4 });
  await store.forget();
  assert.deepEqual(await store.getAll(), {});
  assert.equal(area.data.positions, undefined);
});

test('resume is offered only in the middle of an unfinished chapter', () => {
  const at = (paragraphIndex, extra = {}) => ({ url: 'u', paragraphIndex, ...extra });
  assert.deepEqual(resumeOffer(at(12), 40), { paragraphIndex: 12, paragraphNumber: 13, paragraphCount: 40 });
  assert.equal(resumeOffer(at(0), 40), null, 'very start');
  assert.equal(resumeOffer(at(39), 40), null, 'last paragraph');
  assert.equal(resumeOffer(at(12, { finished: true }), 40), null, 'finished');
  assert.equal(resumeOffer(null, 40), null);
});
