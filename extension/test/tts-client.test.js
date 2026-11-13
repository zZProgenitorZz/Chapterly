import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendError,
  BackendUnreachable,
  EmptyAudio,
  RequestTimeout,
  fetchSpeech,
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
  const info = toErrorInfo(new BackendError(BASE, 503, 'QUOTA', 'quota'));
  assert.deepEqual(JSON.parse(JSON.stringify(info)), {
    kind: 'BackendError',
    message: 'quota',
    url: BASE,
    status: 503,
    reason: 'QUOTA',
  });
  assert.equal(toErrorInfo(new Error('boom')).kind, 'PlaybackError');
});
