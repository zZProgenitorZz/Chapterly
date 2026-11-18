// Message envelope used by every part of the extension:
//   { target: "background" | "offscreen" | "popup", type, payload }
// chrome.runtime.sendMessage is a broadcast, so every listener must ignore
// messages whose target is not its own (and must not return true for them).

export const Target = Object.freeze({
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
  POPUP: 'popup',
  CONTENT: 'content', // injected page script; sent with chrome.tabs.sendMessage
});

export const MessageType = Object.freeze({
  // -> background
  READ_SELECTION: 'READ_SELECTION', // popup asks to read the selection in a tab: {tabId}
  // popup asks to extract and read the chapter in a tab:
  // {tabId, start?: 'ask' | 'top' | 'resume', paragraphIndex?}
  READ_CHAPTER: 'READ_CHAPTER',
  NEXT_CHAPTER: 'NEXT_CHAPTER', // popup "Next chapter" button (auto-next off)
  PLAYER_COMMAND: 'PLAYER_COMMAND', // popup command: {command: PlayerCommand, index?, rate?}
  PLAYER_EVENT: 'PLAYER_EVENT', // offscreen player event: {event, data, state}
  PAGE_COMMAND: 'PAGE_COMMAND', // page keyboard shortcut: {url, command: 'next' | 'previous' | 'toggle'}
  PAGE_SEEK: 'PAGE_SEEK', // page click: {url, paragraphIndex, offset}
  // the session's page is being left (pagehide, SPA URL change): {url}. String duplicated
  // in src/content/page-controls.js.
  PAGE_LEAVING: 'PAGE_LEAVING',
  GET_CONTROLS_STATE: 'GET_CONTROLS_STATE', // floating buttons: {url} -> {ok, status, index, total, error}
  // popup opened on a page without a session: extract and warm up chunk 0 (or the
  // remembered chunk) without playing, if the site permission is granted: {tabId}
  PREPARE_CHAPTER: 'PREPARE_CHAPTER',
  CLEAR_AUDIO_CACHE: 'CLEAR_AUDIO_CACHE', // options page: delete the persistent audio cache

  // -> offscreen
  // {session, backendUrl, apiToken, voice: {provider, voice}, playbackRate, startIndex?, startTime?,
  //  startPaused?, autoplay?}
  PLAYER_LOAD: 'PLAYER_LOAD',
  // like PLAYER_LOAD, but only warms up: loads the session PAUSED (marked prepared) if the
  // player is not busy, else only fetches that chunk into the persistent audio cache
  PLAYER_PREPARE: 'PLAYER_PREPARE',
  PLAYER_DROP_PREFETCH: 'PLAYER_DROP_PREFETCH', // cancel prefetches, keep a ready current chunk
  PLAYER_CLEAR_AUDIO_CACHE: 'PLAYER_CLEAR_AUDIO_CACHE',
  PLAYER_SET_VOICE: 'PLAYER_SET_VOICE', // {provider, voice}
  PLAYER_SET_API_TOKEN: 'PLAYER_SET_API_TOKEN', // {apiToken}: changed in Settings
  PLAYER_PLAY: 'PLAYER_PLAY',
  PLAYER_PAUSE: 'PLAYER_PAUSE',
  PLAYER_RESUME: 'PLAYER_RESUME',
  PLAYER_STOP: 'PLAYER_STOP',
  PLAYER_SEEK: 'PLAYER_SEEK', // {index}
  PLAYER_NEXT: 'PLAYER_NEXT',
  PLAYER_PREVIOUS: 'PLAYER_PREVIOUS',
  PLAYER_NEXT_PARAGRAPH: 'PLAYER_NEXT_PARAGRAPH',
  PLAYER_PREVIOUS_PARAGRAPH: 'PLAYER_PREVIOUS_PARAGRAPH',
  PLAYER_SET_RATE: 'PLAYER_SET_RATE', // {rate}
  PLAYER_GET_STATE: 'PLAYER_GET_STATE',

  // -> popup
  PLAYER_STATE: 'PLAYER_STATE', // {state, event}

  // -> content (strings duplicated in src/content/highlight.js and page-controls.js)
  HIGHLIGHT: 'HIGHLIGHT', // {url, paragraphIndexes, paragraphIndex, parts, startOffset, endOffset}
  CLEAR_HIGHLIGHT: 'CLEAR_HIGHLIGHT', // {url}
  GET_CONTEXT_PARAGRAPH: 'GET_CONTEXT_PARAGRAPH', // {url} -> {paragraphIndex}
  PAGE_SESSION: 'PAGE_SESSION', // {url, active}: enables keyboard/click control on that page
  // {url, status, index, total, error}: player state for the floating buttons, sent when
  // status or index changed (string duplicated in src/content/floating-controls.js)
  CONTROLS_STATE: 'CONTROLS_STATE',
});

export const PlayerCommand = Object.freeze({
  PLAY: 'play',
  PAUSE: 'pause',
  RESUME: 'resume',
  TOGGLE: 'toggle', // pause if playing, else play/resume (shortcuts)
  STOP: 'stop',
  NEXT: 'next',
  PREVIOUS: 'previous',
  NEXT_PARAGRAPH: 'nextParagraph',
  PREVIOUS_PARAGRAPH: 'previousParagraph',
  SEEK: 'seek', // {index}
  SET_RATE: 'setRate', // {rate}
  GET_STATE: 'getState',
});

export function envelope(target, type, payload = {}) {
  return { target, type, payload };
}

export function isFor(message, target) {
  return message != null && typeof message === 'object' && message.target === target;
}

/** Sends a message and resolves with the response. Rejects if nobody is listening. */
export function send(target, type, payload) {
  return chrome.runtime.sendMessage(envelope(target, type, payload));
}

/** Like send(), but swallows "Receiving end does not exist" (e.g. popup closed). */
export async function broadcast(target, type, payload) {
  try {
    return await send(target, type, payload);
  } catch {
    return undefined;
  }
}

export const toBackground = (type, payload) => send(Target.BACKGROUND, type, payload);
export const toOffscreen = (type, payload) => send(Target.OFFSCREEN, type, payload);

/**
 * Registers a listener for one target. The handler may be async; its return value
 * becomes the response. Errors are returned as {ok: false, error}.
 */
export function listen(target, handler) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isFor(message, target)) return undefined; // not ours: don't hold the channel
    Promise.resolve()
      .then(() => handler(message, sender))
      .then(
        (result) => sendResponse(result),
        (err) => {
          console.error(`[chapterly:${target}]`, message.type, err);
          sendResponse({ ok: false, error: String(err?.message ?? err) });
        },
      );
    return true; // async response
  });
}
