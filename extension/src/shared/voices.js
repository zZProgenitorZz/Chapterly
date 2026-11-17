// Voice catalog helpers shared by the popup and the options page.
// The catalog is the backend's GET /api/voices response.

import { providerName } from './error-messages.js';

/** Value of a <select> option for a voice. */
export const voiceKey = (provider, voice) => `${provider}:${voice}`;

export function parseVoiceKey(key) {
  const i = String(key).indexOf(':');
  return i > 0 ? { provider: key.slice(0, i), voice: key.slice(i + 1) } : null;
}

/** "Heart (US, female)" -> "Heart"; without a catalog: "af_heart" -> "Heart", "en-US-BrianNeural" -> "Brian". */
export function shortVoiceName(provider, voiceId, catalog) {
  if (!voiceId) return '';
  const label = catalog?.providers?.find((p) => p.name === provider)?.voices?.find((v) => v.id === voiceId)?.label;
  if (label) return label.replace(/\s*\(.*\)\s*$/, '');
  const azure = /^[a-z]{2,3}-[A-Z]{2}-([A-Za-z]+?)(?:Multilingual)?Neural$/.exec(voiceId);
  if (azure) return azure[1];
  const kokoro = /^[a-z]{2}_(.+)$/.exec(voiceId);
  const name = kokoro ? kokoro[1] : voiceId;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** "Voice: Heart (Kokoro)" / "Voice: Brian (Azure, fallback)" for a player state. */
export function describeVoice(state, catalog) {
  if (!state?.voice || !state.provider) return '';
  const name = shortVoiceName(state.provider, state.voice, catalog);
  return `Voice: ${name} (${providerName(state.provider)}${state.fallback ? ', fallback' : ''})`;
}

/**
 * Fills a <select> with one <optgroup> per provider. Unavailable providers get one
 * disabled "Not configured on the backend" option. The provider's default voice is
 * marked. If the current selection is not in the catalog it stays selectable, so a
 * stored choice is never silently replaced.
 */
export function renderVoiceOptions(select, catalog, selection, { markDefault = true } = {}) {
  const doc = select.ownerDocument;
  select.replaceChildren();
  const current = selection ? voiceKey(selection.provider, selection.voice) : null;
  let found = false;

  for (const provider of catalog?.providers ?? []) {
    const group = doc.createElement('optgroup');
    group.label = provider.displayName ?? provider.name;
    if (!provider.available) {
      const option = doc.createElement('option');
      option.disabled = true;
      option.value = '';
      option.textContent = 'Not configured on the backend';
      group.append(option);
    } else {
      for (const voice of provider.voices ?? []) {
        const option = doc.createElement('option');
        option.value = voiceKey(provider.name, voice.id);
        const isDefault = markDefault && voice.id === provider.defaultVoice;
        option.textContent = `${voice.label ?? voice.id}${isDefault ? ' · default' : ''}`;
        if (option.value === current) {
          option.selected = true;
          found = true;
        }
        group.append(option);
      }
    }
    select.append(group);
  }

  if (current && !found) {
    const option = doc.createElement('option');
    option.value = current;
    option.textContent = `${shortVoiceName(selection.provider, selection.voice)} (${providerName(selection.provider)}, not available)`;
    select.prepend(option);
  }
  if (current) select.value = current;
  return found;
}
