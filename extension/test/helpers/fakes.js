// Test doubles for the player: a controllable fetchSpeech and a fake <audio>.

/** Stand-in for HTMLAudioElement. finish() simulates the end of the track. */
export class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  paused = true;
  preload = '';
  playbackRate = 1;
  defaultPlaybackRate = 1;
  playCalls = 0;

  play() {
    this.paused = false;
    this.playCalls++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
  load() {
    this.currentTime = 0;
    this.playbackRate = this.defaultPlaybackRate;
  }
  finish() {
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

/**
 * fetchSpeech whose requests stay pending until resolved by the test.
 * requests: [{text, signal, resolve(), reject(err)}]
 */
export function controllableFetch() {
  const requests = [];
  const fetchSpeech = (text, { signal, provider: askedProvider, voice: askedVoice, requestId, priority }) =>
    new Promise((resolve, reject) => {
      const req = {
        text,
        signal,
        askedProvider,
        askedVoice,
        requestId,
        priority,
        settled: false,
        // Answers like the backend: the requested voice, or a fallback when given.
        resolve: (provider = askedProvider ?? 'azure', { voice = askedVoice ?? null, fallback = false } = {}) => {
          req.settled = true;
          resolve({ blob: new Blob([`mp3:${text}`]), provider, voice, fallback });
        },
        reject: (err) => {
          req.settled = true;
          reject(err);
        },
      };
      signal.addEventListener('abort', () => {
        req.aborted = true;
        reject(signal.reason);
      });
      requests.push(req);
    });
  const pending = () => requests.filter((r) => !r.settled && !r.aborted);
  const byText = (text) => requests.findLast((r) => r.text === text);
  return { fetchSpeech, requests, pending, byText };
}

export function fakeUrls() {
  const live = new Set();
  let n = 0;
  return {
    live,
    createObjectURL: () => {
      const url = `blob:fake/${++n}`;
      live.add(url);
      return url;
    },
    revokeObjectURL: (url) => live.delete(url),
  };
}

/** setTimeout/clearTimeout stand-in: timers run only when the test calls tick(). */
export function manualTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    get size() {
      return pending.size;
    },
    /** Runs every pending timer (they all count as elapsed). */
    tick() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, { fn }] of due) fn();
    },
  };
}

/** In-memory persistent audio store with the audio-store.js interface. */
export function memoryAudioStore() {
  const data = new Map();
  const key = (selection, text) => JSON.stringify([selection?.provider ?? '', selection?.voice ?? '', text]);
  const store = {
    data,
    gets: 0,
    puts: [],
    async get(selection, text) {
      store.gets++;
      return data.get(key(selection, text)) ?? null;
    },
    async put(selection, text, result) {
      store.puts.push(text);
      if (result.fallback) return false;
      data.set(key(selection, text), { blob: result.blob, provider: result.provider, voice: result.voice ?? null, fallback: false });
      return true;
    },
  };
  return store;
}

/** Lets pending promise callbacks and 0 ms timers (retry delay in tests) run. */
export const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 2));
};
