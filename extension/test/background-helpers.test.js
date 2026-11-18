import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSerialQueue } from '../src/shared/serial.js';
import { contentScriptsPresent, ensureContentScripts } from '../src/background/inject.js';
import { PREPARED_TTL_MS, isHttpUrl, isNavigationAway, isSessionFor, stripHash, usablePrepared } from '../src/background/navigation.js';
import { flush } from './helpers/fakes.js';

// ---------- serial queue (service worker commands) ----------

test('serial queue: tasks run one at a time, in order', async () => {
  const serial = createSerialQueue();
  const log = [];
  let running = 0;
  let maxRunning = 0;
  const task = (name, ms) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    log.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end ${name}`);
    running--;
    return name;
  };
  const results = await Promise.all([serial(task('a', 10)), serial(task('b', 1)), serial(task('c', 5))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(maxRunning, 1);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('serial queue: a failing task rejects alone and does not block the next', async () => {
  const serial = createSerialQueue();
  const failed = serial(async () => {
    throw new Error('boom');
  });
  const next = serial(async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
  assert.equal(serial.pending, 0);
});

test('serial queue: concurrent restore requests restore once', async () => {
  // Models handleCommand after a long pause: every command checks the player first.
  const serial = createSerialQueue();
  let playerSession = null;
  let restores = 0;
  const ensurePlayerSession = async () => {
    await flush(1); // GET_STATE round trip
    if (playerSession === 's1') return;
    restores++;
    await flush(1); // storage reads + PLAYER_LOAD
    playerSession = 's1';
  };
  await Promise.all(['toggle', 'next', 'next', 'previous'].map(() => serial(ensurePlayerSession)));
  assert.equal(restores, 1);
});

// ---------- content-script injection ----------

function fakeScripting({ present = false, failProbe = false } = {}) {
  const calls = [];
  return {
    calls,
    async executeScript(details) {
      calls.push(details.files ? 'inject' : 'func');
      if (details.func) {
        if (failProbe) throw new Error('Cannot access contents of the page');
        return [{ result: present }];
      }
      present = true;
      return [{}];
    },
  };
}

test('content scripts are injected only when missing', async () => {
  const scripting = fakeScripting({ present: false });
  assert.equal(await ensureContentScripts(scripting, 7, ['a.js']), true);
  assert.deepEqual(scripting.calls, ['func', 'inject']);

  assert.equal(await ensureContentScripts(scripting, 7, ['a.js']), false, 'second time: already there');
  assert.deepEqual(scripting.calls, ['func', 'inject', 'func']);
});

test('a probe that fails counts as "not present" (the injection then reports the real error)', async () => {
  assert.equal(await contentScriptsPresent(fakeScripting({ failProbe: true }), 1), false);
});

// ---------- tab navigation and prepared chapters ----------

const session = { kind: 'chapter', tabId: 7, url: 'https://rr.test/fiction/1/chapter/2' };

test('navigation away: another page in the session tab, not a #hash change or another tab', () => {
  assert.equal(isNavigationAway(session, 7, 'https://rr.test/fiction/1/chapter/3'), true);
  assert.equal(isNavigationAway(session, 7, 'https://rr.test/fiction/1/chapter/2#comments'), false);
  assert.equal(isNavigationAway(session, 8, 'https://rr.test/other'), false);
  assert.equal(isNavigationAway({ ...session, kind: 'selection' }, 7, 'https://x.test/'), false);
  assert.equal(isNavigationAway(null, 7, 'https://x.test/'), false);
});

test('isSessionFor / stripHash / isHttpUrl', () => {
  assert.equal(isSessionFor(session, 7, `${session.url}#top`), true);
  assert.equal(isSessionFor(session, 7, 'https://rr.test/fiction/1/chapter/3'), false);
  assert.equal(stripHash('https://a/b#c'), 'https://a/b');
  assert.equal(isHttpUrl('https://a/'), true);
  assert.equal(isHttpUrl('chrome://extensions'), false);
  assert.equal(isHttpUrl(undefined), false);
});

test('a prepared chapter is reused only for the same tab and page within 2 minutes', () => {
  const prepared = { tabId: 7, url: session.url, preparedAt: 1000, doc: { url: session.url }, session: { sessionId: 'p' } };
  assert.equal(usablePrepared(prepared, { tabId: 7, url: session.url, now: 1000 + 60_000 }), prepared);
  assert.equal(usablePrepared(prepared, { tabId: 7, url: `${session.url}#x`, now: 2000 }), prepared, 'hash ignored');
  assert.equal(usablePrepared(prepared, { tabId: 7, url: session.url, now: 1000 + PREPARED_TTL_MS }), null, 'expired');
  assert.equal(usablePrepared(prepared, { tabId: 8, url: session.url, now: 2000 }), null, 'other tab');
  assert.equal(usablePrepared(prepared, { tabId: 7, url: 'https://rr.test/other', now: 2000 }), null, 'other page');
  assert.equal(usablePrepared(null, { tabId: 7, url: session.url }), null);
});
