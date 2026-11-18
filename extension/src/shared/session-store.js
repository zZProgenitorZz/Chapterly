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
// A chapter extracted and warmed up when the popup opened (PREPARE_CHAPTER), not started:
// {tabId, url, preparedAt, doc, session, startIndex}. "Read chapter" on that page reuses it.
const KEY_PREPARED = 'preparedChapter';

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

    getPreparedChapter: () => read(KEY_PREPARED),
    savePreparedChapter: (prepared) => area.set({ [KEY_PREPARED]: prepared }),
    clearPreparedChapter: () => area.set({ [KEY_PREPARED]: null }),
  };
}

let defaultStore = null;
const store = () => (defaultStore ??= createSessionStore(chrome.storage.session));

export const getActiveSession = () => store().getActiveSession();
export const saveActiveSession = (session) => store().saveActiveSession(session);
export const updatePosition = (sessionId, currentIndex) => store().updatePosition(sessionId, currentIndex);
export const getPlayerSnapshot = () => store().getPlayerSnapshot();
export const savePlayerSnapshot = (state) => store().savePlayerSnapshot(state);
export const getPreparedChapter = () => store().getPreparedChapter();
export const savePreparedChapter = (prepared) => store().savePreparedChapter(prepared);
export const clearPreparedChapter = () => store().clearPreparedChapter();

/** What the offscreen player needs from a stored session. */
export function toPlayerSession(session) {
  return {
    sessionId: session.sessionId,
    title: session.title,
    chunks: session.chunks,
    meta: {
      kind: session.kind,
      extractorId: session.extractorId ?? null,
      url: session.url ?? null,
      seriesTitle: session.seriesTitle ?? null,
      nextChapterUrl: session.nextChapterUrl ?? null,
    },
  };
}

const BUSY = new Set(['playing', 'loading', 'buffering']);

/**
 * Decides whether the offscreen player must be reloaded (it was closed, e.g. after a
 * long pause) and from where. Returns the PLAYER_LOAD payload, or null if the player
 * already has this session. `voice` ({provider, voice}) is the current voice selection,
 * so a recreated offscreen document keeps reading with the chosen voice.
 *
 * The last snapshot decides how the player comes back:
 * - paused  -> startPaused: the chunk is loaded at its position, status PAUSED, so play
 *              continues from that spot and next/previous move while staying paused;
 * - playing -> autoplay: the document was closed for another reason, so keep reading;
 * - else    -> idle at currentIndex, as before.
 */
export function buildRestorePayload(session, playerState, snapshot, backendUrl, voice = null, playbackRate = 1) {
  if (!session?.chunks?.length) return null;
  if (playerState?.sessionId === session.sessionId && !playerState.prepared) return null;
  const startIndex = Math.min(Math.max(0, session.currentIndex ?? 0), session.chunks.length - 1);
  const status = snapshot?.sessionId === session.sessionId ? snapshot.status : null;
  const startPaused = status === 'paused';
  const autoplay = BUSY.has(status);
  const samePlace = snapshot?.sessionId === session.sessionId && snapshot.index === startIndex && (startPaused || autoplay);
  return {
    session: toPlayerSession(session),
    backendUrl,
    voice,
    playbackRate,
    startIndex,
    startTime: samePlace ? snapshot.position ?? 0 : 0,
    startPaused,
    autoplay,
  };
}

// ---------- remembered positions per novel (chrome.storage.local) ----------
//
// positions: { [novelKey]: {url, title, seriesTitle, paragraphIndex, chunkIndex,
//                           paragraphCount, finished, updatedAt} }
// novelKey = extractorId + seriesTitle when the extractor knows the series (one entry
// per novel, the latest chapter wins), else the chapter URL. Matching on "Read chapter"
// is by exact chapter URL and by paragraphIndex (chunking can change between versions).

const KEY_POSITIONS = 'positions';
export const MAX_POSITIONS = 200;

export function novelKey({ extractorId, seriesTitle, url }) {
  return seriesTitle ? `${extractorId ?? 'site'}:${seriesTitle}` : `url:${url}`;
}

/**
 * @param {chrome.storage.StorageArea} area defaults to chrome.storage.local
 */
export function createPositionStore(area, { limit = MAX_POSITIONS, now = () => Date.now() } = {}) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const readAll = async () => (await area.get(KEY_POSITIONS))[KEY_POSITIONS] ?? {};

  return {
    /** Saves where a chapter session is; keeps the newest `limit` novels. */
    save: (session, { paragraphIndex, chunkIndex, paragraphCount = null, finished = false }) =>
      serial(async () => {
        if (!session?.url || paragraphIndex == null) return null;
        const all = await readAll();
        const entry = {
          url: session.url,
          title: session.title ?? '',
          seriesTitle: session.seriesTitle ?? null,
          paragraphIndex,
          chunkIndex,
          paragraphCount,
          finished,
          updatedAt: now(),
        };
        all[novelKey(session)] = entry;
        const keys = Object.keys(all).sort((a, b) => all[b].updatedAt - all[a].updatedAt);
        for (const key of keys.slice(limit)) delete all[key];
        await area.set({ [KEY_POSITIONS]: all });
        return entry;
      }),

    /** The stored position for this exact chapter URL, or null. */
    findForUrl: (url) =>
      serial(async () => Object.values(await readAll()).find((p) => p.url === url) ?? null),

    getAll: () => serial(readAll),

    forget: () => serial(() => area.remove(KEY_POSITIONS)),
  };
}

/**
 * Whether "Resume from paragraph N" should be offered: not at the very start, not at
 * the end, not finished.
 */
export function resumeOffer(position, paragraphCount) {
  if (!position || position.finished) return null;
  const p = position.paragraphIndex;
  if (!Number.isInteger(p) || p <= 0 || p >= paragraphCount - 1) return null;
  return { paragraphIndex: p, paragraphNumber: p + 1, paragraphCount };
}

let defaultPositions = null;
export const positions = () => (defaultPositions ??= createPositionStore(chrome.storage.local));
