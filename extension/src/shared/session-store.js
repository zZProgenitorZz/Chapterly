// Storage for the active reading session and the latest player snapshot.
// Everything that must survive a service-worker restart or a closed offscreen
// document goes through here. Step 5 can add persistent per-novel positions
// (chrome.storage.local) in this module without touching the player.
//
// ReadingSession = {
//   sessionId, kind: "chapter" | "selection", tabId, url, title, seriesTitle,
//   extractorId, nextChapterUrl, prevChapterUrl,
//   chunks: [{index, text, paragraphIndexes}], currentIndex, createdAt, updatedAt
// }

const KEY_ACTIVE = 'activeSession';
const KEY_SNAPSHOT = 'playerSnapshot';

/** @param {chrome.storage.StorageArea} area defaults to chrome.storage.session */
export function createSessionStore(area) {
  let queue = Promise.resolve();
  // Read-modify-write operations run one at a time (events can arrive in bursts).
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const read = async (key) => (await area.get(key))[key] ?? null;

  return {
    getActiveSession: () => serial(() => read(KEY_ACTIVE)),

    saveActiveSession: (session) =>
      serial(async () => {
        const saved = { ...session, updatedAt: Date.now() };
        await area.set({ [KEY_ACTIVE]: saved });
        return saved;
      }),

    /** Sets currentIndex if `sessionId` is still the active session. Returns the session. */
    updatePosition: (sessionId, currentIndex) =>
      serial(async () => {
        const session = await read(KEY_ACTIVE);
        if (!session || session.sessionId !== sessionId || session.currentIndex === currentIndex) return session;
        const saved = { ...session, currentIndex, updatedAt: Date.now() };
        await area.set({ [KEY_ACTIVE]: saved });
        return saved;
      }),

    getPlayerSnapshot: () => read(KEY_SNAPSHOT),
    savePlayerSnapshot: (state) => area.set({ [KEY_SNAPSHOT]: state }),
  };
}

let defaultStore = null;
const store = () => (defaultStore ??= createSessionStore(chrome.storage.session));

export const getActiveSession = () => store().getActiveSession();
export const saveActiveSession = (session) => store().saveActiveSession(session);
export const updatePosition = (sessionId, currentIndex) => store().updatePosition(sessionId, currentIndex);
export const getPlayerSnapshot = () => store().getPlayerSnapshot();
export const savePlayerSnapshot = (state) => store().savePlayerSnapshot(state);

/** What the offscreen player needs from a stored session. */
export function toPlayerSession(session) {
  return {
    sessionId: session.sessionId,
    title: session.title,
    chunks: session.chunks,
    meta: { kind: session.kind, extractorId: session.extractorId ?? null, url: session.url ?? null },
  };
}

/**
 * Decides whether the offscreen player must be reloaded (it was closed, e.g. after a
 * long pause) and from where. Returns the PLAYER_LOAD payload, or null if the player
 * already has this session. `voice` ({provider, voice}) is the current voice selection,
 * so a recreated offscreen document keeps reading with the chosen voice.
 */
export function buildRestorePayload(session, playerState, snapshot, backendUrl, voice = null) {
  if (!session?.chunks?.length) return null;
  if (playerState?.sessionId === session.sessionId) return null;
  const startIndex = Math.min(Math.max(0, session.currentIndex ?? 0), session.chunks.length - 1);
  const samePlace =
    snapshot?.sessionId === session.sessionId && snapshot.index === startIndex && snapshot.status === 'paused';
  return {
    session: toPlayerSession(session),
    backendUrl,
    voice,
    startIndex,
    startTime: samePlace ? snapshot.position ?? 0 : 0,
  };
}
