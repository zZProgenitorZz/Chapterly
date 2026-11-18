// The reading tab left the chapter page: pause, keep the position, stop prefetching.
// No chrome.* calls: everything is injected (tested in test/page-leave.test.js).
//
// Two independent paths report it, because neither is reliable on its own:
// - PAGE_LEAVING from the page (pagehide, or an SPA URL change): works on every site
//   without any permission.
// - chrome.tabs.onUpdated: changeInfo.url is only filled in with the "tabs" permission or
//   host permission for the site, which Chapterly usually lacks. So a 'loading' status of
//   the session's tab (no url) also counts as leaving: a reload of the same page drops
//   the paragraph marks too, so pausing is right.
// Both may fire for one navigation; stop() is idempotent.

import { isNavigationAway, stripHash } from './navigation.js';

const BUSY = new Set(['playing', 'loading', 'buffering']);

/** Does this tabs.onUpdated change mean the session's tab is leaving its page? */
export function isLeavingUpdate(session, tabId, changeInfo) {
  if (session?.kind !== 'chapter' || session.tabId == null || tabId !== session.tabId) return false;
  if (changeInfo?.url) return isNavigationAway(session, tabId, changeInfo.url); // #hash only: same page
  return changeInfo?.status === 'loading';
}

/** Is PAGE_LEAVING {url} from this tab about the active chapter session's page? */
export function isSessionPage(session, tabId, url) {
  return session?.kind === 'chapter' && tabId != null && session.tabId === tabId && stripHash(url) === stripHash(session.url);
}

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.getActiveSession
 * @param {(tabId) => boolean} deps.isNavigating auto-next is navigating this tab
 * @param {() => Promise<object|null>} deps.getPlayerState live offscreen state, null if none
 * @param {(session, state) => Promise} deps.savePosition forced position save
 * @param {() => Promise} deps.pause
 * @param {() => Promise} deps.dropPrefetches
 * @param {(session) => Promise} deps.deactivatePage PAGE_SESSION active=false to the tab
 * @param {(badge) => Promise} deps.setBadge
 */
export function createPageLeave(deps) {
  /** Idempotent: pausing a paused player or dropping prefetches twice is harmless. */
  async function stop(session) {
    const state = await deps.getPlayerState();
    if (state?.sessionId === session.sessionId && !state.prepared) {
      if (BUSY.has(state.status)) {
        // Only while it was still reading: a paused player saved its position when it paused.
        await deps.savePosition(session, state);
        await deps.pause();
      }
      await deps.dropPrefetches();
    }
    // The page (if it still exists, e.g. after an SPA navigation) is no longer the session's
    // page: page keys and floating buttons switch off.
    await deps.deactivatePage(session);
    await deps.setBadge('idle');
    return 'stopped';
  }

  return {
    stop,

    /** PAGE_LEAVING {url} from a content script. */
    async onPageLeaving(payload, tabId) {
      if (deps.isNavigating(tabId)) return 'auto-next';
      const session = await deps.getActiveSession();
      if (!isSessionPage(session, tabId, payload?.url)) return 'ignored';
      return stop(session);
    },

    /** chrome.tabs.onUpdated(tabId, changeInfo). */
    async onTabUpdated(tabId, changeInfo) {
      if (deps.isNavigating(tabId)) return 'auto-next';
      const session = await deps.getActiveSession();
      if (!isLeavingUpdate(session, tabId, changeInfo)) return 'ignored';
      return stop(session);
    },
  };
}
