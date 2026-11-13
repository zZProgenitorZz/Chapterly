import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRestorePayload, createSessionStore, toPlayerSession } from '../src/shared/session-store.js';

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
  assert.deepEqual(payload.session.meta, { kind: 'chapter', extractorId: 'royalroad', url: stored.url });
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

test('restore: currentIndex is clamped to the chunk range', () => {
  assert.equal(buildRestorePayload({ ...session, currentIndex: 99 }, null, null, 'u').startIndex, 9);
});
