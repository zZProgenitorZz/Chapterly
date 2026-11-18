// Prefetching audio cache for one session. No chrome.* APIs.
//
// Map<index, entry> where each entry holds a Promise<{url, provider, voice, fallback}> (url = object
// URL of the MP3 blob). setCurrent(i) defines the window: chunk i plus the chunks after it
// until at least prefetchChars characters or prefetchMaxChunks chunks are queued past i,
// whichever comes first.
//
// Scheduling:
// - The current chunk is urgent: it is requested at once with priority "now", whatever else
//   is in flight.
// - Prefetches (priority "prefetch", closest first, at most maxInFlight at a time) start only
//   once the current chunk is ready, so after a seek all capacity goes to the chunk the
//   listener is waiting for.
//
// What is kept when the window moves:
// - a back buffer of ready chunks behind the current one: current-1 always, then back to
//   current-backChunks as long as fewer than backChars characters are behind;
// - ready chunks just past the window (up to windowEnd + KEEP_AHEAD), e.g. after a backward seek;
// - requests still loading within ABORT_DISTANCE chunks of the window (they finish and are
//   needed shortly). Everything else is aborted (the backend is told to drop it) or revoked.
//
// A failed request is retried once after retryDelayMs. With a `persistent` store, a chunk is
// looked up there before it is requested, and finished audio is written there (not awaited).

export const DEFAULT_PREFETCH = Object.freeze({ prefetchChars: 1500, prefetchMaxChunks: 6 });
export const DEFAULT_BACK_BUFFER = Object.freeze({ backChunks: 5, backChars: 2000 });
/** Ready chunks up to windowEnd + KEEP_AHEAD survive a backward seek. */
export const KEEP_AHEAD = 3;
/** Loading requests more than this many chunks outside the window are aborted. */
export const ABORT_DISTANCE = 3;

const defaultRequestId = () => globalThis.crypto.randomUUID();

export class AudioCache {
  #fetchSpeech;
  #texts;
  #urls;
  #prefetchChars;
  #prefetchMaxChunks;
  #maxInFlight;
  #retryDelayMs;
  #backChunks;
  #backChars;
  #persistent;
  #newRequestId;

  #entries = new Map();
  #current = 0;

  /**
   * @param {object} opts
   * @param {(text: string, o: {signal, requestId, priority}) => Promise<{blob: Blob, provider: string}>} opts.fetchSpeech
   * @param {string[]} opts.texts chunk texts by index
   * @param {number} [opts.maxInFlight] prefetch requests at a time (the current chunk is extra)
   * @param {{lookup: (text) => Promise<object|null>, save: (text, result) => Promise}} [opts.persistent]
   */
  constructor({
    fetchSpeech,
    texts,
    prefetchChars = DEFAULT_PREFETCH.prefetchChars,
    prefetchMaxChunks = DEFAULT_PREFETCH.prefetchMaxChunks,
    maxInFlight = 1,
    retryDelayMs = 1000,
    urls = URL,
    backChunks = DEFAULT_BACK_BUFFER.backChunks,
    backChars = DEFAULT_BACK_BUFFER.backChars,
    persistent = null,
    newRequestId = defaultRequestId,
  }) {
    this.#fetchSpeech = fetchSpeech;
    this.#texts = texts;
    this.#prefetchChars = prefetchChars;
    this.#prefetchMaxChunks = prefetchMaxChunks;
    this.#maxInFlight = Math.max(1, maxInFlight);
    this.#retryDelayMs = retryDelayMs;
    this.#urls = urls;
    this.#backChunks = backChunks;
    this.#backChars = backChars;
    this.#persistent = persistent;
    this.#newRequestId = newRequestId;
  }

  /** Requests (or persistent-cache lookups) running now, the current chunk included. */
  get inFlight() {
    let n = 0;
    for (const entry of this.#entries.values()) if (entry.state === 'loading') n++;
    return n;
  }

  get current() {
    return this.#current;
  }

  /** Indexes currently held (any state), for tests and debugging. */
  indexes() {
    return [...this.#entries.keys()].sort((a, b) => a - b);
  }

  state(index) {
    return this.#entries.get(index)?.state ?? null;
  }

  /** The error of a chunk that failed (after its retry), or null. get() would request it again. */
  failure(index) {
    const entry = this.#entries.get(index);
    return entry?.state === 'failed' ? entry.error : null;
  }

  /** Audio for one chunk. Starts (or restarts, after a failure) the request if needed. */
  get(index) {
    let entry = this.#entries.get(index);
    if (!entry || entry.state === 'failed') entry = this.#create(index);
    this.#pump();
    return entry.promise;
  }

  /** Moves the window to `index`: requests the current chunk, keeps what is useful, drops the rest. */
  setCurrent(index) {
    this.#current = index;
    const last = this.windowEnd(index);
    const back = this.backStart(index);
    for (const entry of [...this.#entries.values()]) {
      const i = entry.index;
      if (i >= index && i <= last) continue; // in the window
      let keep = false;
      if (entry.state === 'ready') {
        keep = (i >= back && i < index) || (i > last && i <= last + KEEP_AHEAD);
      } else if (entry.state === 'loading') {
        keep = i >= index - ABORT_DISTANCE && i <= last + ABORT_DISTANCE;
      }
      if (!keep) this.#drop(entry);
    }
    // The current chunk is wanted now: request it again if it had failed. Failed chunks
    // further ahead stay failed (the player stops there when it reaches them).
    if (this.#entries.get(index)?.state === 'failed') this.#create(index);
    for (let i = index; i <= last; i++) {
      if (!this.#entries.has(i)) this.#create(i);
    }
    this.#pump();
  }

  /** Last chunk index of the prefetch window that starts at `index`. */
  windowEnd(index) {
    let last = index;
    let chars = 0;
    let ahead = 0;
    while (last + 1 < this.#texts.length && ahead < this.#prefetchMaxChunks && chars < this.#prefetchChars) {
      last++;
      ahead++;
      chars += this.#texts[last].length;
    }
    return last;
  }

  /** First chunk index of the back buffer behind `index` (index itself if there is none). */
  backStart(index) {
    let first = index;
    let chars = 0;
    let behind = 0;
    // current-1 always; then further back while both limits hold.
    while (first - 1 >= 0 && behind < this.#backChunks) {
      const length = this.#texts[first - 1].length;
      if (behind > 0 && chars + length > this.#backChars) break;
      first--;
      behind++;
      chars += length;
    }
    return first;
  }

  /** Aborts everything and revokes every object URL. */
  clear() {
    for (const entry of [...this.#entries.values()]) this.#drop(entry);
  }

  /** Drops everything except the chunk at `index` if it is ready (e.g. the tab navigated away). */
  clearExcept(index) {
    for (const entry of [...this.#entries.values()]) {
      if (entry.index === index && entry.state === 'ready') continue;
      this.#drop(entry);
    }
  }

  #create(index) {
    const old = this.#entries.get(index);
    if (old) this.#drop(old);
    const entry = { index, state: 'queued', controller: new AbortController(), url: null, provider: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.promise.catch(() => {}); // aborted prefetches may never be awaited
    this.#entries.set(index, entry);
    return entry;
  }

  #pump() {
    const current = this.#entries.get(this.#current);
    if (current?.state === 'queued') void this.#start(current); // urgent: no in-flight limit
    if (current && current.state !== 'ready') return; // prefetch only once the current chunk is ready

    while (this.#prefetchesInFlight() < this.#maxInFlight) {
      let next = null;
      for (const entry of this.#entries.values()) {
        if (entry.state !== 'queued') continue;
        if (!next || this.#priority(entry) < this.#priority(next)) next = entry;
      }
      if (!next) return;
      void this.#start(next);
    }
  }

  #prefetchesInFlight() {
    let n = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === 'loading' && entry.index !== this.#current) n++;
    }
    return n;
  }

  #priority(entry) {
    const d = entry.index - this.#current;
    return d >= 0 ? d : 1000 - d; // ahead of the current chunk first, closest first
  }

  async #start(entry) {
    entry.state = 'loading'; // synchronous, before the first await: #pump counts it
    try {
      let result = await this.#lookup(entry);
      if (entry.dropped) throw abortError();
      if (!result) {
        result = await this.#fetchWithRetry(entry);
        if (!entry.dropped) this.#save(entry, result);
      }
      if (entry.dropped) throw abortError();
      const { blob, provider, voice = null, fallback = false } = result;
      entry.url = this.#urls.createObjectURL(blob);
      entry.provider = provider;
      entry.state = 'ready';
      entry.resolve({ url: entry.url, provider, voice, fallback });
    } catch (err) {
      if (entry.dropped) {
        entry.reject(err);
        return;
      }
      entry.state = 'failed';
      entry.error = withChunkIndex(err, entry.index);
      entry.reject(entry.error);
    } finally {
      this.#pump();
    }
  }

  async #lookup(entry) {
    if (!this.#persistent) return null;
    try {
      const hit = await this.#persistent.lookup(this.#texts[entry.index]);
      return hit?.blob ? hit : null;
    } catch {
      return null;
    }
  }

  #save(entry, result) {
    if (!this.#persistent || result?.fallback) return;
    try {
      Promise.resolve(this.#persistent.save(this.#texts[entry.index], result)).catch(() => {});
    } catch {
      // the persistent cache is an optimisation only
    }
  }

  async #fetchWithRetry(entry) {
    const { signal } = entry.controller;
    const text = this.#texts[entry.index];
    // Priority is decided per attempt: a prefetch that became the current chunk is "now".
    const options = () => ({
      signal,
      requestId: this.#newRequestId(),
      priority: entry.index === this.#current ? 'now' : 'prefetch',
    });
    try {
      return await this.#fetchSpeech(text, options());
    } catch (err) {
      if (signal.aborted) throw err;
      await delay(this.#retryDelayMs, signal);
      return this.#fetchSpeech(text, options());
    }
  }

  #drop(entry) {
    entry.dropped = true;
    if (this.#entries.get(entry.index) === entry) this.#entries.delete(entry.index);
    if (entry.state === 'ready') {
      this.#urls.revokeObjectURL(entry.url);
    } else if (entry.state === 'queued') {
      entry.reject(abortError());
    } else if (entry.state === 'loading') {
      entry.controller.abort(); // the fetch rejects (and tells the backend to drop it)
    }
  }
}

function withChunkIndex(err, index) {
  try {
    err.chunkIndex = index;
    return err;
  } catch {
    return Object.assign(new Error(String(err?.message ?? err)), { chunkIndex: index });
  }
}

function abortError() {
  return new DOMException('Chunk no longer needed', 'AbortError');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
