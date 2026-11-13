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
  READ_CHAPTER: 'READ_CHAPTER', // popup asks to extract and read the chapter in a tab: {tabId}
  PLAYER_COMMAND: 'PLAYER_COMMAND', // popup command: {command: PlayerCommand, index?, rate?}
  PLAYER_EVENT: 'PLAYER_EVENT', // offscreen player event: {event, data, state}

  // -> offscreen
  PLAYER_LOAD: 'PLAYER_LOAD', // {session, backendUrl, startIndex?, startTime?}
  PLAYER_PLAY: 'PLAYER_PLAY',
  PLAYER_PAUSE: 'PLAYER_PAUSE',
  PLAYER_RESUME: 'PLAYER_RESUME',
  PLAYER_STOP: 'PLAYER_STOP',
  PLAYER_SEEK: 'PLAYER_SEEK', // {index}
  PLAYER_NEXT: 'PLAYER_NEXT',
  PLAYER_PREVIOUS: 'PLAYER_PREVIOUS',
  PLAYER_SET_RATE: 'PLAYER_SET_RATE', // {rate}
  PLAYER_GET_STATE: 'PLAYER_GET_STATE',

  // -> popup
  PLAYER_STATE: 'PLAYER_STATE', // {state, event}

  // -> content (strings duplicated in src/content/highlight.js)
  HIGHLIGHT: 'HIGHLIGHT', // {url, paragraphIndexes}
  CLEAR_HIGHLIGHT: 'CLEAR_HIGHLIGHT', // {url}
  GET_CONTEXT_PARAGRAPH: 'GET_CONTEXT_PARAGRAPH', // {url} -> {paragraphIndex}
});

export const PlayerCommand = Object.freeze({
  PLAY: 'play',
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP: 'stop',
  NEXT: 'next',
  PREVIOUS: 'previous',
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
