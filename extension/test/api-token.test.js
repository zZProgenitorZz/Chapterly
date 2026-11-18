import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApiToken, getSettings, normalizeApiToken, saveApiToken } from '../src/shared/settings.js';
import { BackendError, TOKEN_HEADER, cancelSpeech, fetchSpeech, fetchVoices, toErrorInfo } from '../src/player/tts-client.js';
import { describeError, errorDetail } from '../src/shared/error-messages.js';
import { flush } from './helpers/fakes.js';

const BASE = 'http://100.101.102.103:8080';

let sync;
let local;
beforeEach(() => {
  sync = {};
  local = {};
  globalThis.chrome = {
    storage: {
      sync: { get: async (defaults) => ({ ...defaults, ...sync }), set: async (items) => Object.assign(sync, items) },
      local: { get: async (key) => (key in local ? { [key]: local[key] } : {}), set: async (items) => Object.assign(local, items) },
    },
  };
});

// ---------- storage ----------

test('the token is stored in chrome.storage.local, never in sync', async () => {
  assert.equal(await getApiToken(), '');
  assert.equal(await saveApiToken('  abc123  '), 'abc123');
  assert.deepEqual(local, { apiToken: 'abc123' });
  assert.equal('apiToken' in sync, false);
  assert.equal((await getSettings()).apiToken, 'abc123', 'getSettings() includes it');
});

test('an empty token removes it; tokens with spaces or non-ASCII are rejected', async () => {
  await saveApiToken('abc');
  assert.equal(await saveApiToken('   '), '');
  assert.equal((await getSettings()).apiToken, '');
  assert.throws(() => normalizeApiToken('has space'));
  assert.throws(() => normalizeApiToken('tökén'));
  assert.equal(normalizeApiToken('A-z_0.9~!'), 'A-z_0.9~!');
});

test('without chrome.storage.local (offscreen-like context) the token is empty', async () => {
  delete globalThis.chrome.storage.local;
  assert.equal(await getApiToken(), '');
});

// ---------- client ----------

function recording(response = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'X-TTS-Provider': 'kokoro' } })) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers ?? {} });
      return response(url, init);
    },
  };
}

test('every request carries X-Chapterly-Token when a token is set', async () => {
  const { calls, fetchImpl } = recording((url) =>
    url.endsWith('/api/voices')
      ? new Response(JSON.stringify({ defaultProvider: 'kokoro', providers: [] }), { status: 200 })
      : new Response(new Uint8Array([1]), { status: 200 }),
  );
  await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl, apiToken: 't0ken' });
  await fetchVoices(BASE, { fetchImpl, apiToken: 't0ken' });
  cancelSpeech(BASE, 'r1', { fetchImpl, apiToken: 't0ken' });
  await flush(1);
  assert.deepEqual(
    calls.map((c) => [c.method, c.headers[TOKEN_HEADER]]),
    [
      ['POST', 't0ken'],
      ['GET', 't0ken'],
      ['DELETE', 't0ken'],
    ],
  );
});

test('the cancel DELETE sent on abort also carries the token', async () => {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ method: init.method, token: init.headers?.[TOKEN_HEADER] });
    if (init.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const controller = new AbortController();
  const pending = fetchSpeech('Hi', { baseUrl: BASE, fetchImpl, signal: controller.signal, requestId: 'r2', apiToken: 'abc' });
  controller.abort();
  await pending.catch(() => {});
  await flush(1);
  assert.deepEqual(calls, [
    { method: 'POST', token: 'abc' },
    { method: 'DELETE', token: 'abc' },
  ]);
});

test('no token header without a token', async () => {
  const { calls, fetchImpl } = recording();
  await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl, apiToken: '' });
  assert.equal(TOKEN_HEADER in calls[0].headers, false);
});

// ---------- 401 messages ----------

test('a 401 reads as a token problem, missing vs. wrong', async () => {
  const unauthorized = (message) => async () =>
    new Response(JSON.stringify({ error: 'UNAUTHORIZED', message }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const missing = await fetchSpeech('Hi', { baseUrl: BASE, fetchImpl: unauthorized('Missing X-Chapterly-Token header') }).catch((e) => e);
  assert.ok(missing instanceof BackendError);
  assert.equal(missing.status, 401);
  assert.equal(describeError(toErrorInfo(missing)), 'The backend requires an API token. Enter it under Settings → API token.');

  const wrong = await fetchVoices(BASE, { fetchImpl: unauthorized('Wrong X-Chapterly-Token'), apiToken: 'nope' }).catch((e) => e);
  assert.match(describeError(toErrorInfo(wrong)), /rejected the API token.*CHAPTERLY_API_TOKEN/);
  assert.equal(errorDetail(toErrorInfo(wrong)), '', 'no redundant detail line');
});
