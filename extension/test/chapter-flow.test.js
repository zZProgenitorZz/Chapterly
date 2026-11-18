import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChapterNotice, ChapterPhase, createChapterFlow, decideAfterFinish, originPattern } from '../src/background/chapter-flow.js';

const CH2 = 'https://www.royalroad.com/fiction/1/chapter/2';
const CH3 = 'https://www.royalroad.com/fiction/1/chapter/3';

function fakeEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    fire: (...args) => [...listeners].forEach((fn) => fn(...args)),
    get size() {
      return listeners.size;
    },
  };
}

/** chrome.tabs stand-in: update() navigates and (unless told otherwise) completes the load. */
function fakeTabs(tabs, { completeLoads = true } = {}) {
  const onUpdated = fakeEvent();
  const onRemoved = fakeEvent();
  const updates = [];
  return {
    onUpdated,
    onRemoved,
    updates,
    get: async (id) => {
      if (!tabs[id]) throw new Error('No tab with id');
      return { ...tabs[id] };
    },
    update: async (id, { url }) => {
      updates.push({ id, url });
      tabs[id].url = url;
      setTimeout(() => {
        onUpdated.fire(id, { status: 'loading' }, tabs[id]);
        if (completeLoads) onUpdated.fire(id, { status: 'complete' }, tabs[id]);
      }, 1);
      return tabs[id];
    },
  };
}

function setup({ autoNextChapter = false, permission = true, extract = { ok: true, doc: { url: CH3 } }, tabUrl = CH2, completeLoads = true } = {}) {
  const session = { sessionId: 's1', kind: 'chapter', tabId: 7, url: CH2, nextChapterUrl: CH3 };
  const tabState = { 7: { id: 7, url: tabUrl } };
  const settings = { autoNextChapter };
  const calls = { statuses: [], badges: [], started: [], extracted: [], permissionChecks: [] };
  let active = session;
  const tabs = fakeTabs(tabState, { completeLoads });
  const flow = createChapterFlow({
    tabs,
    timeoutMs: 50,
    hasPermission: async (origins) => {
      calls.permissionChecks.push(origins);
      return permission;
    },
    extractChapter: async (tabId) => {
      calls.extracted.push(tabId);
      return extract;
    },
    startChapter: async (doc, tabId) => {
      calls.started.push({ doc, tabId });
      active = { sessionId: 's2' };
    },
    getSettings: async () => ({ ...settings }),
    getActiveSession: async () => active,
    setStatus: async (s) => calls.statuses.push(s),
    setBadge: async (b) => calls.badges.push(b),
  });
  return { flow, session, settings, calls, tabs, tabState, setActive: (s) => (active = s) };
}

test('decideAfterFinish', () => {
  const chapter = { kind: 'chapter', nextChapterUrl: CH3 };
  assert.equal(decideAfterFinish(chapter, { autoNextChapter: true }), 'auto');
  assert.equal(decideAfterFinish(chapter, { autoNextChapter: false }), 'offer');
  assert.equal(decideAfterFinish({ ...chapter, nextChapterUrl: null }, { autoNextChapter: true }), 'stop');
  assert.equal(decideAfterFinish({ kind: 'selection' }, { autoNextChapter: true }), 'stop');
  assert.equal(originPattern(CH3), 'https://www.royalroad.com/*');
});

test('setting off: stops at the chapter end and offers "Next chapter"', async () => {
  const { flow, session, calls, tabs } = setup({ autoNextChapter: false });
  assert.equal(await flow.onSessionFinished(session), 'offered');
  assert.equal(tabs.updates.length, 0, 'no navigation');
  assert.deepEqual(calls.statuses, [{ phase: ChapterPhase.FINISHED, url: CH3 }]);
  assert.deepEqual(calls.badges, ['finished']);
});

test('setting on: navigates, waits for the load, extracts and starts the next chapter', async () => {
  const { flow, session, calls, tabs } = setup({ autoNextChapter: true });
  assert.equal(await flow.onSessionFinished(session), 'started');
  assert.deepEqual(tabs.updates, [{ id: 7, url: CH3 }]);
  assert.deepEqual(calls.permissionChecks, [['https://www.royalroad.com/*']]);
  assert.deepEqual(calls.extracted, [7]);
  assert.deepEqual(calls.started, [{ doc: { url: CH3 }, tabId: 7 }]);
  assert.deepEqual(calls.badges, ['next'], 'badge → while loading');
  assert.deepEqual(calls.statuses, [{ phase: ChapterPhase.LOADING, url: CH3 }, null]);
  assert.equal(tabs.onUpdated.size, 0, 'listener removed');
});

test('toggling the setting during the chapter is respected at the end', async () => {
  const on = setup({ autoNextChapter: false });
  on.settings.autoNextChapter = true; // switched on while the chapter was playing
  assert.equal(await on.flow.onSessionFinished(on.session), 'started');

  const off = setup({ autoNextChapter: true });
  off.settings.autoNextChapter = false; // switched off while playing
  assert.equal(await off.flow.onSessionFinished(off.session), 'offered');
  assert.equal(off.tabs.updates.length, 0);
});

test('the manual "Next chapter" button works with the setting off', async () => {
  const { flow, session, calls, tabs } = setup({ autoNextChapter: false });
  await flow.onSessionFinished(session);
  assert.equal(await flow.goToNext(session), 'started');
  assert.deepEqual(tabs.updates, [{ id: 7, url: CH3 }]);
  assert.equal(calls.started.length, 1);
});

test('without permission for the site: stop with a notice, no navigation', async () => {
  const { flow, session, calls, tabs } = setup({ autoNextChapter: true, permission: false });
  assert.equal(await flow.onSessionFinished(session), ChapterNotice.NO_PERMISSION);
  assert.equal(tabs.updates.length, 0);
  assert.deepEqual(calls.statuses, [{ phase: ChapterPhase.STOPPED, notice: ChapterNotice.NO_PERMISSION, url: CH3 }]);
});

test('user navigated the tab away or closed it: do nothing', async () => {
  const away = setup({ autoNextChapter: true, tabUrl: 'https://example.com/elsewhere' });
  assert.equal(await away.flow.onSessionFinished(away.session), 'navigated-away');
  assert.equal(away.tabs.updates.length, 0);
  assert.deepEqual(away.calls.statuses, []);

  const closed = setup({ autoNextChapter: true });
  delete closed.tabState[7];
  assert.equal(await closed.flow.onSessionFinished(closed.session), 'tab-gone');
  assert.deepEqual(closed.calls.statuses, []);

  const hash = setup({ autoNextChapter: true, tabUrl: `${CH2}#comments` });
  assert.equal(await hash.flow.onSessionFinished(hash.session), 'started', 'a #fragment is still the same page');
});

test('no chapter text on the next page: stop with a clear notice', async () => {
  const { flow, session, calls } = setup({ autoNextChapter: true, extract: { ok: false, error: 'NO_CHAPTER_TEXT' } });
  assert.equal(await flow.onSessionFinished(session), ChapterNotice.NO_CHAPTER_TEXT);
  assert.equal(calls.started.length, 0);
  assert.deepEqual(calls.statuses.at(-1), { phase: ChapterPhase.STOPPED, notice: ChapterNotice.NO_CHAPTER_TEXT, url: CH3 });
});

test('the next page never finishes loading: timeout notice', async () => {
  const { flow, session, calls, tabs } = setup({ autoNextChapter: true, completeLoads: false });
  assert.equal(await flow.onSessionFinished(session), ChapterNotice.TIMEOUT);
  assert.equal(calls.extracted.length, 0);
  assert.equal(tabs.onUpdated.size, 0, 'listener removed after the timeout');
});

test('the tab is closed while the next chapter loads', async () => {
  const { flow, session, tabs, calls } = setup({ autoNextChapter: true, completeLoads: false });
  const pending = flow.onSessionFinished(session);
  await new Promise((r) => setTimeout(r, 5));
  tabs.onRemoved.fire(7);
  assert.equal(await pending, 'tab-gone');
  assert.equal(calls.started.length, 0);
});

test('another session started meanwhile: leave it alone', async () => {
  const ctx = setup({ autoNextChapter: true });
  ctx.tabs.onUpdated.addListener(() => ctx.setActive({ sessionId: 'user-picked-something' }));
  assert.equal(await ctx.flow.onSessionFinished(ctx.session), 'superseded');
  assert.equal(ctx.calls.started.length, 0);
});

test('two finish events at once navigate only once', async () => {
  const { flow, session, tabs } = setup({ autoNextChapter: true });
  const [a, b] = await Promise.all([flow.goToNext(session), flow.goToNext(session)]);
  assert.equal(a, 'started');
  assert.equal(b, 'started');
  assert.equal(tabs.updates.length, 1);
});

test('isNavigating(): true only while our own navigation to the next chapter runs', async () => {
  const { flow, session, tabs } = setup({ autoNextChapter: true });
  const seen = [];
  // The service worker's tabs.onUpdated listener asks this on every URL change.
  tabs.onUpdated.addListener((id, changeInfo) => {
    if (changeInfo.status === 'loading') seen.push(flow.isNavigating(id));
  });
  assert.equal(flow.isNavigating(7), false);
  const done = flow.onSessionFinished(session);
  assert.equal(await done, 'started');
  assert.deepEqual(seen, [true], 'the URL change during auto-next is ours');
  assert.equal(flow.isNavigating(7), false, 'cleared afterwards');
  assert.equal(flow.isNavigating(8), false);
});
