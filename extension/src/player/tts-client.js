// HTTP client for the Chapterly backend: POST {baseUrl}/api/tts -> MP3 blob.
// No chrome.* APIs here, so it runs in the offscreen document and in Node tests.

/** Client-side timeout. Must stay above the backend's 8 s Azure timeout. */
export const CLIENT_TIMEOUT_MS = 20_000;

export class TtsError extends Error {
  constructor(kind, message, { url, cause } = {}) {
    super(message, { cause });
    this.name = kind;
    this.kind = kind;
    this.url = url;
  }
}

/** fetch() itself failed: backend down, wrong URL, CORS/permission problem. */
export class BackendUnreachable extends TtsError {
  constructor(url, cause) {
    super('BackendUnreachable', `Backend not reachable at ${url}`, { url, cause });
  }
}

/** Backend answered with a non-2xx status. reason is the backend's {error} field. */
export class BackendError extends TtsError {
  constructor(url, status, reason, message) {
    super('BackendError', message || `Backend returned HTTP ${status}`, { url });
    this.status = status;
    this.reason = reason ?? null;
  }
}

/** No complete response within CLIENT_TIMEOUT_MS. */
export class RequestTimeout extends TtsError {
  constructor(url, timeoutMs) {
    super('RequestTimeout', `No response from ${url} within ${timeoutMs / 1000} s`, { url });
    this.timeoutMs = timeoutMs;
  }
}

/** 200 OK, but the body was empty. */
export class EmptyAudio extends TtsError {
  constructor(url) {
    super('EmptyAudio', 'The backend returned empty audio', { url });
  }
}

export function speechUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/api/tts`;
}

/**
 * Requests speech for one piece of text.
 * @returns {Promise<{blob: Blob, provider: string}>}
 * @throws {TtsError} typed error, or the caller's abort reason (AbortError) if `signal` was aborted.
 */
export async function fetchSpeech(
  text,
  { baseUrl, signal, timeoutMs = CLIENT_TIMEOUT_MS, fetchImpl = (...args) => globalThis.fetch(...args) } = {},
) {
  if (!baseUrl) throw new TypeError('fetchSpeech: baseUrl is required');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    // No Accept header on purpose: the backend's error bodies are JSON, and
    // "Accept: audio/mpeg" would turn them into 406 responses.
    const response = await fetchImpl(speechUrl(baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: combined,
    });

    if (!response.ok) throw await toBackendError(baseUrl, response);

    const blob = await response.blob();
    if (!blob || blob.size === 0) throw new EmptyAudio(baseUrl);

    return { blob, provider: response.headers.get('X-TTS-Provider') ?? 'unknown' };
  } catch (err) {
    if (err instanceof TtsError) throw err;
    if (signal?.aborted) throw signal.reason ?? err; // cancelled by the caller (stop)
    if (timeout.aborted) throw new RequestTimeout(baseUrl, timeoutMs);
    throw new BackendUnreachable(baseUrl, err);
  }
}

async function toBackendError(baseUrl, response) {
  let reason = null;
  let message = '';
  try {
    const body = await response.json();
    reason = typeof body?.error === 'string' ? body.error : null;
    message = typeof body?.message === 'string' ? body.message : '';
  } catch {
    // not JSON (e.g. a proxy error page); keep the status only
  }
  return new BackendError(baseUrl, response.status, reason, message);
}

/** Plain JSON form of any error, safe to send through runtime messaging. */
export function toErrorInfo(err) {
  if (err instanceof TtsError) {
    return {
      kind: err.kind,
      message: err.message,
      url: err.url ?? null,
      status: err.status ?? null,
      reason: err.reason ?? null,
    };
  }
  return {
    kind: err?.kind ?? 'PlaybackError',
    message: String(err?.message ?? err ?? 'Unknown error'),
    url: null,
    status: null,
    reason: null,
  };
}
