import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelSpeech, cancelUrl, fetchSpeech } from '../src/player/tts-client.js';
import { flush } from './helpers/fakes.js';

const BASE = 'http://localhost:8080';

function audioResponse() {
  return new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'X-TTS-Provider': 'kokoro' } });
}

/** POSTs hang until aborted; DELETEs are recorded and answered 204. */
function recordingFetch({ failDelete = false } = {}) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    if (init.method === 'DELETE') {
      return failDelete ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(new Response(null, { status: 204 }));
    }
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  return { calls, fetchImpl };
}

test('sends X-Chapterly-Request-Id and X-Chapterly-Priority', async () => {
  let headers;
  const fetchImpl = async (_url, init) => {
    headers = init.headers;
    return audioResponse();
  };
  await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl, requestId: 'abc-123', priority: 'prefetch' });
  assert.equal(headers['X-Chapterly-Request-Id'], 'abc-123');
  assert.equal(headers['X-Chapterly-Priority'], 'prefetch');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('without request id or priority no queue headers are sent', async () => {
  let headers;
  await fetchSpeech('Hi', {
    baseUrl: BASE,
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return audioResponse();
    },
  });
  assert.deepEqual(Object.keys(headers), ['Content-Type']);
});

test('aborting the caller signal sends DELETE /api/tts/requests/{id}', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const controller = new AbortController();
  const pending = fetchSpeech('Hi', { baseUrl: `${BASE}/`, fetchImpl, signal: controller.signal, requestId: 'r-1', priority: 'now' });
  await flush(1);
  controller.abort();
  const err = await pending.catch((e) => e);
  assert.equal(err.name, 'AbortError', 'the caller still sees its own abort');
  await flush(1);
  const del = calls.find((c) => c.method === 'DELETE');
  assert.ok(del, 'DELETE sent');
  assert.equal(del.url, `${BASE}/api/tts/requests/r-1`);
});

test('a failing DELETE is ignored', async () => {
  const { calls, fetchImpl } = recordingFetch({ failDelete: true });
  const controller = new AbortController();
  const pending = fetchSpeech('Hi', { baseUrl: BASE, fetchImpl, signal: controller.signal, requestId: 'r-2' });
  controller.abort();
  await pending.catch(() => {});
  await flush(1);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
  // No unhandled rejection: the test runner would report it.
});

test('no DELETE without a request id, and none after the response arrived', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const c1 = new AbortController();
  const p1 = fetchSpeech('Hi', { baseUrl: BASE, fetchImpl, signal: c1.signal });
  c1.abort();
  await p1.catch(() => {});

  const c2 = new AbortController();
  await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl: async () => audioResponse(), signal: c2.signal, requestId: 'done' });
  c2.abort(); // after completion: nothing to cancel
  await flush(1);
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('cancelSpeech never throws', () => {
  assert.equal(cancelUrl('http://x/', 'a b'), 'http://x/api/tts/requests/a%20b');
  cancelSpeech(BASE, 'x', {
    fetchImpl: () => {
      throw new TypeError('bad');
    },
  });
  cancelSpeech(null, 'x');
  cancelSpeech(BASE, null);
});

test('a client timeout also sends the DELETE, so the timed-out request never runs on Kokoro', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout() timers don't keep Node alive
  try {
    const err = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl, requestId: 'slow-1', timeoutMs: 20 }).catch((e) => e);
    assert.equal(err.kind, 'RequestTimeout');
    await flush(1);
    const del = calls.filter((c) => c.method === 'DELETE');
    assert.equal(del.length, 1, 'exactly one DELETE');
    assert.equal(del[0].url, `${BASE}/api/tts/requests/slow-1`);
  } finally {
    clearInterval(keepAlive);
  }
});
