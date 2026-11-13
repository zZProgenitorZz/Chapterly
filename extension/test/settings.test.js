import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBackendUrl } from '../src/shared/settings.js';

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
