// Service worker: coordinator only. Owns the context menus, the offscreen document,
// page injection, command routing, highlighting and the badge. Chrome can kill it at
// any time, so it keeps nothing important in memory: the reading session and the
// latest player snapshot live in chrome.storage.session (via session-store.js).

import { chunkParagraphs, splitIntoChunks } from '../shared/chunker.js';
import { CONTENT_SCRIPT_FILES } from '../content/extractors/registry.js';
import { VOICE_KEYS, getSettings, getVoiceSelection } from '../shared/settings.js';
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

// Voice picked in the popup or options page: apply it to the running player.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !VOICE_KEYS.some((key) => key in changes)) return;
  applyVoiceSelection().catch((err) => console.error('[chapterly] voice change', err));
});

async function applyVoiceSelection() {
  if (!(await hasOffscreen())) return; // the next PLAYER_LOAD/restore reads it from settings
  await toOffscreen(MessageType.PLAYER_SET_VOICE, await getVoiceSelection());
}

listen(Target.BACKGROUND, async ({ type, payload }) => {
  switch (type) {
    case MessageType.READ_SELECTION:
      return readSelectionInTab(payload.tabId);
    case MessageType.READ_CHAPTER:
      return readChapter(payload.tabId);
    case MessageType.PLAYER_COMMAND:
      return handleCommand(payload);
    case MessageType.PLAYER_EVENT:
      return handlePlayerEvent(payload);
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
  const [state, session, snapshot, { backendUrl, provider, voice }] = await Promise.all([
    toOffscreen(MessageType.PLAYER_GET_STATE),
    getActiveSession(),
    getPlayerSnapshot(),
    getSettings(),
  ]);
  const payload = buildRestorePayload(session, state, snapshot, backendUrl, { provider, voice });
  if (payload) await toOffscreen(MessageType.PLAYER_LOAD, payload);
}

// ---------- starting sessions ----------

async function startSession(session) {
  const saved = await saveActiveSession({ ...session, currentIndex: 0, createdAt: Date.now() });
  await ensureOffscreen();
  const { backendUrl, provider, voice } = await getSettings();
  await toOffscreen(MessageType.PLAYER_LOAD, { session: toPlayerSession(saved), backendUrl, voice: { provider, voice } });
  await toOffscreen(MessageType.PLAYER_PLAY);
  try {
    await chrome.contextMenus.update(MENU_READ_FROM_HERE, { visible: session.kind === 'chapter' });
  } catch {
    // menu not created yet (e.g. right after an update); harmless
  }
  return saved;
}

async function readChapter(tabId) {
  if (tabId == null) return { ok: false, error: 'NO_TAB' };
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

  const chunks = chunkParagraphs(doc.paragraphs);
  const session = await startSession({
    sessionId: crypto.randomUUID(),
    kind: 'chapter',
    tabId,
    url: doc.url,
    title: doc.title,
    seriesTitle: doc.seriesTitle,
    extractorId: doc.extractorId,
    nextChapterUrl: doc.nextChapterUrl,
    prevChapterUrl: doc.prevChapterUrl,
    chunks,
  });
  return {
    ok: true,
    title: session.title,
    extractorId: session.extractorId,
    paragraphs: doc.paragraphs.length,
    total: chunks.length,
    nextChapterUrl: session.nextChapterUrl,
    prevChapterUrl: session.prevChapterUrl,
  };
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
    if (await hasOffscreen()) return toOffscreen(MessageType.PLAYER_GET_STATE);
    return getPlayerSnapshot();
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
    case PlayerCommand.STOP:
      await clearHighlight();
      return toOffscreen(MessageType.PLAYER_STOP);
    case PlayerCommand.NEXT:
      return toOffscreen(MessageType.PLAYER_NEXT);
    case PlayerCommand.PREVIOUS:
      return toOffscreen(MessageType.PLAYER_PREVIOUS);
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
      if (session?.sessionId === state.sessionId) await highlight(session, data?.paragraphIndexes ?? []);
      await setBadge(state.status);
      break;
    case 'sessionFinished':
      // Step 5 hooks auto-next-chapter in here (session.nextChapterUrl).
      console.info('[chapterly] session finished', data?.sessionId, session?.nextChapterUrl ?? '(no next chapter)');
      await clearHighlight(session);
      await setBadge('finished');
      break;
    default:
      await setBadge(state.status);
  }

  await broadcast(Target.POPUP, MessageType.PLAYER_STATE, { state, event });
  return { ok: true };
}

async function highlight(session, paragraphIndexes) {
  if (session.kind !== 'chapter' || session.tabId == null) return;
  await chrome.tabs
    .sendMessage(
      session.tabId,
      envelope(Target.CONTENT, MessageType.HIGHLIGHT, { url: session.url, paragraphIndexes }),
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
  };
  const [text, color] = badges[status] ?? ['', null];
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}
