// Offscreen document: owns the Player and fetches audio from the backend itself
// (runtime messaging only carries JSON, so audio never travels through it).
// Offscreen documents only get chrome.runtime: no chrome.storage. Settings arrive
// with PLAYER_LOAD (backend URL, API token, voice), PLAYER_SET_VOICE and PLAYER_SET_API_TOKEN, and state goes back to
// the service worker as PLAYER_EVENT.
//
// Finished chunks are also kept in the persistent audio cache (Cache Storage, see
// audio-store.js), which outlives this document: Chrome closes it after ~30 s of silence.

import { Player } from '../player/player.js';
import { fetchSpeech } from '../player/tts-client.js';
import { createAudioStore } from '../player/audio-store.js';
import { PREPARED_TTL_MS } from '../background/navigation.js';
import { DEFAULTS } from '../shared/settings.js';
import { MessageType, Target, broadcast, listen } from '../shared/messages.js';

let backendUrl = DEFAULTS.backendUrl;
let apiToken = ''; // X-Chapterly-Token, if the backend requires one
let preparedTimer = null;
const audioStore = createAudioStore();

const player = new Player({
  audios: [document.getElementById('audio-a'), document.getElementById('audio-b')],
  // The player adds {provider, voice} of the current selection, a request id and a
  // priority to every request.
  fetchSpeech: (text, options) => fetchSpeech(text, { ...options, baseUrl: backendUrl, apiToken }),
  audioStore,
  onEvent: ({ type, data, state }) => {
    void broadcast(Target.BACKGROUND, MessageType.PLAYER_EVENT, { event: type, data: data ?? null, state });
  },
});

function applySettings(payload) {
  if (payload.backendUrl) backendUrl = payload.backendUrl;
  if ('apiToken' in payload) apiToken = payload.apiToken || '';
  if (payload.playbackRate != null) player.playbackRate = payload.playbackRate;
}

function clearPreparedTimer() {
  clearTimeout(preparedTimer);
  preparedTimer = null;
}

/**
 * Warms up a chapter the user may start in a moment. An idle or paused player loads it
 * PAUSED (marked prepared; the service worker ignores its events). A busy player is left
 * alone: the chunk is only fetched into the persistent cache, at prefetch priority.
 */
function prepare(payload) {
  applySettings(payload);
  const { session, voice = null, startIndex = 0 } = payload;
  const busy = ['playing', 'loading', 'buffering'].includes(player.getState().status);
  if (busy) {
    void warmPersistentCache(session.chunks[startIndex]?.text, voice);
    return;
  }
  player.load({ ...session, voice, startIndex, prepared: true });
  clearPreparedTimer();
  preparedTimer = setTimeout(() => {
    preparedTimer = null;
    if (player.getState().prepared) player.unload(); // never started: drop it
  }, PREPARED_TTL_MS);
}

async function warmPersistentCache(text, selection) {
  if (!text) return;
  const sel = selection?.provider ? selection : null;
  if (await audioStore.get(sel, text)) return;
  try {
    const result = await fetchSpeech(text, {
      baseUrl: backendUrl,
      apiToken,
      provider: sel?.provider,
      voice: sel?.voice,
      requestId: crypto.randomUUID(),
      priority: 'prefetch',
    });
    await audioStore.put(sel, text, result);
  } catch {
    // warming up is best effort
  }
}

listen(Target.OFFSCREEN, async ({ type, payload }) => {
  switch (type) {
    case MessageType.PLAYER_LOAD:
      applySettings(payload);
      clearPreparedTimer();
      player.load({
        ...payload.session,
        voice: payload.voice ?? null,
        startIndex: payload.startIndex ?? 0,
        startTime: payload.startTime ?? 0,
        paused: Boolean(payload.startPaused), // restored after a long pause: load, don't play
      });
      if (payload.autoplay) player.play();
      break;
    case MessageType.PLAYER_PREPARE:
      prepare(payload);
      break;
    case MessageType.PLAYER_DROP_PREFETCH:
      player.dropPrefetches();
      break;
    case MessageType.PLAYER_CLEAR_AUDIO_CACHE:
      await audioStore.clear();
      return { ok: true };
    case MessageType.PLAYER_SET_API_TOKEN:
      apiToken = payload.apiToken || '';
      break;
    case MessageType.PLAYER_SET_VOICE:
      player.setVoice(payload); // restarts the current chunk if playing or paused
      break;
    case MessageType.PLAYER_PLAY:
      player.play(); // progress arrives as events
      break;
    case MessageType.PLAYER_RESUME:
      player.resume();
      break;
    case MessageType.PLAYER_PAUSE:
      player.pause();
      break;
    case MessageType.PLAYER_STOP:
      player.stop();
      break;
    case MessageType.PLAYER_SEEK:
      player.seekToChunk(payload.index);
      break;
    case MessageType.PLAYER_NEXT:
      player.next();
      break;
    case MessageType.PLAYER_PREVIOUS:
      player.previous();
      break;
    case MessageType.PLAYER_NEXT_PARAGRAPH:
      player.nextParagraph();
      break;
    case MessageType.PLAYER_PREVIOUS_PARAGRAPH:
      player.previousParagraph();
      break;
    case MessageType.PLAYER_SET_RATE:
      player.playbackRate = payload.rate;
      break;
    case MessageType.PLAYER_GET_STATE:
      break;
    default:
      throw new Error(`Unknown offscreen message: ${type}`);
  }
  return player.getState();
});
