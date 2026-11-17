import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  getSettings,
  getVoiceSelection,
  normalizeBackendUrl,
  normalizeVoiceSelection,
  saveSettings,
} from '../src/shared/settings.js';

/** In-memory chrome.storage.sync. */
let stored;
beforeEach(() => {
  stored = {};
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...stored }),
        set: async (items) => Object.assign(stored, items),
      },
    },
  };
});

test('normalizes backend URLs', () => {
  assert.equal(normalizeBackendUrl(' http://localhost:8080/ '), 'http://localhost:8080');
  assert.equal(normalizeBackendUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normalizeBackendUrl('https://tts.example/base/'), 'https://tts.example/base');
});

test('rejects invalid backend URLs', () => {
  assert.throws(() => normalizeBackendUrl('localhost:8080'));
  assert.throws(() => normalizeBackendUrl(''));
  assert.throws(() => normalizeBackendUrl('ftp://localhost'));
});

test('defaults: Kokoro with af_heart', async () => {
  assert.deepEqual(DEFAULTS, { backendUrl: 'http://localhost:8080', provider: 'kokoro', voice: 'af_heart' });
  assert.deepEqual(await getVoiceSelection(), { provider: 'kokoro', voice: 'af_heart' });
});

test('saving a voice selection', async () => {
  await saveSettings({ provider: 'azure', voice: 'en-US-BrianNeural' });
  assert.deepEqual(await getVoiceSelection(), { provider: 'azure', voice: 'en-US-BrianNeural' });
  assert.equal((await getSettings()).backendUrl, 'http://localhost:8080');
});

test('invalid voice selections are rejected', async () => {
  assert.throws(() => normalizeVoiceSelection({ provider: 'kokoro', voice: '' }));
  assert.throws(() => normalizeVoiceSelection({ provider: 'a b', voice: 'x' }));
  await assert.rejects(saveSettings({ voice: '<script>' }));
  assert.deepEqual(await getVoiceSelection(), { provider: 'kokoro', voice: 'af_heart' });
});
