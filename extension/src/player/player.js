// Session-based audio player with prefetch and gapless playback. No chrome.* APIs:
// everything it needs is injected, so it runs in the offscreen document and in tests.
//
// A session is {sessionId, title, chunks: [{index, text, paragraphIndexes}], meta}.
// Audio comes from an AudioCache that keeps the next chunks requested ahead.
// Two audio elements alternate: while one plays chunk i, the other already holds
// chunk i+1, so on "ended" the next chunk starts immediately.
//
// The voice selection ({provider, voice}) is passed to fetchSpeech with every request.
// setVoice() drops the prefetched audio and restarts the current chunk in the new voice.
//
// Events (onEvent({type, data, state})):
//   stateChanged, chunkStarted {index, paragraphIndexes}, buffering {index},
//   sessionFinished {sessionId}, error {kind, message, chunkIndex, ...}

import { AudioCache } from './audio-cache.js';
import { toErrorInfo } from './tts-client.js';

export const Status = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading', // waiting for the first chunk after play/seek
  BUFFERING: 'buffering', // the next chunk was not ready when the previous one ended
  PLAYING: 'playing',
  PAUSED: 'paused',
  ERROR: 'error',
});

const RESTART_THRESHOLD_S = 3; // previous(): restart the chunk if further in than this

export class Player {
  #fetchSpeech;
  #onEvent;
  #urls;
  #cacheOptions;

  #slots; // [{el, index, provider, voice, fallback}] x2
  #active = 0;

  #session = null;
  #cache = null;
  #index = 0;
  #status = Status.IDLE;
  #waiting = Status.LOADING; // what PAUSED returns to if no audio is loaded yet
  #wantPlay = false;
  #selection = null; // {provider, voice} requested; null = backend default
  #provider = null; // provider/voice/fallback of the chunk that is playing
  #voice = null;
  #fallback = false;
  #error = null;
  #finished = false;
  #startTime = 0;
  #rate = 1;
  #gen = 0; // bumped on every reset; async work from an older generation is ignored

  /**
   * @param {object} deps
   * @param {Function} deps.fetchSpeech (text, {signal, provider, voice}) => Promise<{blob, provider, voice, fallback}>
   * @param {HTMLAudioElement[]} [deps.audios] two audio elements (default: new Audio() x2)
   * @param {Function} [deps.onEvent]
   */
  constructor({
    fetchSpeech,
    audios,
    onEvent = () => {},
    urls = URL,
    prefetchAhead = 2,
    maxInFlight = 2,
    retryDelayMs = 1000,
  }) {
    if (typeof fetchSpeech !== 'function') throw new TypeError('Player needs fetchSpeech');
    this.#fetchSpeech = fetchSpeech;
    this.#onEvent = onEvent;
    this.#urls = urls;
    this.#cacheOptions = { prefetchAhead, maxInFlight, retryDelayMs };
    const els = audios ?? [new Audio(), new Audio()];
    this.#slots = els.slice(0, 2).map((el, i) => {
      el.preload = 'auto';
      el.addEventListener('ended', () => this.#onEnded(i));
      el.addEventListener('error', () => this.#onMediaError(i));
      return { el, index: null, provider: null, voice: null, fallback: false };
    });
  }

  // ---------- public API ----------

  /** @param {{provider, voice}} [voice] voice selection; omitted = keep the current one */
  load({ sessionId, title = '', chunks, startIndex = 0, startTime = 0, meta = null, voice }) {
    if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('Session has no chunks');
    this.#resetAudio();
    this.#cache?.clear();
    if (voice !== undefined) this.#selection = normalizeSelection(voice);
    this.#session = {
      sessionId,
      title,
      meta,
      chunks: chunks.map((c, i) => ({
        index: c.index ?? i,
        text: String(c.text),
        paragraphIndexes: Array.isArray(c.paragraphIndexes) ? c.paragraphIndexes : [],
      })),
    };
    this.#cache = new AudioCache({
      // Read the selection at request time, so requests after setVoice() use the new voice.
      fetchSpeech: (text, options) => this.#fetchSpeech(text, { ...options, ...(this.#selection ?? {}) }),
      texts: this.#session.chunks.map((c) => c.text),
      urls: this.#urls,
      ...this.#cacheOptions,
    });
    this.#index = clamp(startIndex | 0, 0, chunks.length - 1);
    this.#startTime = Math.max(0, Number(startTime) || 0);
    this.#provider = null;
    this.#voice = null;
    this.#fallback = false;
    this.#error = null;
    this.#finished = false;
    this.#wantPlay = false;
    this.#setStatus(Status.IDLE);
  }

  /** Starts, resumes, or retries after an error. Restarts from the top after the session finished. */
  play() {
    if (!this.#session) return;
    switch (this.#status) {
      case Status.PLAYING:
      case Status.LOADING:
      case Status.BUFFERING:
        return;
      case Status.PAUSED: {
        this.#wantPlay = true;
        const slot = this.#slots[this.#active];
        if (slot.index === this.#index) {
          this.#playElement(slot.el, this.#gen);
          this.#setStatus(Status.PLAYING);
        } else {
          this.#setStatus(this.#waiting); // audio still on its way
        }
        return;
      }
      default: // idle, error
        if (this.#finished) {
          this.#finished = false;
          this.#index = 0;
          this.#startTime = 0;
        }
        this.#error = null;
        this.#wantPlay = true;
        void this.#startAt(this.#index);
    }
  }

  resume() {
    this.play();
  }

  pause() {
    this.#wantPlay = false;
    if (this.#status === Status.PLAYING) {
      this.#slots[this.#active].el.pause();
      this.#setStatus(Status.PAUSED);
    } else if (this.#status === Status.LOADING || this.#status === Status.BUFFERING) {
      this.#waiting = this.#status;
      this.#setStatus(Status.PAUSED);
    }
  }

  /** Aborts all requests, stops audio, frees memory. The session stays loaded. */
  stop() {
    this.#resetAudio();
    this.#cache?.clear();
    this.#index = 0;
    this.#startTime = 0;
    this.#error = null;
    this.#finished = false;
    this.#wantPlay = false;
    this.#setStatus(Status.IDLE);
  }

  /** Jumps to a chunk. Keeps playing if playing, stays paused if paused. */
  seekToChunk(index) {
    if (!this.#session) return;
    const target = clamp(index | 0, 0, this.#session.chunks.length - 1);
    this.#startTime = 0;
    this.#finished = false;
    if (this.#status === Status.IDLE || this.#status === Status.ERROR) {
      this.#resetAudio();
      this.#index = target;
      this.#error = null;
      this.#setStatus(Status.IDLE);
      return;
    }
    this.#wantPlay = this.#status !== Status.PAUSED;
    void this.#startAt(target);
  }

  next() {
    if (this.#session && this.#index + 1 < this.#session.chunks.length) this.seekToChunk(this.#index + 1);
  }

  /** Restarts the current chunk if more than 3 s in, else goes back one chunk. */
  previous() {
    if (!this.#session) return;
    const slot = this.#slots[this.#active];
    const loaded = slot.index === this.#index;
    if (loaded && (slot.el.currentTime > RESTART_THRESHOLD_S || this.#index === 0)) {
      slot.el.currentTime = 0;
      this.#emit('stateChanged');
      return;
    }
    if (this.#index > 0) this.seekToChunk(this.#index - 1);
  }

  get voiceSelection() {
    return this.#selection;
  }

  /**
   * Switches the voice ({provider, voice}). Prefetched chunks were made with the old
   * voice, so they are dropped. If a chunk is playing or paused, the current chunk
   * restarts from its beginning in the new voice and play/pause state is kept; the
   * old audio is stopped first, so nothing overlaps.
   */
  setVoice(selection) {
    const next = normalizeSelection(selection);
    if (sameSelection(next, this.#selection)) return;
    this.#selection = next;
    if (!this.#session) return;

    const active = this.#status !== Status.IDLE && this.#status !== Status.ERROR;
    this.#resetAudio(); // stop old audio before its object URL is revoked
    this.#cache.clear();
    if (!active) {
      this.#emit('stateChanged');
      return;
    }
    this.#startTime = 0;
    this.#wantPlay = this.#status !== Status.PAUSED;
    void this.#startAt(this.#index);
  }

  get playbackRate() {
    return this.#rate;
  }

  /** Applied to both audio elements. Step 5 exposes it in the UI. */
  set playbackRate(rate) {
    const r = clamp(Number(rate) || 1, 0.5, 3);
    this.#rate = r;
    for (const { el } of this.#slots) {
      el.defaultPlaybackRate = r;
      el.playbackRate = r;
    }
    this.#emit('stateChanged');
  }

  getState() {
    const slot = this.#slots[this.#active];
    const chunk = this.#session?.chunks[this.#index];
    return {
      status: this.#status,
      sessionId: this.#session?.sessionId ?? null,
      title: this.#session?.title ?? '',
      meta: this.#session?.meta ?? null,
      index: this.#index,
      total: this.#session?.chunks.length ?? 0,
      paragraphIndexes: chunk?.paragraphIndexes ?? [],
      provider: this.#provider, // provider, voice and fallback of the chunk that is playing
      voice: this.#voice,
      fallback: this.#fallback,
      selection: this.#selection, // the voice the user picked
      error: this.#error,
      position: slot.index === this.#index ? Number(slot.el.currentTime) || 0 : 0,
      playbackRate: this.#rate,
    };
  }

  // ---------- internals ----------

  async #startAt(index) {
    this.#resetAudio();
    const gen = this.#gen;
    this.#index = index;
    this.#cache.setCurrent(index);
    this.#waiting = Status.LOADING;
    this.#setStatus(this.#wantPlay ? Status.LOADING : Status.PAUSED);

    let audio;
    try {
      audio = await this.#cache.get(index);
    } catch (err) {
      if (gen === this.#gen) this.#fail(err, index);
      return;
    }
    if (gen !== this.#gen) return;
    this.#loadInto(this.#active, index, audio);
    if (this.#startTime > 0) {
      this.#slots[this.#active].el.currentTime = this.#startTime;
      this.#startTime = 0;
    }
    this.#beginChunk(gen);
  }

  /** The active slot holds the current chunk: play it (if wanted) and preload the next. */
  #beginChunk(gen) {
    const slot = this.#slots[this.#active];
    this.#provider = slot.provider;
    this.#voice = slot.voice;
    this.#fallback = slot.fallback;
    if (this.#wantPlay) {
      this.#playElement(slot.el, gen); // first, to keep the gap minimal
      this.#setStatus(Status.PLAYING);
      const { index, paragraphIndexes } = this.#session.chunks[this.#index];
      this.#emit('chunkStarted', { index, paragraphIndexes });
    } else {
      this.#setStatus(Status.PAUSED);
    }
    this.#preloadNext(gen);
  }

  #preloadNext(gen) {
    const forIndex = this.#index;
    const next = forIndex + 1;
    if (next >= this.#session.chunks.length) return;
    this.#cache.get(next).then(
      (audio) => {
        if (gen !== this.#gen || this.#index !== forIndex) return;
        this.#loadInto(1 - this.#active, next, audio);
      },
      () => {}, // surfaces (after the retry) when playback reaches that chunk
    );
  }

  #onEnded(slotIndex) {
    if (slotIndex !== this.#active || this.#status !== Status.PLAYING || !this.#session) return;
    const gen = this.#gen;
    const next = this.#index + 1;
    const finishedSlot = this.#slots[this.#active];

    if (next >= this.#session.chunks.length) {
      this.#resetAudio();
      this.#cache.clear();
      this.#finished = true;
      this.#wantPlay = false;
      this.#setStatus(Status.IDLE);
      this.#emit('sessionFinished', { sessionId: this.#session.sessionId });
      return;
    }

    this.#index = next;
    const other = 1 - this.#active;
    if (this.#slots[other].index === next) {
      // Gapless: the next chunk is already loaded in the other element.
      this.#active = other;
      clearSlot(finishedSlot);
      this.#cache.setCurrent(next);
      this.#beginChunk(gen);
      return;
    }

    clearSlot(finishedSlot);
    const failure = this.#cache.failure(next);
    if (failure) {
      // Its prefetch already failed twice (request + retry): stop here. play() retries.
      this.#fail(failure, next);
      return;
    }
    this.#cache.setCurrent(next);
    this.#waiting = Status.BUFFERING;
    this.#setStatus(Status.BUFFERING);
    this.#emit('buffering', { index: next });
    this.#cache.get(next).then(
      (audio) => {
        if (gen !== this.#gen || this.#index !== next) return;
        this.#loadInto(this.#active, next, audio);
        this.#beginChunk(gen);
      },
      (err) => {
        if (gen === this.#gen && this.#index === next) this.#fail(err, next);
      },
    );
  }

  #onMediaError(slotIndex) {
    const slot = this.#slots[slotIndex];
    if (slot.index == null) return; // fired while clearing src
    if (slotIndex === this.#active && slot.index === this.#index) {
      this.#fail(Object.assign(new Error('The audio could not be decoded'), { kind: 'PlaybackError' }), this.#index);
    } else {
      clearSlot(slot); // a preloaded chunk failed to decode; it is retried when reached
    }
  }

  #loadInto(slotIndex, index, audio) {
    const slot = this.#slots[slotIndex];
    slot.index = index;
    slot.provider = audio.provider;
    slot.voice = audio.voice ?? null;
    slot.fallback = Boolean(audio.fallback);
    slot.el.src = audio.url;
    slot.el.defaultPlaybackRate = this.#rate;
    slot.el.playbackRate = this.#rate;
  }

  #playElement(el, gen) {
    el.playbackRate = this.#rate;
    let result;
    try {
      result = el.play();
    } catch (err) {
      result = Promise.reject(err);
    }
    Promise.resolve(result).catch((err) => {
      // AbortError: pause()/seek interrupted play(); not a failure.
      if (gen !== this.#gen || err?.name === 'AbortError') return;
      this.#fail(Object.assign(new Error(err?.message ?? 'Playback failed'), { kind: 'PlaybackError' }), this.#index);
    });
  }

  #fail(err, index) {
    this.#resetAudio();
    this.#index = index;
    this.#wantPlay = false;
    this.#error = { ...toErrorInfo(err), chunkIndex: index };
    this.#setStatus(Status.ERROR);
    this.#emit('error', this.#error);
  }

  #resetAudio() {
    this.#gen++;
    for (const slot of this.#slots) clearSlot(slot);
  }

  #setStatus(status) {
    this.#status = status;
    this.#emit('stateChanged');
  }

  #emit(type, data) {
    try {
      this.#onEvent({ type, data, state: this.getState() });
    } catch (err) {
      console.error('[chapterly:player] event listener failed', err);
    }
  }
}

function clearSlot(slot) {
  slot.index = null;
  slot.provider = null;
  slot.voice = null;
  slot.fallback = false;
  slot.el.pause();
  slot.el.removeAttribute('src');
  slot.el.load?.();
}

/** {provider, voice} with both set, or null (= backend default). */
function normalizeSelection(selection) {
  if (!selection?.provider) return null;
  return { provider: String(selection.provider), voice: selection.voice ? String(selection.voice) : undefined };
}

function sameSelection(a, b) {
  return (a?.provider ?? null) === (b?.provider ?? null) && (a?.voice ?? null) === (b?.voice ?? null);
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}
