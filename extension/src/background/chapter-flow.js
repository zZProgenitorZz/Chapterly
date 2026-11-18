// Continuing with the next chapter. No direct chrome.* calls: everything is injected,
// so the flow can be tested with fake tabs (test/chapter-flow.test.js).
//
// At the end of a chapter session (sessionFinished):
//   setting autoNextChapter on  -> goToNext(): navigate, wait, extract, play
//   setting off                 -> stop; the popup offers "Next chapter" (goToNext once)
// The setting is read at sessionFinished time, so toggling it mid-chapter counts.

export const NEXT_CHAPTER_TIMEOUT_MS = 20_000;

/** Status shown in the popup while/after moving to the next chapter. */
export const ChapterPhase = Object.freeze({
  LOADING: 'loading', // navigating to / extracting the next chapter
  STOPPED: 'stopped', // could not continue; see notice
  FINISHED: 'finished', // chapter done, auto-next off (popup offers "Next chapter")
});

export const ChapterNotice = Object.freeze({
  NO_PERMISSION: 'NO_PERMISSION', // "Allow Chapterly on this site to continue automatically"
  NO_CHAPTER_TEXT: 'NO_CHAPTER_TEXT',
  TIMEOUT: 'TIMEOUT',
  NO_NEXT: 'NO_NEXT',
});

/** What to do when a session finished (pure). */
export function decideAfterFinish(session, { autoNextChapter }) {
  if (session?.kind !== 'chapter') return 'stop';
  if (!session.nextChapterUrl) return 'stop';
  return autoNextChapter ? 'auto' : 'offer';
}

export function originPattern(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.origin}/*` : null;
  } catch {
    return null;
  }
}

const stripHash = (url) => String(url ?? '').split('#')[0];

/**
 * @param {object} deps
 * @param {{get, update, onUpdated: {addListener, removeListener}, onRemoved?: {addListener, removeListener}}} deps.tabs
 * @param {(origins: string[]) => Promise<boolean>} deps.hasPermission
 * @param {(tabId) => Promise<{ok, doc?, error?}>} deps.extractChapter inject + extract + check
 * @param {(doc, tabId) => Promise<void>} deps.startChapter start a chapter session that plays
 * @param {() => Promise<{autoNextChapter: boolean}>} deps.getSettings
 * @param {() => Promise<object|null>} deps.getActiveSession
 * @param {(status|null) => Promise<void>} deps.setStatus popup status {phase, notice?, url?}
 * @param {(badge: string) => Promise<void>} deps.setBadge 'next' | 'finished' | ...
 */
export function createChapterFlow(deps) {
  const timeoutMs = deps.timeoutMs ?? NEXT_CHAPTER_TIMEOUT_MS;
  let running = null; // one navigation at a time
  let navigatingTabId = null; // set while our own tabs.update() is loading the next chapter

  /** Resolves 'complete' | 'timeout' | 'removed' for the tab's next finished load. */
  function waitForLoad(tabId) {
    return new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(timer);
        deps.tabs.onUpdated.removeListener(onUpdated);
        deps.tabs.onRemoved?.removeListener(onRemoved);
        resolve(result);
      };
      const onUpdated = (id, changeInfo) => {
        if (id === tabId && changeInfo.status === 'complete') done('complete');
      };
      const onRemoved = (id) => {
        if (id === tabId) done('removed');
      };
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      deps.tabs.onUpdated.addListener(onUpdated);
      deps.tabs.onRemoved?.addListener(onRemoved);
    });
  }

  async function stop(notice, url) {
    await deps.setStatus({ phase: ChapterPhase.STOPPED, notice, url: url ?? null });
    await deps.setBadge('stopped');
    return notice;
  }

  /**
   * Navigates the session's tab to the next chapter and starts reading it.
   * Returns 'started' or why it didn't (also reported through setStatus).
   */
  async function goToNext(session) {
    if (running) return running;
    running = run(session).finally(() => {
      running = null;
      navigatingTabId = null;
    });
    return running;
  }

  async function run(session) {
    if (session?.kind !== 'chapter') return 'not-a-chapter';
    const url = session.nextChapterUrl;
    if (!url) return stop(ChapterNotice.NO_NEXT);

    // The user moved on: tab closed or showing another page -> do nothing.
    const tab = await deps.tabs.get(session.tabId).catch(() => null);
    if (!tab) return 'tab-gone';
    if (tab.url && stripHash(tab.url) !== stripHash(session.url)) return 'navigated-away';

    const pattern = originPattern(url);
    if (!pattern || !(await deps.hasPermission([pattern]))) return stop(ChapterNotice.NO_PERMISSION, url);

    await deps.setStatus({ phase: ChapterPhase.LOADING, url });
    await deps.setBadge('next');

    const loaded = waitForLoad(session.tabId); // listen before navigating
    navigatingTabId = session.tabId; // our own navigation: the service worker must not stop the session
    try {
      await deps.tabs.update(session.tabId, { url });
    } catch {
      return 'tab-gone';
    }
    const result = await loaded;
    if (result === 'removed') return 'tab-gone';
    if (result === 'timeout') return stop(ChapterNotice.TIMEOUT, url);

    // Another session started while we were loading (user clicked something): leave it.
    const current = await deps.getActiveSession();
    if (current?.sessionId !== session.sessionId) return 'superseded';

    const extracted = await deps.extractChapter(session.tabId);
    if (!extracted?.ok) return stop(ChapterNotice.NO_CHAPTER_TEXT, url);

    await deps.startChapter(extracted.doc, session.tabId);
    await deps.setStatus(null);
    return 'started';
  }

  /** sessionFinished: reads the setting now, so a toggle during the chapter counts. */
  async function onSessionFinished(session) {
    const decision = decideAfterFinish(session, await deps.getSettings());
    if (decision === 'auto') return goToNext(session);
    if (decision === 'offer') {
      await deps.setStatus({ phase: ChapterPhase.FINISHED, url: session.nextChapterUrl });
    }
    await deps.setBadge('finished');
    return decision === 'offer' ? 'offered' : 'stopped';
  }

  /** True while goToNext() is navigating this tab (tabs.onUpdated events are ours). */
  function isNavigating(tabId) {
    return navigatingTabId != null && navigatingTabId === tabId;
  }

  return { goToNext, onSessionFinished, decideAfterFinish, isNavigating };
}
