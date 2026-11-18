import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageLeave, isLeavingUpdate, isSessionPage } from '../src/background/page-leave.js';

const CH2 = 'https://www.royalroad.com/fiction/1/chapter/2';
const CH3 = 'https://www.royalroad.com/fiction/1/chapter/3';

function setup({ status = 'playing', navigating = false, offscreen = true, session } = {}) {
  const active = session ?? { sessionId: 's1', kind: 'chapter', tabId: 7, url: CH2 };
  const player = { sessionId: 's1', status, index: 4, prepared: false };
  const calls = [];
  const pageLeave = createPageLeave({
    getActiveSession: async () => active,
    isNavigating: () => navigating,
    getPlayerState: async () => (offscreen ? { ...player } : null),
    savePosition: async (s, state) => calls.push(['savePosition', state.index]),
    pause: async () => {
      calls.push(['pause']);
      player.status = 'paused';
    },
    dropPrefetches: async () => calls.push(['dropPrefetches']),
    deactivatePage: async (s) => calls.push(['deactivatePage', s.url]),
    setBadge: async (b) => calls.push(['badge', b]),
  });
  return { pageLeave, calls, player };
}

const names = (calls) => calls.map((c) => c[0]);

// ---------- PAGE_LEAVING from the page ----------

test('PAGE_LEAVING from the session tab pauses, saves the position and drops prefetches', async () => {
  const { pageLeave, calls } = await setup();
  assert.equal(await pageLeave.onPageLeaving({ url: CH2 }, 7), 'stopped');
  assert.deepEqual(calls, [
    ['savePosition', 4],
    ['pause'],
    ['dropPrefetches'],
    ['deactivatePage', CH2],
    ['badge', 'idle'],
  ]);
});

test('PAGE_LEAVING from another tab, or about another URL, is ignored', async () => {
  const { pageLeave, calls } = await setup();
  assert.equal(await pageLeave.onPageLeaving({ url: CH2 }, 8), 'ignored', 'other tab');
  assert.equal(await pageLeave.onPageLeaving({ url: CH3 }, 7), 'ignored', 'other page (an older session)');
  assert.equal(await pageLeave.onPageLeaving({}, 7), 'ignored', 'no url');
  assert.deepEqual(calls, []);
  assert.equal(await pageLeave.onPageLeaving({ url: `${CH2}#comments` }, 7), 'stopped', 'hash is the same page');
});

test('during auto-next (our own navigation) PAGE_LEAVING is ignored', async () => {
  const { pageLeave, calls } = await setup({ navigating: true });
  assert.equal(await pageLeave.onPageLeaving({ url: CH2 }, 7), 'auto-next');
  assert.equal(await pageLeave.onTabUpdated(7, { status: 'loading' }), 'auto-next');
  assert.deepEqual(calls, []);
});

test('selection sessions are never stopped by navigation', async () => {
  const { pageLeave, calls } = await setup({ session: { sessionId: 's1', kind: 'selection', tabId: 7, url: CH2 } });
  assert.equal(await pageLeave.onPageLeaving({ url: CH2 }, 7), 'ignored');
  assert.equal(await pageLeave.onTabUpdated(7, { status: 'loading' }), 'ignored');
  assert.deepEqual(calls, []);
});

// ---------- tabs.onUpdated without the "tabs" permission ----------

test("a 'loading' update without url for the session tab stops reading", async () => {
  const { pageLeave, calls } = await setup();
  assert.equal(await pageLeave.onTabUpdated(7, { status: 'loading' }), 'stopped');
  assert.deepEqual(names(calls), ['savePosition', 'pause', 'dropPrefetches', 'deactivatePage', 'badge']);
});

test("a 'loading' update for another tab, or 'complete', changes nothing", async () => {
  const { pageLeave, calls } = await setup();
  assert.equal(await pageLeave.onTabUpdated(8, { status: 'loading' }), 'ignored');
  assert.equal(await pageLeave.onTabUpdated(7, { status: 'complete' }), 'ignored');
  assert.equal(await pageLeave.onTabUpdated(7, { title: 'x' }), 'ignored');
  assert.deepEqual(calls, []);
});

test('with a url (permission granted): another page stops, a #hash change does not', () => {
  const session = { kind: 'chapter', tabId: 7, url: CH2 };
  assert.equal(isLeavingUpdate(session, 7, { url: CH3 }), true);
  assert.equal(isLeavingUpdate(session, 7, { url: `${CH2}#c`, status: 'loading' }), false, 'url wins over status');
  assert.equal(isLeavingUpdate(session, 7, { status: 'loading' }), true);
  assert.equal(isLeavingUpdate(null, 7, { status: 'loading' }), false);
  assert.equal(isSessionPage(session, 7, `${CH2}#top`), true);
  assert.equal(isSessionPage(session, null, CH2), false);
});

// ---------- idempotent ----------

test('both paths firing for one navigation: pause and position save happen once', async () => {
  const { pageLeave, calls } = await setup();
  await pageLeave.onPageLeaving({ url: CH2 }, 7); // pagehide
  await pageLeave.onTabUpdated(7, { status: 'loading' }); // tabs.onUpdated
  assert.equal(names(calls).filter((n) => n === 'pause').length, 1);
  assert.equal(names(calls).filter((n) => n === 'savePosition').length, 1);
  assert.equal(names(calls).filter((n) => n === 'dropPrefetches').length, 2, 'harmless twice');
});

test('an already paused player is not paused again; prefetches are still dropped', async () => {
  const { pageLeave, calls } = await setup({ status: 'paused' });
  await pageLeave.onTabUpdated(7, { status: 'loading' });
  assert.deepEqual(names(calls), ['dropPrefetches', 'deactivatePage', 'badge']);
});

test('without an offscreen document only the page and badge are reset', async () => {
  const { pageLeave, calls } = await setup({ offscreen: false });
  await pageLeave.onPageLeaving({ url: CH2 }, 7);
  assert.deepEqual(names(calls), ['deactivatePage', 'badge']);
});
