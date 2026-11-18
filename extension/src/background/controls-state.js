// Player state for the floating buttons on the reading page (src/content/floating-controls.js).
// No chrome.* calls: `send(tabId, payload)` is injected (tested in test/floating-controls.test.js).

import { describeError } from '../shared/error-messages.js';

/** The part of a player state the floating buttons show: {status, index, total, error}. */
export function controlsStateFrom(state) {
  return {
    status: state?.status ?? 'idle',
    index: state?.index ?? 0,
    total: state?.total ?? 0,
    error: state?.status === 'error' && state.error ? describeError(state.error) : null,
  };
}

/**
 * Sends CONTROLS_STATE to the session's tab only when the session, status or index
 * changed since the last message (player events come in bursts; most change neither).
 * The last sent value lives in memory; reset() makes the next notify() send again
 * (PAGE_SESSION active=true, a new page).
 */
export function createControlsNotifier(send) {
  let last = null;
  return {
    /** @returns {boolean} whether a message was sent */
    notify(session, state, { force = false } = {}) {
      if (session?.kind !== 'chapter' || session.tabId == null || state?.sessionId !== session.sessionId) return false;
      const payload = { url: session.url, ...controlsStateFrom(state) };
      const key = `${session.sessionId}|${session.url}|${payload.status}|${payload.index}`;
      if (!force && key === last) return false;
      last = key;
      send(session.tabId, payload);
      return true;
    },
    reset() {
      last = null;
    },
  };
}
