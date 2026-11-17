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
  const fetchSpeech = (text, { signal, provider: askedProvider, voice: askedVoice }) =>
    new Promise((resolve, reject) => {
      const req = {
        text,
        signal,
        askedProvider,
        askedVoice,
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

/** Lets pending promise callbacks and 0 ms timers (retry delay in tests) run. */
export const flush = async (times = 4) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 2));
};
