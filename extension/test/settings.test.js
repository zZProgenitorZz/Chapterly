import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  getSettings,
  getVoiceSelection,
  normalizeBackendUrl,
  normalizeVoiceSelection,
  formatRate,
  normalizeRate,
  saveSettings,
  stepRate,
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

test('defaults: Kokoro with af_heart, 1x, auto-next off, page controls on, floating buttons off', async () => {
  assert.deepEqual(DEFAULTS, {
    backendUrl: 'http://localhost:8080',
    provider: 'kokoro',
    voice: 'af_heart',
    playbackRate: 1,
    autoNextChapter: false,
    arrowKeysControl: true,
    clickToJump: true,
    floatingControls: false,
  });
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

test('speed: 0.75x to 2.5x in steps of 0.1x', () => {
  assert.equal(normalizeRate(1), 1);
  assert.equal(normalizeRate(0.5), 0.75);
  assert.equal(normalizeRate(9), 2.5);
  assert.equal(normalizeRate('abc'), 1);
  assert.equal(stepRate(1, 1), 1.1);
  assert.equal(stepRate(1.1, 1), 1.2, 'no floating point drift');
  assert.equal(stepRate(0.8, -1), 0.75, 'clamped at the minimum');
  assert.equal(stepRate(2.5, 1), 2.5);
  let r = 1;
  for (let i = 0; i < 7; i++) r = stepRate(r, 1);
  assert.equal(r, 1.7);
  assert.equal(formatRate(1), '1x');
  assert.equal(formatRate(1.25), '1.25x');
  assert.equal(formatRate(0.75), '0.75x');
});

test('speed and toggles persist in chrome.storage.sync', async () => {
  await saveSettings({ playbackRate: 1.3, autoNextChapter: 'yes', clickToJump: 0 });
  const s = await getSettings();
  assert.equal(s.playbackRate, 1.3);
  assert.equal(s.autoNextChapter, true);
  assert.equal(s.clickToJump, false);
  assert.equal(s.arrowKeysControl, true, 'untouched default');
  await saveSettings({ playbackRate: 7 });
  assert.equal((await getSettings()).playbackRate, 2.5);
});
