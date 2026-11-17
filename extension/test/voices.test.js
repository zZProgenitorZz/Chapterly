import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { describeVoice, parseVoiceKey, renderVoiceOptions, shortVoiceName, voiceKey } from '../src/shared/voices.js';

const CATALOG = {
  defaultProvider: 'kokoro',
  providers: [
    {
      name: 'kokoro',
      displayName: 'Kokoro (local)',
      available: true,
      defaultVoice: 'af_heart',
      voices: [
        { id: 'af_bella', label: 'Bella (US, female)' },
        { id: 'af_heart', label: 'Heart (US, female)' },
        { id: 'bm_george', label: 'George (GB, male)' },
      ],
    },
    { name: 'azure', displayName: 'Microsoft Azure', available: false, defaultVoice: 'en-US-BrianNeural', voices: [] },
  ],
};

const select = () => new JSDOM('<select></select>').window.document.querySelector('select');

test('one optgroup per provider; unavailable Azure has one disabled option', () => {
  const el = select();
  renderVoiceOptions(el, CATALOG, { provider: 'kokoro', voice: 'bm_george' });
  const groups = [...el.querySelectorAll('optgroup')];
  assert.deepEqual(groups.map((g) => g.label), ['Kokoro (local)', 'Microsoft Azure']);
  assert.deepEqual([...groups[0].children].map((o) => o.textContent), ['Bella (US, female)', 'Heart (US, female) · default', 'George (GB, male)']);
  const azure = [...groups[1].children];
  assert.equal(azure.length, 1);
  assert.equal(azure[0].textContent, 'Not configured on the backend');
  assert.equal(azure[0].disabled, true);
  assert.equal(el.value, 'kokoro:bm_george');
});

test('a stored choice that is not offered stays selected', () => {
  const el = select();
  const found = renderVoiceOptions(el, CATALOG, { provider: 'azure', voice: 'en-US-BrianNeural' });
  assert.equal(found, false);
  assert.equal(el.value, 'azure:en-US-BrianNeural');
  assert.match(el.options[el.selectedIndex].textContent, /Brian \(Azure, not available\)/);
});

test('without a catalog (backend down) only the stored choice is shown', () => {
  const el = select();
  renderVoiceOptions(el, null, { provider: 'kokoro', voice: 'af_heart' });
  assert.equal(el.options.length, 1);
  assert.equal(el.value, 'kokoro:af_heart');
});

test('voice names and the popup meta line', () => {
  assert.equal(shortVoiceName('kokoro', 'af_heart', CATALOG), 'Heart');
  assert.equal(shortVoiceName('kokoro', 'am_michael'), 'Michael');
  assert.equal(shortVoiceName('azure', 'en-US-BrianNeural'), 'Brian');
  assert.equal(describeVoice({ provider: 'kokoro', voice: 'af_heart', fallback: false }, CATALOG), 'Voice: Heart (Kokoro)');
  assert.equal(describeVoice({ provider: 'azure', voice: 'en-US-BrianNeural', fallback: true }, CATALOG), 'Voice: Brian (Azure, fallback)');
  assert.equal(describeVoice({ provider: null, voice: null }), '');
});

test('option keys round-trip', () => {
  assert.deepEqual(parseVoiceKey(voiceKey('azure', 'en-US-BrianNeural')), { provider: 'azure', voice: 'en-US-BrianNeural' });
  assert.equal(parseVoiceKey(''), null);
});
