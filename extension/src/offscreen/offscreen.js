// Offscreen document: owns the Player and fetches audio from the backend itself
// (runtime messaging only carries JSON, so audio never travels through it).
// Offscreen documents only get chrome.runtime: no chrome.storage. Settings arrive
// with PLAYER_LOAD, and state goes back to the service worker as PLAYER_EVENT.

import { Player } from '../player/player.js';
import { fetchSpeech } from '../player/tts-client.js';
import { DEFAULTS } from '../shared/settings.js';
import { MessageType, Target, broadcast, listen } from '../shared/messages.js';

let backendUrl = DEFAULTS.backendUrl;

const player = new Player({
  audios: [document.getElementById('audio-a'), document.getElementById('audio-b')],
  fetchSpeech: (text, options) => fetchSpeech(text, { ...options, baseUrl: backendUrl }),
  onEvent: ({ type, data, state }) => {
    void broadcast(Target.BACKGROUND, MessageType.PLAYER_EVENT, { event: type, data: data ?? null, state });
  },
});

listen(Target.OFFSCREEN, ({ type, payload }) => {
  switch (type) {
    case MessageType.PLAYER_LOAD:
      if (payload.backendUrl) backendUrl = payload.backendUrl;
      player.load({
        ...payload.session,
        startIndex: payload.startIndex ?? 0,
        startTime: payload.startTime ?? 0,
      });
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
