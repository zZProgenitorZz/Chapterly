import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, errorDetail, providerName } from '../src/shared/error-messages.js';

const backend = (reason, provider, message = 'details') => ({ kind: 'BackendError', reason, provider, message, status: 503 });

test('Kokoro not running', () => {
  assert.equal(
    describeError(backend('UNAVAILABLE', 'kokoro', 'Kokoro server not reachable at http://localhost:8880. Is it running?')),
    'Kokoro is not running. Start the Kokoro server on localhost:8880.',
  );
  assert.equal(
    describeError(backend('UNAVAILABLE', 'kokoro', 'Kokoro server not reachable at http://192.168.1.5:9000. Is it running?')),
    'Kokoro is not running. Start the Kokoro server on 192.168.1.5:9000.',
    'uses the configured address from the backend message',
  );
  assert.equal(errorDetail(backend('UNAVAILABLE', 'kokoro')), '', 'no duplicate detail line');
});

test('provider-aware quota, timeout and upstream texts', () => {
  assert.equal(describeError(backend('QUOTA', 'azure')), 'Azure quota used up');
  assert.equal(describeError(backend('TIMEOUT', 'kokoro')), 'Kokoro is not responding');
  assert.equal(describeError(backend('TIMEOUT', 'azure')), 'Azure is not responding');
  assert.equal(describeError(backend('UPSTREAM_ERROR', 'kokoro')), 'Kokoro returned an error');
  assert.equal(describeError(backend('UPSTREAM_ERROR', 'azure')), 'Azure returned an error');
});

test('voice-related BAD_INPUT points to Settings', () => {
  for (const message of ['Unknown Kokoro voice', 'Unknown Azure voice', "Kokoro rejected the request: Voice 'af_x' not found."]) {
    assert.equal(describeError(backend('BAD_INPUT', 'kokoro', message)), 'This voice is not available. Pick another one in Settings.', message);
  }
});

test('other BAD_INPUT shows the backend message', () => {
  assert.equal(describeError(backend('BAD_INPUT', 'azure', 'Azure is not configured on the backend')), 'Azure is not configured on the backend');
  assert.equal(describeError(backend('BAD_INPUT', null, 'text must not be empty')), 'text must not be empty');
});

test('errors without a provider (pre-step-4 backend) read as Azure', () => {
  assert.equal(providerName(null), 'Azure');
  assert.equal(describeError(backend('QUOTA', null)), 'Azure quota used up');
  assert.equal(providerName('kokoro'), 'Kokoro');
  assert.equal(providerName('polly'), 'Polly');
});
