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
// Seeks (next, previous, paragraph skips, seekToChunk) move the index and the highlight at
// once (chunkSelected). Audio for a target that is already cached plays at once; otherwise
// it is requested only after seekDebounceMs without another seek, so pressing "previous"
// five times requests one chunk, not five.
//
// load({paused: true}) restores a session in PAUSED state: the chunk is loaded (from the
// persistent audio store when possible) at startTime without playing. load({prepared: true})
// does the same for a chapter that is only being warmed up; a later load() of the same
// session at the same chunk reuses it instead of starting over.
//
// Events (onEvent({type, data, state})):
//   stateChanged, chunkStarted {index, paragraphIndexes, ...}, chunkSelected (same data, on
//   every seek, also while paused), buffering {index}, sessionFinished {sessionId},
//   error {kind, message, chunkIndex, ...}

import { AudioCache, DEFAULT_PREFETCH } from './audio-cache.js';
import { toErrorInfo } from './tts-client.js';
import { nextParagraphChunk, paragraphStartChunk } from '../shared/chunker.js';

export const Status = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading', // waiting for the first chunk after play/seek
  BUFFERING: 'buffering', // the next chunk was not ready when the previous one ended
  PLAYING: 'playing',
  PAUSED: 'paused',
  ERROR: 'error',
});

const RESTART_THRESHOLD_S = 3; // previous(): restart the chunk if further in than this
export const SEEK_DEBOUNCE_MS = 200;

export class Player {
  #fetchSpeech;
  #onEvent;
  #urls;
  #cacheOptions;
  #audioStore;
  #seekDebounceMs;
  #timers;
  #seekTimer = null;
  #prepared = false;

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
   * @param {{get, put}} [deps.audioStore] persistent audio store (audio-store.js)
   * @param {number} [deps.maxInFlight] prefetch requests at a time (the current chunk is extra)
   * @param {number} [deps.seekDebounceMs] quiet time before a seek requests uncached audio
   */
  constructor({
    fetchSpeech,
    audios,
    onEvent = () => {},
    urls = URL,
    prefetchChars = DEFAULT_PREFETCH.prefetchChars,
    prefetchMaxChunks = DEFAULT_PREFETCH.prefetchMaxChunks,
    maxInFlight = 1,
    retryDelayMs = 1000,
    audioStore = null,
    seekDebounceMs = SEEK_DEBOUNCE_MS,
    timers = globalThis,
  }) {
    if (typeof fetchSpeech !== 'function') throw new TypeError('Player needs fetchSpeech');
    this.#fetchSpeech = fetchSpeech;
    this.#onEvent = onEvent;
    this.#urls = urls;
    this.#cacheOptions = { prefetchChars, prefetchMaxChunks, maxInFlight, retryDelayMs };
    this.#audioStore = audioStore;
    this.#seekDebounceMs = Math.max(0, seekDebounceMs);
    this.#timers = timers;
    const els = audios ?? [new Audio(), new Audio()];
    this.#slots = els.slice(0, 2).map((el, i) => {
      el.preload = 'auto';
      el.preservesPitch = true; // speed changes must not sound like chipmunks
      el.addEventListener('ended', () => this.#onEnded(i));
      el.addEventListener('error', () => this.#onMediaError(i));
      return { el, index: null, provider: null, voice: null, fallback: false };
    });
  }

  // ---------- public API ----------

  /**
   * @param {{provider, voice}} [voice] voice selection; omitted = keep the current one
   * @param {boolean} [paused] load the start chunk at startTime without playing (status PAUSED)
   * @param {boolean} [prepared] like paused, for a chapter that is only being warmed up
   */
  load({ sessionId, title = '', chunks, startIndex = 0, startTime = 0, meta = null, voice, paused = false, prepared = false }) {
    if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('Session has no chunks');
    if (!prepared && this.#reusePrepared(sessionId, clamp(startIndex | 0, 0, chunks.length - 1), voice)) return;
    this.#resetAudio();
    this.#cache?.clear();
    if (voice !== undefined) this.#selection = normalizeSelection(voice);
    this.#session = {
      sessionId,
      title,
      meta,
      chunks: chunks.map((c, i) => {
        const paragraphIndexes = Array.isArray(c.paragraphIndexes) ? c.paragraphIndexes : [];
        return {
          index: c.index ?? i,
          text: String(c.text),
          paragraphIndexes,
          paragraphIndex: c.paragraphIndex ?? paragraphIndexes[0] ?? i,
          part: c.part ?? 0,
          parts: c.parts ?? 1,
          startOffset: c.startOffset ?? null,
          endOffset: c.endOffset ?? null,
        };
      }),
    };
    const store = this.#audioStore;
    this.#cache = new AudioCache({
      // Read the selection at request time, so requests after setVoice() use the new voice.
      fetchSpeech: (text, options) => this.#fetchSpeech(text, { ...options, ...(this.#selection ?? {}) }),
      texts: this.#session.chunks.map((c) => c.text),
      urls: this.#urls,
      persistent: store && {
        lookup: (text) => store.get(this.#selection, text),
        save: (text, result) => store.put(this.#selection, text, result),
      },
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
    this.#prepared = Boolean(prepared);
    if (paused || prepared) {
      void this.#startAt(this.#index); // loads the chunk at startTime; status PAUSED, nothing plays
    } else {
      this.#setStatus(Status.IDLE);
    }
  }

  /** load() of the prepared session at the same chunk: keep the audio that is already there. */
  #reusePrepared(sessionId, startIndex, voice) {
    if (!this.#prepared || sessionId == null || this.#session?.sessionId !== sessionId || startIndex !== this.#index) {
      return false;
    }
    this.#prepared = false;
    if (voice !== undefined && !sameSelection(normalizeSelection(voice), this.#selection)) {
      this.setVoice(voice); // restarts the chunk in the new voice; stays paused
    } else {
      this.#emit('stateChanged');
    }
    return true;
  }

  /** Forgets the session (e.g. a prepared chapter that was never started). Emits nothing. */
  unload() {
    this.#resetAudio();
    this.#cache?.clear();
    this.#cache = null;
    this.#session = null;
    this.#prepared = false;
    this.#index = 0;
    this.#startTime = 0;
    this.#wantPlay = false;
    this.#error = null;
    this.#finished = false;
    this.#status = Status.IDLE;
  }

  /**
   * Cancels every prefetch and drops cached audio except a ready current chunk (the tab
   * navigated away: this session should stop occupying the backend).
   */
  dropPrefetches() {
    if (!this.#cache) return;
    const other = this.#slots[1 - this.#active];
    if (other.index != null && other.index !== this.#index) clearSlot(other);
    this.#cache.clearExcept(this.#index);
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
        this.#prepared = false;
        const slot = this.#slots[this.#active];
        if (slot.index === this.#index) {
          this.#playElement(slot.el, this.#gen);
          this.#setStatus(Status.PLAYING);
          // Refill the window, in case prefetches were dropped while paused.
          this.#cache.setCurrent(this.#index);
          if (this.#slots[1 - this.#active].index == null) this.#preloadNext(this.#gen);
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

  /**
   * Jumps to a chunk. Keeps playing if playing, stays paused if paused. The index and the
   * highlight move at once (chunkSelected); audio that is not cached is requested only after
   * seekDebounceMs without another seek.
   */
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
    this.#prepared = false;
    if (this.#seekDebounceMs === 0 || this.#cache.state(target) === 'ready') {
      void this.#startAt(target); // cached: plays within microtasks
    } else {
      this.#resetAudio(); // stops the old chunk now; also cancels an earlier pending seek
      this.#index = target;
      this.#waiting = Status.LOADING;
      this.#setStatus(this.#wantPlay ? Status.LOADING : Status.PAUSED);
      this.#seekTimer = this.#timers.setTimeout(() => {
        this.#seekTimer = null;
        void this.#startAt(this.#index);
      }, this.#seekDebounceMs);
    }
    this.#emitChunk('chunkSelected');
  }

  /** True while a debounced seek has not requested its audio yet. */
  get seekPending() {
    return this.#seekTimer != null;
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

  /** First chunk of the next paragraph, even if the current paragraph has more parts. */
  nextParagraph() {
    if (!this.#session) return;
    const target = nextParagraphChunk(this.#session.chunks, this.#index);
    if (target >= 0) this.seekToChunk(target);
  }

  /**
   * First chunk of the previous paragraph. Like previous(): if we are already into the
   * current paragraph (past its first part, or more than 3 s in), go to its start instead.
   */
  previousParagraph() {
    if (!this.#session) return;
    const chunks = this.#session.chunks;
    const start = paragraphStartChunk(chunks, this.#index);
    const slot = this.#slots[this.#active];
    const intoParagraph = this.#index > start || (slot.index === this.#index && slot.el.currentTime > RESTART_THRESHOLD_S);
    if (intoParagraph) {
      this.seekToChunk(start);
    } else if (start > 0) {
      this.seekToChunk(paragraphStartChunk(chunks, start - 1));
    } else if (slot.index === this.#index) {
      slot.el.currentTime = 0;
      this.#emit('stateChanged');
    }
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
      paragraphIndex: chunk?.paragraphIndex ?? null,
      finished: this.#finished, // the session played to its end
      prepared: this.#prepared, // only warmed up (PREPARE_CHAPTER), not the session being read
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
      this.#emitChunk('chunkStarted');
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
    if (this.#seekTimer != null) {
      this.#timers.clearTimeout(this.#seekTimer);
      this.#seekTimer = null;
    }
    for (const slot of this.#slots) clearSlot(slot);
  }

  #emitChunk(type) {
    const { index, paragraphIndexes, paragraphIndex, part, parts, startOffset, endOffset } = this.#session.chunks[this.#index];
    this.#emit(type, { index, paragraphIndexes, paragraphIndex, part, parts, startOffset, endOffset });
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
