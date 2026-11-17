// Service worker: coordinator only. Owns the context menus, the offscreen document,
// page injection, command routing, highlighting and the badge. Chrome can kill it at
// any time, so it keeps nothing important in memory: the reading session and the
// latest player snapshot live in chrome.storage.session (via session-store.js).

import { chunkIndexForParagraph, chunkIndexForPosition, chunkParagraphs, splitIntoChunks } from '../shared/chunker.js';
import { createChapterFlow } from './chapter-flow.js';
import { CONTENT_SCRIPT_FILES } from '../content/extractors/registry.js';
import { VOICE_KEYS, getSettings, getVoiceSelection, saveSettings, stepRate } from '../shared/settings.js';
import {
  MessageType,
  PlayerCommand,
  Target,
  broadcast,
  envelope,
  listen,
  toOffscreen,
} from '../shared/messages.js';
import {
  buildRestorePayload,
  getActiveSession,
  getPlayerSnapshot,
  positions,
  resumeOffer,
  saveActiveSession,
  savePlayerSnapshot,
  toPlayerSession,
  updatePosition,
} from '../shared/session-store.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const MENU_READ_SELECTION = 'chapterly-read-selection';
const MENU_READ_FROM_HERE = 'chapterly-read-from-here';

/** Below this, the page probably isn't a chapter. */
const MIN_CHAPTER_PARAGRAPHS = 3;
const MIN_CHAPTER_CHARS = 500;
const KEY_CHAPTER_STATUS = 'chapterStatus'; // chrome.storage.session: auto-next status for the popup
const POSITION_SAVE_INTERVAL_MS = 5000;

const chapterFlow = createChapterFlow({
  tabs: chrome.tabs,
  hasPermission: (origins) => chrome.permissions.contains({ origins }),
  extractChapter: (tabId) => extractChapter(tabId),
  startChapter: (doc, tabId) => startChapter(doc, tabId),
  getSettings: () => getSettings(),
  getActiveSession: () => getActiveSession(),
  setStatus: (status) => setChapterStatus(status),
  setBadge: (badge) => setBadge(badge),
});

// ---------- setup ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_READ_SELECTION, title: 'Read aloud with Chapterly', contexts: ['selection'] });
    chrome.contextMenus.create({
      id: MENU_READ_FROM_HERE,
      title: 'Chapterly: read from here',
      contexts: ['page'],
      visible: false, // shown while a chapter session is active
    });
  });
  void setBadge('idle');
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const run =
    info.menuItemId === MENU_READ_SELECTION
      ? readFromContextMenu(info, tab)
      : info.menuItemId === MENU_READ_FROM_HERE
        ? readFromHere(tab)
        : null;
  run?.catch((err) => console.error('[chapterly] context menu', err));
});

// Voice or speed changed in the popup or options page: apply it to the running player.
// (Without an offscreen document, the next PLAYER_LOAD/restore reads the settings.)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (VOICE_KEYS.some((key) => key in changes)) {
    applyVoiceSelection().catch((err) => console.error('[chapterly] voice change', err));
  }
  if ('playbackRate' in changes) {
    applyPlaybackRate(changes.playbackRate.newValue).catch((err) => console.error('[chapterly] speed change', err));
  }
});

async function applyVoiceSelection() {
  if (!(await hasOffscreen())) return;
  await toOffscreen(MessageType.PLAYER_SET_VOICE, await getVoiceSelection());
}

async function applyPlaybackRate(rate) {
  if (!(await hasOffscreen())) return;
  await toOffscreen(MessageType.PLAYER_SET_RATE, { rate: rate ?? 1 });
}

// Global shortcuts (manifest "commands"; keys can be changed in chrome://extensions/shortcuts).
chrome.commands.onCommand.addListener((name) => {
  runShortcut(name).catch((err) => console.error('[chapterly] shortcut', name, err));
});

async function runShortcut(name) {
  switch (name) {
    case 'play-pause':
      return handleCommand({ command: PlayerCommand.TOGGLE });
    case 'next-paragraph':
      return handleCommand({ command: PlayerCommand.NEXT_PARAGRAPH });
    case 'previous-paragraph':
      return handleCommand({ command: PlayerCommand.PREVIOUS_PARAGRAPH });
    case 'faster':
    case 'slower': {
      const { playbackRate } = await getSettings();
      return saveSettings({ playbackRate: stepRate(playbackRate, name === 'faster' ? 1 : -1) }); // applied via onChanged
    }
    default:
      return undefined;
  }
}

listen(Target.BACKGROUND, async ({ type, payload }, sender) => {
  switch (type) {
    case MessageType.READ_SELECTION:
      return readSelectionInTab(payload.tabId);
    case MessageType.READ_CHAPTER:
      return readChapter(payload.tabId, payload);
    case MessageType.NEXT_CHAPTER: {
      const session = await getActiveSession();
      return { ok: true, result: await chapterFlow.goToNext(session) };
    }
    case MessageType.PLAYER_COMMAND:
      return handleCommand(payload);
    case MessageType.PLAYER_EVENT:
      return handlePlayerEvent(payload);
    case MessageType.PAGE_COMMAND:
      return handlePageCommand(payload, sender);
    case MessageType.PAGE_SEEK:
      return handlePageSeek(payload, sender);
    default:
      throw new Error(`Unknown background message: ${type}`);
  }
});

// ---------- offscreen document ----------

let creatingOffscreen = null; // shared promise: concurrent callers wait for one createDocument

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

/**
 * Makes sure the offscreen document exists. Call before every command to it:
 * Chrome closes an AUDIO_PLAYBACK document after ~30 s without audio (e.g. a long pause).
 */
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Plays the speech audio returned by the Chapterly backend.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

/** Recreated offscreen document = empty player: reload the session at currentIndex. */
async function restoreSessionIfNeeded() {
  const [state, session, snapshot, { backendUrl, provider, voice, playbackRate }] = await Promise.all([
    toOffscreen(MessageType.PLAYER_GET_STATE),
    getActiveSession(),
    getPlayerSnapshot(),
    getSettings(),
  ]);
  const payload = buildRestorePayload(session, state, snapshot, backendUrl, { provider, voice }, playbackRate);
  if (payload) await toOffscreen(MessageType.PLAYER_LOAD, payload);
}

// ---------- starting sessions ----------

async function startSession(session, { startIndex = 0 } = {}) {
  const previous = await getActiveSession();
  await setChapterStatus(null);
  lastPositionSave = 0;
  const saved = await saveActiveSession({ ...session, currentIndex: startIndex, createdAt: Date.now() });
  await ensureOffscreen();
  const { backendUrl, provider, voice, playbackRate } = await getSettings();
  await toOffscreen(MessageType.PLAYER_LOAD, {
    session: toPlayerSession(saved),
    backendUrl,
    voice: { provider, voice },
    playbackRate,
    startIndex,
  });
  await toOffscreen(MessageType.PLAYER_PLAY);
  try {
    await chrome.contextMenus.update(MENU_READ_FROM_HERE, { visible: session.kind === 'chapter' });
  } catch {
    // menu not created yet (e.g. right after an update); harmless
  }
  // Keyboard/click control belongs to the page of the current chapter session only.
  if (previous?.kind === 'chapter' && (previous.tabId !== saved.tabId || previous.url !== saved.url)) {
    await setPageSession(previous, false);
  }
  if (saved.kind === 'chapter') await setPageSession(saved, true);
  return saved;
}

async function setPageSession(session, active) {
  if (session?.tabId == null) return;
  await chrome.tabs
    .sendMessage(session.tabId, envelope(Target.CONTENT, MessageType.PAGE_SESSION, { url: session.url, active }), { frameId: 0 })
    .catch(() => {}); // tab navigated or closed
}

/** The active chapter session, if `sender` is its tab and still on its page. */
async function sessionForSender(payload, sender) {
  const session = await getActiveSession();
  if (!session || session.kind !== 'chapter' || sender?.tab?.id !== session.tabId || payload?.url !== session.url) return null;
  return session;
}

/** Page keyboard shortcut (src/content/page-controls.js). */
async function handlePageCommand(payload, sender) {
  if (!(await sessionForSender(payload, sender))) return { ok: false };
  const commands = { next: PlayerCommand.NEXT, previous: PlayerCommand.PREVIOUS, toggle: PlayerCommand.TOGGLE };
  const command = commands[payload.command];
  if (!command) return { ok: false };
  await handleCommand({ command });
  return { ok: true };
}

/** Click on a paragraph: jump to the chunk that contains the clicked word, keep/start playing. */
async function handlePageSeek(payload, sender) {
  const session = await sessionForSender(payload, sender);
  if (!session || !Number.isInteger(payload.paragraphIndex)) return { ok: false };
  const index = chunkIndexForPosition(session.chunks, payload.paragraphIndex, payload.offset);
  if (index < 0) return { ok: false };
  await ensureOffscreen();
  await restoreSessionIfNeeded();
  await toOffscreen(MessageType.PLAYER_SEEK, { index });
  await toOffscreen(MessageType.PLAYER_PLAY);
  return { ok: true, index };
}

/** Injects the content scripts and extracts the chapter: {ok, doc} or {ok: false, error}. */
async function extractChapter(tabId) {
  let doc;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.ChapterlyContent.extract(),
    });
    doc = injection?.result;
  } catch (err) {
    console.warn('[chapterly] cannot inject into tab', err);
    return { ok: false, error: 'CANNOT_ACCESS_PAGE' };
  }
  if (!doc || doc.paragraphs.length < MIN_CHAPTER_PARAGRAPHS || doc.charCount < MIN_CHAPTER_CHARS) {
    return { ok: false, error: 'NO_CHAPTER_TEXT', extractorId: doc?.extractorId ?? null };
  }
  return { ok: true, doc };
}

/** Starts reading an extracted chapter, optionally from a paragraph. */
async function startChapter(doc, tabId, { startParagraph = 0 } = {}) {
  const chunks = chunkParagraphs(doc.paragraphs);
  const startIndex = Math.max(0, chunkIndexForParagraph(chunks, startParagraph));
  return startSession(
    {
      sessionId: crypto.randomUUID(),
      kind: 'chapter',
      tabId,
      url: doc.url,
      title: doc.title,
      seriesTitle: doc.seriesTitle,
      extractorId: doc.extractorId,
      nextChapterUrl: doc.nextChapterUrl,
      prevChapterUrl: doc.prevChapterUrl,
      paragraphCount: doc.paragraphs.length,
      chunks,
    },
    { startIndex },
  );
}

/**
 * "Read chapter". start: 'ask' (default) offers to resume a remembered position for
 * this exact URL instead of starting; 'resume' starts at paragraphIndex; 'top' from 0.
 */
async function readChapter(tabId, { start = 'ask', paragraphIndex = 0 } = {}) {
  if (tabId == null) return { ok: false, error: 'NO_TAB' };
  const extracted = await extractChapter(tabId);
  if (!extracted.ok) return extracted;
  const { doc } = extracted;

  if (start === 'ask') {
    const offer = resumeOffer(await positions().findForUrl(doc.url), doc.paragraphs.length);
    if (offer) return { ok: false, choice: offer, title: doc.title };
  }
  const startParagraph = start === 'resume' ? Math.max(0, Number(paragraphIndex) || 0) : 0;
  const session = await startChapter(doc, tabId, { startParagraph });
  return {
    ok: true,
    title: session.title,
    extractorId: session.extractorId,
    paragraphs: doc.paragraphs.length,
    total: session.chunks.length,
    startIndex: session.currentIndex,
    nextChapterUrl: session.nextChapterUrl,
    prevChapterUrl: session.prevChapterUrl,
  };
}

// ---------- chapter status (auto-next) and remembered positions ----------

async function setChapterStatus(status) {
  if (status) await chrome.storage.session.set({ [KEY_CHAPTER_STATUS]: status });
  else await chrome.storage.session.remove(KEY_CHAPTER_STATUS);
  if (status) await broadcast(Target.POPUP, MessageType.PLAYER_STATE, { state: await currentState(), event: 'chapterStatus' });
}

async function getChapterStatus() {
  return (await chrome.storage.session.get(KEY_CHAPTER_STATUS))[KEY_CHAPTER_STATUS] ?? null;
}

/** Player state (live or snapshot) plus the chapter status, for the popup. */
async function currentState() {
  const state = (await hasOffscreen()) ? await toOffscreen(MessageType.PLAYER_GET_STATE) : await getPlayerSnapshot();
  return withChapterStatus(state);
}

async function withChapterStatus(state) {
  if (!state || typeof state !== 'object' || !('status' in state)) return state;
  return { ...state, chapter: await getChapterStatus() };
}

let lastPositionSave = 0; // in memory: losing it after a restart only costs one extra write

/** Remembers where a chapter session is (throttled unless forced). */
async function savePosition(session, state, { force = false, finished = false } = {}) {
  if (session?.kind !== 'chapter' || state?.sessionId !== session.sessionId) return;
  const now = Date.now();
  if (!force && now - lastPositionSave < POSITION_SAVE_INTERVAL_MS) return;
  const chunk = session.chunks[state.index];
  if (!chunk) return;
  lastPositionSave = now;
  await positions().save(session, {
    paragraphIndex: chunk.paragraphIndex ?? chunk.paragraphIndexes?.[0] ?? 0,
    chunkIndex: state.index,
    paragraphCount: session.paragraphCount ?? null,
    finished,
  });
}

async function readFromContextMenu(info, tab) {
  // Prefer the scripting path: info.selectionText loses line breaks.
  let text = '';
  if (tab?.id != null) text = await getSelectionFromTab(tab.id, info.frameId).catch(() => '');
  if (!text.trim()) text = info.selectionText ?? '';
  const result = await startSelectionSession(text, tab);
  if (!result.ok) console.warn('[chapterly] nothing to read:', result.error);
}

async function readSelectionInTab(tabId) {
  if (tabId == null) return { ok: false, error: 'NO_TAB' };
  let text;
  try {
    text = await getSelectionFromTab(tabId);
  } catch {
    return { ok: false, error: 'CANNOT_ACCESS_PAGE' };
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return startSelectionSession(text, tab ?? { id: tabId });
}

async function getSelectionFromTab(tabId, frameId) {
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  const [injection] = await chrome.scripting.executeScript({
    target,
    func: () => window.getSelection()?.toString() ?? '',
  });
  return typeof injection?.result === 'string' ? injection.result : '';
}

async function startSelectionSession(text, tab) {
  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) return { ok: false, error: 'NO_SELECTION' };
  await startSession({
    sessionId: crypto.randomUUID(),
    kind: 'selection',
    tabId: tab?.id ?? null,
    url: tab?.url ?? null,
    title: tab?.title ?? '',
    seriesTitle: null,
    extractorId: 'selection',
    nextChapterUrl: null,
    prevChapterUrl: null,
    chunks,
  });
  return { ok: true, total: chunks.length };
}

/** "Read from here": seek to the chunk containing the right-clicked paragraph. */
async function readFromHere(tab) {
  const session = await getActiveSession();
  if (!session || session.kind !== 'chapter' || tab?.id !== session.tabId) return;
  const response = await chrome.tabs
    .sendMessage(tab.id, envelope(Target.CONTENT, MessageType.GET_CONTEXT_PARAGRAPH, { url: session.url }), { frameId: 0 })
    .catch(() => null);
  const paragraph = response?.paragraphIndex;
  if (paragraph == null) return;
  // The chunk containing the paragraph, else the last chunk that starts before it
  // (the paragraph itself may have been dropped as unspeakable).
  let index = session.chunks.findIndex((c) => c.paragraphIndexes.includes(paragraph));
  if (index < 0) index = Math.max(0, session.chunks.findLastIndex((c) => Math.min(...c.paragraphIndexes) <= paragraph));
  await ensureOffscreen();
  await restoreSessionIfNeeded();
  await toOffscreen(MessageType.PLAYER_SEEK, { index });
  await toOffscreen(MessageType.PLAYER_PLAY);
}

// ---------- commands from the popup ----------

async function handleCommand({ command, index, rate }) {
  if (command === PlayerCommand.GET_STATE) {
    // Don't create a document just to read state; fall back to the snapshot.
    return currentState();
  }

  if (command === PlayerCommand.STOP && !(await hasOffscreen())) {
    // Nothing is playing; just reset the stored snapshot.
    const snapshot = await getPlayerSnapshot();
    if (snapshot) {
      await handlePlayerEvent({
        event: 'stateChanged',
        state: { ...snapshot, status: 'idle', index: 0, position: 0, error: null },
      });
    }
    return getPlayerSnapshot();
  }

  await ensureOffscreen();
  await restoreSessionIfNeeded();

  switch (command) {
    case PlayerCommand.PLAY:
      return toOffscreen(MessageType.PLAYER_PLAY);
    case PlayerCommand.RESUME:
      return toOffscreen(MessageType.PLAYER_RESUME);
    case PlayerCommand.PAUSE:
      return toOffscreen(MessageType.PLAYER_PAUSE);
    case PlayerCommand.STOP: {
      // Remember the spot before stop() resets the player to chunk 0.
      const [session, state] = await Promise.all([getActiveSession(), toOffscreen(MessageType.PLAYER_GET_STATE)]);
      await savePosition(session, state, { force: true }).catch(() => {});
      await clearHighlight();
      return toOffscreen(MessageType.PLAYER_STOP);
    }
    case PlayerCommand.NEXT:
      return toOffscreen(MessageType.PLAYER_NEXT);
    case PlayerCommand.PREVIOUS:
      return toOffscreen(MessageType.PLAYER_PREVIOUS);
    case PlayerCommand.NEXT_PARAGRAPH:
      return toOffscreen(MessageType.PLAYER_NEXT_PARAGRAPH);
    case PlayerCommand.PREVIOUS_PARAGRAPH:
      return toOffscreen(MessageType.PLAYER_PREVIOUS_PARAGRAPH);
    case PlayerCommand.TOGGLE: {
      const state = await toOffscreen(MessageType.PLAYER_GET_STATE);
      if (['playing', 'loading', 'buffering'].includes(state?.status)) return toOffscreen(MessageType.PLAYER_PAUSE);
      return toOffscreen(state?.status === 'paused' ? MessageType.PLAYER_RESUME : MessageType.PLAYER_PLAY);
    }
    case PlayerCommand.SEEK:
      return toOffscreen(MessageType.PLAYER_SEEK, { index });
    case PlayerCommand.SET_RATE:
      return toOffscreen(MessageType.PLAYER_SET_RATE, { rate });
    default:
      throw new Error(`Unknown player command: ${command}`);
  }
}

// ---------- events from the player ----------

let eventQueue = Promise.resolve(); // events are handled strictly in order

function handlePlayerEvent(payload) {
  const run = eventQueue.then(() => processPlayerEvent(payload));
  eventQueue = run.catch((err) => console.error('[chapterly] player event', err));
  return run;
}

async function processPlayerEvent({ event, data, state }) {
  if (!state) return { ok: true };
  await savePlayerSnapshot(state);

  let session = null;
  if (state.sessionId) session = await updatePosition(state.sessionId, state.index);

  switch (event) {
    case 'chunkStarted':
      if (session?.sessionId === state.sessionId) {
        await highlight(session, data ?? {});
        await savePosition(session, state).catch(() => {}); // throttled
      }
      await setBadge(state.status);
      break;
    case 'sessionFinished':
      console.info('[chapterly] session finished', data?.sessionId, session?.nextChapterUrl ?? '(no next chapter)');
      await clearHighlight(session);
      if (session?.sessionId === state.sessionId) {
        const last = session.chunks.length - 1;
        await savePosition(session, { ...state, index: last }, { force: true, finished: true }).catch(() => {});
        // Not awaited: navigating to the next chapter must not block the event queue.
        chapterFlow.onSessionFinished(session).catch((err) => console.error('[chapterly] next chapter', err));
      } else {
        await setBadge('finished');
      }
      break;
    default:
      if (event === 'stateChanged' && state.status === 'paused' && session?.sessionId === state.sessionId) {
        await savePosition(session, state, { force: true }).catch(() => {});
      }
      await setBadge(state.status);
  }

  await broadcast(Target.POPUP, MessageType.PLAYER_STATE, { state: await withChapterStatus(state), event });
  return { ok: true };
}

/** Highlights the chunk's paragraph and, for long paragraphs, the part being read. */
async function highlight(session, chunk) {
  if (session.kind !== 'chapter' || session.tabId == null) return;
  const { paragraphIndexes = [], paragraphIndex = null, parts = 1, startOffset = null, endOffset = null } = chunk;
  await chrome.tabs
    .sendMessage(
      session.tabId,
      envelope(Target.CONTENT, MessageType.HIGHLIGHT, { url: session.url, paragraphIndexes, paragraphIndex, parts, startOffset, endOffset }),
      { frameId: 0 },
    )
    .catch(() => {}); // tab navigated or closed
}

async function clearHighlight(session) {
  const s = session ?? (await getActiveSession());
  if (!s || s.kind !== 'chapter' || s.tabId == null) return;
  await chrome.tabs
    .sendMessage(s.tabId, envelope(Target.CONTENT, MessageType.CLEAR_HIGHLIGHT, { url: s.url }), { frameId: 0 })
    .catch(() => {});
}

async function setBadge(status) {
  const badges = {
    playing: ['▶', '#3949ab'],
    loading: ['▶', '#3949ab'],
    buffering: ['▶', '#3949ab'],
    error: ['!', '#c62828'],
    finished: ['✓', '#2e7d32'],
    stopped: ['✓', '#2e7d32'], // chapter done, could not continue automatically
    next: ['→', '#3949ab'], // loading the next chapter
  };
  const [text, color] = badges[status] ?? ['', null];
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}
