// Turns a serialized player error ({kind, reason, status, message, url, provider})
// into text for the popup and options page.

const PROVIDER_NAMES = { kokoro: 'Kokoro', azure: 'Azure' };

/** "kokoro" -> "Kokoro". Errors without a provider come from backends that only had Azure. */
export function providerName(provider) {
  if (!provider) return 'Azure';
  return PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** "Kokoro server not reachable at http://localhost:8880. Is it running?" -> "localhost:8880". */
function kokoroHost(message) {
  const match = /at (https?:\/\/[^\s]+?)\.?\s+Is it running/i.exec(message ?? '');
  if (!match) return 'localhost:8880';
  try {
    return new URL(match[1]).host;
  } catch {
    return 'localhost:8880';
  }
}

export function describeError(error) {
  if (!error) return '';
  switch (error.kind) {
    case 'BackendUnreachable':
      return `Backend not reachable at ${error.url ?? 'the configured URL'}`;
    case 'RequestTimeout':
      return 'The backend did not respond in time';
    case 'EmptyAudio':
      return 'The backend returned no audio';
    case 'PlaybackError':
      return 'The audio could not be played';
    case 'BackendError': {
      const name = providerName(error.provider);
      switch (error.reason) {
        case 'UNAVAILABLE':
          return error.provider === 'kokoro'
            ? `Kokoro is not running. Start the Kokoro server on ${kokoroHost(error.message)}.`
            : `${name} is not reachable`;
        case 'QUOTA':
          return `${name} quota used up`;
        case 'TIMEOUT':
          return `${name} is not responding`;
        case 'UPSTREAM_ERROR':
          return `${name} returned an error`;
        case 'BAD_INPUT':
          if (/\bvoice\b/i.test(error.message ?? '')) return 'This voice is not available. Pick another one in Settings.';
          return error.message || 'The backend rejected the text';
        default:
          return `Backend error (HTTP ${error.status ?? '?'})`;
      }
    }
    default:
      return error.message || 'Something went wrong';
  }
}

/** Extra detail worth showing under the main message, or '' if it adds nothing. */
export function errorDetail(error) {
  if (!error || error.kind !== 'BackendError') return '';
  if (error.reason === 'BAD_INPUT' || error.reason === 'UNAVAILABLE') return '';
  return error.message ?? '';
}
