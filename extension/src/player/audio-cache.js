// Prefetching audio cache for one session. No chrome.* APIs.
//
// Map<index, entry> where each entry holds a Promise<{url, provider, voice, fallback}> (url = object
// URL of the MP3 blob). setCurrent(i) defines the window [i, i + prefetchAhead]:
// those chunks are requested (closest first, at most maxInFlight at a time), the
// finished chunk i-1 is kept, and everything else is aborted or revoked.
// A failed request is retried once after retryDelayMs.

export class AudioCache {
  #fetchSpeech;
  #texts;
  #urls;
  #prefetchAhead;
  #maxInFlight;
  #retryDelayMs;

  #entries = new Map();
  #current = 0;
  #inFlight = 0;

  /**
   * @param {object} opts
   * @param {(text: string, o: {signal: AbortSignal}) => Promise<{blob: Blob, provider: string}>} opts.fetchSpeech
   * @param {string[]} opts.texts chunk texts by index
   */
  constructor({ fetchSpeech, texts, prefetchAhead = 2, maxInFlight = 2, retryDelayMs = 1000, urls = URL }) {
    this.#fetchSpeech = fetchSpeech;
    this.#texts = texts;
    this.#prefetchAhead = prefetchAhead;
    this.#maxInFlight = Math.max(1, maxInFlight);
    this.#retryDelayMs = retryDelayMs;
    this.#urls = urls;
  }

  get inFlight() {
    return this.#inFlight;
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

  /** Moves the window to `index`: prefetches ahead, drops what is no longer needed. */
  setCurrent(index) {
    this.#current = index;
    const last = Math.min(index + this.#prefetchAhead, this.#texts.length - 1);
    for (const entry of [...this.#entries.values()]) {
      const inWindow = entry.index >= index && entry.index <= last;
      const justFinished = entry.index === index - 1 && entry.state === 'ready';
      if (!inWindow && !justFinished) this.#drop(entry);
    }
    // The current chunk is wanted now: request it again if it had failed. Failed
    // chunks further ahead stay failed (the player stops there when it reaches them).
    if (this.#entries.get(index)?.state === 'failed') this.#create(index);
    for (let i = index; i <= last; i++) {
      if (!this.#entries.has(i)) this.#create(i);
    }
    this.#pump();
  }

  /** Aborts everything and revokes every object URL. */
  clear() {
    for (const entry of [...this.#entries.values()]) this.#drop(entry);
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
    while (this.#inFlight < this.#maxInFlight) {
      let next = null;
      for (const entry of this.#entries.values()) {
        if (entry.state !== 'queued') continue;
        if (!next || this.#priority(entry) < this.#priority(next)) next = entry;
      }
      if (!next) return;
      void this.#start(next);
    }
  }

  #priority(entry) {
    const d = entry.index - this.#current;
    return d >= 0 ? d : 1000 - d; // ahead of the current chunk first, closest first
  }

  async #start(entry) {
    entry.state = 'loading';
    this.#inFlight++;
    try {
      const { blob, provider, voice = null, fallback = false } = await this.#fetchWithRetry(entry);
      if (entry.dropped) return;
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
      this.#inFlight--;
      this.#pump();
    }
  }

  async #fetchWithRetry(entry) {
    const { signal } = entry.controller;
    const text = this.#texts[entry.index];
    try {
      return await this.#fetchSpeech(text, { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      await delay(this.#retryDelayMs, signal);
      return this.#fetchSpeech(text, { signal });
    }
  }

  #drop(entry) {
    entry.dropped = true;
    if (this.#entries.get(entry.index) === entry) this.#entries.delete(entry.index);
    if (entry.state === 'ready') {
      this.#urls.revokeObjectURL(entry.url);
    } else if (entry.state === 'queued') {
      entry.reject(abortError());
    } else {
      entry.controller.abort(); // loading: the fetch rejects and frees its slot
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
