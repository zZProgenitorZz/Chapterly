// HTTP client for the Chapterly backend: POST {baseUrl}/api/tts -> MP3 blob and
// GET {baseUrl}/api/voices. No chrome.* APIs here, so it runs in the offscreen
// document, the popup, the options page and in Node tests.

/**
 * Client-side timeout per request. Must stay above the backend's slowest provider
 * timeout: Kokoro on CPU may take up to 30 s (chapterly.kokoro.timeout) for a chunk.
 */
export const CLIENT_TIMEOUT_MS = 45_000;
export const VOICES_TIMEOUT_MS = 10_000;

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

/**
 * Backend answered with a non-2xx status. reason is the backend's {error} field
 * (QUOTA, TIMEOUT, UNAVAILABLE, UPSTREAM_ERROR, BAD_INPUT), provider its {provider}.
 */
export class BackendError extends TtsError {
  constructor(url, status, reason, message, provider = null) {
    super('BackendError', message || `Backend returned HTTP ${status}`, { url });
    this.status = status;
    this.reason = reason ?? null;
    this.provider = provider ?? null;
  }
}

/** No complete response within the client timeout. */
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

const trimBase = (baseUrl) => String(baseUrl).replace(/\/+$/, '');

export function speechUrl(baseUrl) {
  return `${trimBase(baseUrl)}/api/tts`;
}

export function voicesUrl(baseUrl) {
  return `${trimBase(baseUrl)}/api/voices`;
}

/**
 * Runs one request with the client timeout and maps failures to typed errors.
 * `read(response)` turns a 2xx response into the result. `onAbandon` runs if the request
 * is given up before it completes: aborted by the caller or timed out.
 */
async function request(url, init, { baseUrl, signal, timeoutMs, fetchImpl, onAbandon }, read) {
  if (!baseUrl) throw new TypeError('baseUrl is required');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (onAbandon) combined.addEventListener('abort', onAbandon, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: combined });
    if (!response.ok) throw await toBackendError(baseUrl, response);
    return await read(response);
  } catch (err) {
    if (err instanceof TtsError) throw err;
    if (signal?.aborted) throw signal.reason ?? err; // cancelled by the caller (stop, seek)
    if (timeout.aborted) throw new RequestTimeout(baseUrl, timeoutMs);
    throw new BackendUnreachable(baseUrl, err);
  } finally {
    if (onAbandon) combined.removeEventListener('abort', onAbandon);
  }
}

const defaultFetch = (...args) => globalThis.fetch(...args);

export const REQUEST_ID_HEADER = 'X-Chapterly-Request-Id';
export const PRIORITY_HEADER = 'X-Chapterly-Priority';
/** Shared token, required by the backend when CHAPTERLY_API_TOKEN is set. */
export const TOKEN_HEADER = 'X-Chapterly-Token';

/** Adds X-Chapterly-Token when a token is configured. */
function withToken(headers, apiToken) {
  return apiToken ? { ...headers, [TOKEN_HEADER]: apiToken } : headers;
}

export function cancelUrl(baseUrl, requestId) {
  return `${trimBase(baseUrl)}/api/tts/requests/${encodeURIComponent(requestId)}`;
}

/**
 * DELETE {baseUrl}/api/tts/requests/{id}: drops the request if it is still waiting in the
 * backend's Kokoro queue. Fire-and-forget: never throws, never rejects.
 */
export function cancelSpeech(baseUrl, requestId, { apiToken, fetchImpl = defaultFetch } = {}) {
  if (!baseUrl || !requestId) return;
  try {
    const init = { method: 'DELETE', headers: withToken({}, apiToken) };
    Promise.resolve(fetchImpl(cancelUrl(baseUrl, requestId), init)).catch(() => {});
  } catch {
    // fetch threw synchronously (e.g. invalid URL); nothing to cancel
  }
}

/**
 * Requests speech for one piece of text.
 * @param {object} o
 * @param {string} [o.provider] provider to try first ("kokoro", "azure"); backend default if omitted
 * @param {string} [o.voice] voice id of that provider; provider default if omitted
 * @param {string} [o.requestId] sent as X-Chapterly-Request-Id; when `signal` aborts, the
 *   backend is told to drop the request (DELETE) so Kokoro never generates it
 * @param {'now'|'prefetch'} [o.priority] sent as X-Chapterly-Priority ("now" = a listener waits for it)
 * @param {string} [o.apiToken] sent as X-Chapterly-Token (backend's CHAPTERLY_API_TOKEN)
 * @returns {Promise<{blob: Blob, provider: string, voice: string|null, fallback: boolean}>}
 * @throws {TtsError} typed error, or the caller's abort reason (AbortError) if `signal` was aborted.
 */
export async function fetchSpeech(
  text,
  { baseUrl, signal, provider, voice, requestId, priority, apiToken, timeoutMs = CLIENT_TIMEOUT_MS, fetchImpl = defaultFetch } = {},
) {
  const body = { text };
  if (provider) body.provider = provider;
  if (voice) body.voice = voice;
  // No Accept header on purpose: the backend's error bodies are JSON, and
  // "Accept: audio/mpeg" would turn them into 406 responses.
  const headers = { 'Content-Type': 'application/json' };
  if (requestId) headers[REQUEST_ID_HEADER] = requestId;
  if (priority) headers[PRIORITY_HEADER] = priority;
  const init = { method: 'POST', headers: withToken(headers, apiToken), body: JSON.stringify(body) };

  // Aborting the fetch (caller abort or client timeout) only closes our side; the backend
  // would still generate the audio. Tell it to drop the request.
  const onAbandon = requestId && baseUrl ? () => cancelSpeech(baseUrl, requestId, { apiToken, fetchImpl }) : null;
  return request(speechUrl(baseUrl), init, { baseUrl, signal, timeoutMs, fetchImpl, onAbandon }, async (response) => {
    const blob = await response.blob();
    if (!blob || blob.size === 0) throw new EmptyAudio(baseUrl);
    return {
      blob,
      provider: response.headers.get('X-TTS-Provider') ?? 'unknown',
      voice: response.headers.get('X-TTS-Voice'),
      fallback: response.headers.get('X-TTS-Fallback') === 'true',
    };
  });
}

/**
 * GET /api/voices.
 * @returns {Promise<{defaultProvider: string, providers: Array<{name, displayName, available, defaultVoice, voices: Array<{id, label, language, gender}>}>}>}
 */
export function fetchVoices(baseUrl, { signal, apiToken, timeoutMs = VOICES_TIMEOUT_MS, fetchImpl = defaultFetch } = {}) {
  const init = { method: 'GET', headers: withToken({}, apiToken) };
  return request(voicesUrl(baseUrl), init, { baseUrl, signal, timeoutMs, fetchImpl }, async (response) => {
    let catalog;
    try {
      catalog = await response.json();
    } catch {
      throw new BackendError(baseUrl, response.status, null, 'The backend sent an invalid voice list');
    }
    if (!Array.isArray(catalog?.providers)) {
      throw new BackendError(baseUrl, response.status, null, 'The backend sent an invalid voice list');
    }
    return catalog;
  });
}

async function toBackendError(baseUrl, response) {
  let reason = null;
  let message = '';
  let provider = null;
  try {
    const body = await response.json();
    reason = typeof body?.error === 'string' ? body.error : null;
    message = typeof body?.message === 'string' ? body.message : '';
    provider = typeof body?.provider === 'string' ? body.provider : null;
  } catch {
    // not JSON (e.g. a proxy error page); keep the status only
  }
  return new BackendError(baseUrl, response.status, reason, message, provider);
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
      provider: err.provider ?? null,
    };
  }
  return {
    kind: err?.kind ?? 'PlaybackError',
    message: String(err?.message ?? err ?? 'Unknown error'),
    url: null,
    status: null,
    reason: null,
    provider: null,
  };
}
