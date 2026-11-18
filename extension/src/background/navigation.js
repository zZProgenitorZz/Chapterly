// Pure decisions about tabs and pages, used by the service worker (tested in
// test/navigation.test.js).

/** How long a chapter prepared by the popup (PREPARE_CHAPTER) stays usable. */
export const PREPARED_TTL_MS = 2 * 60 * 1000;

export const stripHash = (url) => String(url ?? '').split('#')[0];

export function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Did the active chapter session's tab move to another page? A changed #hash is the same
 * page; navigation started by chapter-flow (auto next chapter) is excluded by the caller.
 */
export function isNavigationAway(session, tabId, newUrl) {
  if (session?.kind !== 'chapter' || session.tabId == null || tabId !== session.tabId) return false;
  if (!newUrl || !session.url) return false;
  return stripHash(newUrl) !== stripHash(session.url);
}

/** Is there a chapter session for exactly this tab and page? */
export function isSessionFor(session, tabId, url) {
  return session?.kind === 'chapter' && session.tabId === tabId && stripHash(session.url) === stripHash(url);
}

/**
 * The prepared chapter, if it belongs to this tab and page and is fresh enough to reuse.
 * prepared = {tabId, url, preparedAt, doc, session, startIndex}
 */
export function usablePrepared(prepared, { tabId, url, now = Date.now(), ttlMs = PREPARED_TTL_MS }) {
  if (!prepared?.session || !prepared.doc) return null;
  if (prepared.tabId !== tabId || stripHash(prepared.url) !== stripHash(url)) return null;
  if (!(now - prepared.preparedAt < ttlMs)) return null;
  return prepared;
}
