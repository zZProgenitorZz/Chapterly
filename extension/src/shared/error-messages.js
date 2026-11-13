// Turns a serialized player error ({kind, reason, status, message, url})
// into text for the popup.

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
    case 'BackendError':
      switch (error.reason) {
        case 'QUOTA':
          return 'Azure quota used up';
        case 'TIMEOUT':
          return 'Azure is not responding';
        case 'UPSTREAM_ERROR':
          return 'Azure returned an error';
        case 'BAD_INPUT':
          return error.message || 'The backend rejected the text';
        default:
          return `Backend error (HTTP ${error.status ?? '?'})`;
      }
    default:
      return error.message || 'Something went wrong';
  }
}

/** Extra detail worth showing under the main message, or '' if it adds nothing. */
export function errorDetail(error) {
  if (!error || error.kind !== 'BackendError' || error.reason === 'BAD_INPUT') return '';
  return error.message ?? '';
}
