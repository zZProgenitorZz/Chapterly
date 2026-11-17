import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendError,
  BackendUnreachable,
  CLIENT_TIMEOUT_MS,
  EmptyAudio,
  RequestTimeout,
  fetchSpeech,
  fetchVoices,
  speechUrl,
  toErrorInfo,
} from '../src/player/tts-client.js';
import { describeError } from '../src/shared/error-messages.js';

const BASE = 'http://localhost:8080';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch that never resolves until its signal aborts, like a hung backend. */
function hangingFetch(_url, { signal }) {
  // Node's AbortSignal.timeout() timer is unref'd; keep the event loop alive meanwhile.
  const keepAlive = setInterval(() => {}, 1000);
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(keepAlive);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

test('builds the endpoint URL without double slashes', () => {
  assert.equal(speechUrl('http://localhost:8080/'), 'http://localhost:8080/api/tts');
  assert.equal(speechUrl('http://localhost:8080'), 'http://localhost:8080/api/tts');
});

test('success: returns the blob and the X-TTS-Provider header', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(new Uint8Array([0x49, 0x44, 0x33]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg', 'X-TTS-Provider': 'azure' },
    });
  };

  const { blob, provider } = await fetchSpeech('Hello', { baseUrl: BASE, fetchImpl });

  assert.equal(provider, 'azure');
  assert.equal(blob.size, 3);
  assert.equal(seen.url, `${BASE}/api/tts`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.equal(seen.init.headers.Accept, undefined, 'no Accept header, or JSON errors become 406');
  assert.deepEqual(JSON.parse(seen.init.body), { text: 'Hello' });
});

test('fetch throwing -> BackendUnreachable with the URL', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  const err = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl }).catch((e) => e);

  assert.ok(err instanceof BackendUnreachable);
  assert.equal(err.kind, 'BackendUnreachable');
  assert.equal(describeError(toErrorInfo(err)), `Backend not reachable at ${BASE}`);
});

for (const [status, reason, expected] of [
  [503, 'QUOTA', 'Azure quota used up'],
  [504, 'TIMEOUT', 'Azure is not responding'],
  [502, 'UPSTREAM_ERROR', 'Azure returned an error'],
  [400, 'BAD_INPUT', 'text must not be empty'],
  [415, 'BAD_INPUT', 'Content-Type must be application/json'],
]) {
  test(`HTTP ${status} ${reason} -> BackendError with readable message`, async () => {
    const message = reason === 'BAD_INPUT' ? expected : 'details from backend';
    const fetchImpl = async () => jsonResponse(status, { error: reason, message });

    const err = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl }).catch((e) => e);

    assert.ok(err instanceof BackendError);
    assert.equal(err.status, status);
    assert.equal(err.reason, reason);
    assert.equal(err.message, message);
    assert.equal(describeError(toErrorInfo(err)), expected);
  });
}

test('non-JSON error body keeps the status, reason is null', async () => {
  const fetchImpl = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
  const err = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl }).catch((e) => e);

  assert.ok(err instanceof BackendError);
  assert.equal(err.status, 502);
  assert.equal(err.reason, null);
  assert.equal(describeError(toErrorInfo(err)), 'Backend error (HTTP 502)');
});

test('empty 200 body -> EmptyAudio', async () => {
  const fetchImpl = async () => new Response(new Uint8Array(0), { status: 200 });
  const err = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl }).catch((e) => e);
  assert.ok(err instanceof EmptyAudio);
});

test('client-side timeout -> RequestTimeout', async () => {
  const err = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl: hangingFetch, timeoutMs: 20 }).catch((e) => e);
  assert.ok(err instanceof RequestTimeout);
  assert.equal(err.kind, 'RequestTimeout');
});

test('caller abort is passed through as AbortError, not mapped to a TTS error', async () => {
  const controller = new AbortController();
  const pending = fetchSpeech('Hi', { baseUrl: BASE, fetchImpl: hangingFetch, signal: controller.signal });
  controller.abort();
  const err = await pending.catch((e) => e);

  assert.equal(err.name, 'AbortError');
  assert.equal(err.kind, undefined);
});

test('toErrorInfo produces plain JSON-safe objects', () => {
  const info = toErrorInfo(new BackendError(BASE, 503, 'QUOTA', 'quota', 'azure'));
  assert.deepEqual(JSON.parse(JSON.stringify(info)), {
    kind: 'BackendError',
    message: 'quota',
    url: BASE,
    status: 503,
    reason: 'QUOTA',
    provider: 'azure',
  });
  assert.equal(toErrorInfo(new Error('boom')).kind, 'PlaybackError');
});

// ---------- step 4: provider/voice ----------

function audioResponse(headers) {
  return new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200, headers: { 'Content-Type': 'audio/mpeg', ...headers } });
}

test('client timeout stays above the backend Kokoro timeout (30 s)', () => {
  assert.equal(CLIENT_TIMEOUT_MS, 45_000);
});

test('sends provider and voice, parses X-TTS-Provider/Voice/Fallback', async () => {
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return audioResponse({ 'X-TTS-Provider': 'azure', 'X-TTS-Voice': 'en-US-BrianNeural', 'X-TTS-Fallback': 'true' });
  };
  const result = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl, provider: 'kokoro', voice: 'bm_george' });
  assert.deepEqual(sent, { text: 'Hi', provider: 'kokoro', voice: 'bm_george' });
  assert.equal(result.provider, 'azure');
  assert.equal(result.voice, 'en-US-BrianNeural');
  assert.equal(result.fallback, true);
});

test('without provider/voice only the text is sent (backend default)', async () => {
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return audioResponse({ 'X-TTS-Provider': 'kokoro', 'X-TTS-Voice': 'af_heart', 'X-TTS-Fallback': 'false' });
  };
  const result = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl });
  assert.deepEqual(sent, { text: 'Hi' });
  assert.equal(result.voice, 'af_heart');
  assert.equal(result.fallback, false);
});

test('older backends without the new headers still work', async () => {
  const result = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl: async () => audioResponse({ 'X-TTS-Provider': 'azure' }) });
  assert.equal(result.voice, null);
  assert.equal(result.fallback, false);
});

test('error info carries the provider from the error body', async () => {
  const fetchImpl = async () =>
    jsonResponse(503, { error: 'UNAVAILABLE', message: 'Kokoro server not reachable at http://localhost:8880. Is it running?', provider: 'kokoro' });
  const err = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl }).catch((e) => e);
  assert.equal(err.provider, 'kokoro');
  assert.equal(toErrorInfo(err).provider, 'kokoro');
  assert.equal(describeError(toErrorInfo(err)), 'Kokoro is not running. Start the Kokoro server on localhost:8880.');
});

const CATALOG = {
  defaultProvider: 'kokoro',
  providers: [
    { name: 'kokoro', displayName: 'Kokoro (local)', available: true, defaultVoice: 'af_heart', voices: [{ id: 'af_heart', label: 'Heart (US, female)', language: 'en-US', gender: 'female' }] },
    { name: 'azure', displayName: 'Microsoft Azure', available: false, defaultVoice: 'en-US-BrianNeural', voices: [] },
  ],
};

test('fetchVoices: GET /api/voices happy path', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, method: init.method };
    return jsonResponse(200, CATALOG);
  };
  const catalog = await fetchVoices(`${BASE}/`, { fetchImpl });
  assert.deepEqual(seen, { url: `${BASE}/api/voices`, method: 'GET' });
  assert.deepEqual(catalog, CATALOG);
});

test('fetchVoices: typed errors', async () => {
  const down = await fetchVoices(BASE, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }).catch((e) => e);
  assert.ok(down instanceof BackendUnreachable);

  const failing = await fetchVoices(BASE, { fetchImpl: async () => jsonResponse(500, { error: 'UPSTREAM_ERROR', message: 'x' }) }).catch((e) => e);
  assert.ok(failing instanceof BackendError);
  assert.equal(failing.status, 500);

  const garbage = await fetchVoices(BASE, { fetchImpl: async () => new Response('<html>', { status: 200 }) }).catch((e) => e);
  assert.ok(garbage instanceof BackendError);
  assert.match(garbage.message, /invalid voice list/);

  const slow = await fetchVoices(BASE, { fetchImpl: hangingFetch, timeoutMs: 20 }).catch((e) => e);
  assert.ok(slow instanceof RequestTimeout);
});
