# Chapterly backend

A local text-to-speech backend for Chapterly, an app that reads web novels aloud. The browser extension sends text and gets MP3 audio back.

- **Default voice engine:** [Kokoro](https://github.com/remsky/Kokoro-FastAPI), running on your own machine.
- **Optional:** Microsoft Azure voices (Brian and others), once you add Azure credentials.

It's built with Java 21, Spring Boot 3 and Maven, and runs on `http://localhost:8080`.

## Architecture

The code is layered and uses the strategy pattern. Each layer has its own package under `com.chapterly`:

| Package       | Responsibility |
|---------------|----------------|
| `controller/` | `TtsController`: `POST /api/tts`, `DELETE /api/tts/requests/{id}` and `GET /api/voices`. It validates input (text not empty, at most 3000 characters). It handles HTTP only and depends only on `TtsService`. `POST /api/tts` is asynchronous, so a slow engine never blocks Tomcat threads. |
| `service/`    | `TtsService`: picks a provider and voice, falls back to another provider when needed, and lists the voices. It logs the provider, voice, sizes and timings, never the text or the key. `TtsQueue` runs Kokoro requests one at a time, the chunk a listener waits for first (see [The Kokoro queue](#the-kokoro-queue)). |
| `provider/`   | The `TtsProvider` interface, plus `KokoroTtsProvider`, `AzureTtsProvider` (with `SsmlBuilder`) and `Voice`. Each provider knows only its own API. |
| `config/`     | `@ConfigurationProperties` for Kokoro, Azure, CORS, provider order and fallback. `ProviderConfig` builds the ordered provider list. |
| `error/`      | `TtsException` with a `Reason`, and `GlobalExceptionHandler`, which always returns a JSON error body. |

The `TtsProvider` interface:

```java
String name();          // "kokoro", "azure"
String displayName();   // "Kokoro (local)", "Microsoft Azure"
boolean isAvailable();  // Azure: credentials set. Kokoro: always (a server that's down is a runtime error)
String defaultVoice();
List<Voice> voices();   // never throws; returns a fallback list instead
byte[] synthesize(String text, String voice) throws TtsException;   // voice null = defaultVoice()
default boolean queued() { return false; }  // true: requests go through the TtsQueue (Kokoro)
```

**Output contract:** every provider returns MP3 (`audio/mpeg`). The extension never needs to know which provider produced the audio.

**Adding a provider:**
1. Write a `@Component` that implements `TtsProvider`.
2. Add its `name()` to `chapterly.providers`.

You don't need to change the controller or the service. If the config names a provider that doesn't exist, the app fails at startup.

## 1. Start Kokoro (the default)

Kokoro runs as a local [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) server on port 8880. You need Docker.

```bash
# CPU
docker run -d -p 8880:8880 --name kokoro ghcr.io/remsky/kokoro-fastapi-cpu:latest

# NVIDIA GPU (much faster)
docker run -d --gpus all -p 8880:8880 --name kokoro ghcr.io/remsky/kokoro-fastapi-gpu:latest
```

To check that it's up, open `http://localhost:8880/docs` or run `curl localhost:8880/v1/audio/voices`. The first request after startup can be slow while the model loads.

**Speed:** on CPU, a 1200-character chunk can take 15–25 seconds. On a GPU it takes about 3 seconds. The backend waits up to 30 seconds per request (`chapterly.kokoro.timeout`). Requests wait their turn in the [Kokoro queue](#the-kokoro-queue) first; that wait does not count toward the timeout.

**Voices:** only English voices are offered: `af_*` and `am_*` (American, female/male) and `bf_*` and `bm_*` (British). The default is `af_heart`. Labels are built from the id, so `am_michael` becomes "Michael (US, male)".

**What the backend calls:**
- `POST /v1/audio/speech` with `{"model": "kokoro", "input": "...", "voice": "af_heart", "response_format": "mp3", "speed": 1.0, "stream": false}`.
- `GET /v1/audio/voices`. The result is cached for 5 minutes; if Kokoro can't be reached, `chapterly.kokoro.fallback-voices` is used instead.

| Setting | Default |
|---|---|
| `chapterly.kokoro.base-url` (env `KOKORO_BASE_URL`) | `http://localhost:8880` |
| `chapterly.kokoro.default-voice` | `af_heart` |
| `chapterly.kokoro.model` | `kokoro` |
| `chapterly.kokoro.timeout` | `30s` (generation only; time in the queue doesn't count) |
| `chapterly.kokoro.max-concurrent` | `1`: Kokoro requests that run at once; the rest wait in the queue |
| `chapterly.kokoro.fallback-voices` | 12 English voices (see `application.yml`) |

### The Kokoro queue

A GPU (or CPU) generates one Kokoro request at a time anyway. If the backend simply passed every request on, Kokoro would work through them in whatever order they arrived, and a chunk the listener is waiting for (after skipping back, say) could sit behind several prefetches the extension no longer even wants. So Kokoro requests go through `TtsQueue`:

- **Concurrency:** at most `chapterly.kokoro.max-concurrent` (default `1`) Kokoro requests run at once. The others wait.
- **Order:** `now` (the chunk a listener is waiting for) before `prefetch`; first come, first served within a priority. The extension says which is which with the `X-Chapterly-Priority` header.
- **Cancel:** `DELETE /api/tts/requests/{id}` removes a request that is still waiting, so Kokoro never generates audio nobody wants. A request that already started runs to its end; that costs at most one chunk. When the async request times out or fails (for example because the client went away), a waiting request is dropped too, but the `DELETE` is the reliable path.
- **Timeout and fallback:** the waiting thread runs the job itself once it's its turn, so `chapterly.kokoro.timeout` only counts generation. A Kokoro `TIMEOUT` still falls back to Azure. A request cancelled while waiting never falls back.
- **Azure is not queued:** it's a remote service that handles requests in parallel.
- **Logging:** queue length and wait time are logged at debug level. Turn them on with `logging.level.com.chapterly.service.TtsQueue: debug` in `application-local.yml`.

### Where Kokoro-FastAPI 0.10 differs from the OpenAI-style docs

The backend follows the actual server, checked against Kokoro-FastAPI 0.10.0:
- **Voice list format:** `GET /v1/audio/voices` returns objects (`{"voices": [{"id": "af_heart", "name": "af_heart", ...}]}`), not plain strings. The backend accepts both forms.
- **Streaming is on by default** (`"stream": true` sends a chunked response). The backend sends `"stream": false` to get a complete MP3 with `Content-Length`, and so that errors arrive as real HTTP status codes instead of a cut-off 200.
- **Error bodies:** the server's own 400 errors use `{"detail": {"error", "message", "type"}}`, and request-validation 422 errors use `{"detail": [{"msg", ...}]}`. Both are turned into a readable `BAD_INPUT` message, shortened to 200 characters because "voice not found" lists every voice.
- **Some voices aren't offered:** voice ids with a second underscore (`af_amelia_inno`, `bm_atten_inno`) and legacy `v0` duplicates (`af_v0bella` next to `af_bella`). The first group fails the voice-id check `^[ab][fm]_[a-z0-9]+$`; the second would only clutter the list.

## 2. Enable Azure (optional)

Without Azure credentials, Azure shows up as "not configured" and only Kokoro is offered. With them, you can pick Brian and the other Azure voices in the extension, and Azure can also step in when Kokoro is down.

The recommended way is a `.env` file in the repo root. It's gitignored.

```bash
cp .env.example .env
```

```properties
AZURE_SPEECH_KEY=your-key
AZURE_SPEECH_REGION=switzerlandnorth
# KOKORO_BASE_URL=http://localhost:8880
```

- **How it's read:** the backend loads `./.env` as a properties file (`spring.config.import` in `application.yml`), so the backend has to be started **from the repo root**.
- **Format:** plain `KEY=value` lines. Spaces around `=` and quotes around the value are fine.
- **Environment variables win:** real environment variables with the same names override the file.
- **Never logged:** the key is never logged, and the properties' `toString()` redacts it.

Your subscription must allow the region. For student subscriptions, typical choices are `switzerlandnorth`, `belgiumcentral`, `norwayeast`, `polandcentral` and `austriaeast`.

Environment variables work as well:

```powershell
$env:AZURE_SPEECH_KEY = "your-key"
$env:AZURE_SPEECH_REGION = "switzerlandnorth"
```

| Setting | Default |
|---|---|
| `chapterly.azure.voice` (default voice) | `en-US-BrianNeural` |
| `chapterly.azure.voices` (the only voices offered and accepted) | Brian, Andrew, Guy, Ava, Emma, Jenny (US), Ryan, Sonia (GB) |
| `chapterly.azure.timeout` | `8s` |

For any other override, copy `application.yml.example` to `application-local.yml`, which is also gitignored and loaded automatically.

## 3. Run

```bash
mvn spring-boot:run      # from the repo root
```

## Run with Docker

One command starts everything the extension needs, Kokoro and the backend:

```bash
docker compose up -d             # build the backend image, start both services
docker compose logs -f backend   # follow the backend log
docker compose down              # stop and remove the containers
```

**Ports:** the backend is at `http://localhost:8080` and Kokoro at `http://localhost:8880`. By default both are bound to `127.0.0.1` only. If one of those ports is taken, set `CHAPTERLY_BACKEND_PORT` or `CHAPTERLY_KOKORO_PORT` before `up`. The extension's backend URL (Settings) must match.

**Another laptop over Tailscale:** the backend is published on `CHAPTERLY_BIND` (default `127.0.0.1`). Set it to this machine's Tailscale IP (`tailscale ip -4`), and set a token. Docker Compose reads `.env` next to `docker-compose.yml` for variable substitution, so both go into that same `.env`:

```properties
CHAPTERLY_BIND=100.101.102.103
CHAPTERLY_API_TOKEN=a-long-random-string   # e.g. openssl rand -hex 24
```

Then run `docker compose up -d` again. On the other laptop, set the extension's backend URL to `http://100.101.102.103:8080` and enter the same token under **Settings → API token**.
- **Don't use `0.0.0.0`.** It publishes `/api/tts` on every interface, so anyone on the same Wi-Fi or LAN could use it and your Azure quota. CORS doesn't stop them: it only restricts browsers, not `curl` or scripts.
- **Use the token anyway.** The Tailscale address is only reachable from your tailnet, but the token also covers devices on it you didn't mean to give access, and a mistaken bind address. See [Shared token](#shared-token).
- Kokoro stays on `127.0.0.1`; only the backend talks to it.

**First start:**
- The Kokoro CPU image is large (about 5 GB; the GPU image about 13 GB), so the first `up` takes a while to download.
- Kokoro then loads its model, and the first request can take several seconds.
- Until Kokoro is ready, the backend reports "Kokoro server not reachable", or falls back to Azure if Azure is configured.
- `docker compose ps` shows Kokoro as `healthy` once it's ready.

**Azure** is optional: Compose passes `./.env` to the backend as real environment variables (`env_file`, `required: false`).
- **Not baked into the image:** `.dockerignore` excludes `.env`, so the key is never part of the image.
- **Inside the container:** there's no `./.env`, so the backend's optional file import does nothing, and the environment variables apply as usual.
- **Kokoro address:** Compose points the backend at the Kokoro service (`KOKORO_BASE_URL=http://kokoro:8880`).

**GPU (NVIDIA):** this needs the NVIDIA Container Toolkit. In `docker-compose.yml`, replace the `kokoro` service with the commented-out GPU variant below it: the `kokoro-fastapi-gpu` image plus `deploy.resources.reservations.devices`. Then run `docker compose up -d` again.

**Development:** `mvn spring-boot:run` still works as before. Run Kokoro on its own (`docker compose up -d kokoro` or the `docker run` command above), then start the backend from the repo root.

The backend image (`Dockerfile`) is a multi-stage build. It compiles with `maven:3.9-eclipse-temurin-21`, using a BuildKit cache for `~/.m2`, and runs the jar on `eclipse-temurin:21-jre` as a non-root user.

## API

### Shared token

If `chapterly.api-token` (env `CHAPTERLY_API_TOKEN`, also read from `./.env`) is set, every `/api/**` request must send it:

```
X-Chapterly-Token: <the token>
```

- **Missing or wrong token:** `401 {"error": "UNAUTHORIZED", "message": "..."}`. Nothing is synthesized or cancelled.
- **Comparison:** constant time. Both values are hashed with SHA-256 and compared with `MessageDigest.isEqual`, so neither the token nor its length leaks through timing.
- **CORS preflights (`OPTIONS`)** are exempt: browsers never send custom headers with them. The check runs as a Spring MVC interceptor, after CORS handling, so a 401 still carries the CORS headers and the extension can show "wrong token" instead of "backend not reachable".
- **Not set (the default):** the API is open, as before. That's fine while the backend is only bound to `127.0.0.1`.

The extension sends the token from **Settings → API token** (stored in `chrome.storage.local` on that computer, never synced).

### `POST /api/tts`

```json
{"text": "Hello there.", "provider": "kokoro", "voice": "af_heart"}
```

`provider` (`kokoro` or `azure`) and `voice` are optional. A body with only `text` uses the default provider (the first available one in `chapterly.providers`, normally Kokoro) and its default voice.

Two optional request headers control the [Kokoro queue](#the-kokoro-queue). Without them a request is `now` and can't be cancelled, so plain `curl` calls work as before.

| Request header | Meaning |
|---|---|
| `X-Chapterly-Request-Id` | An id for this request (the extension sends a UUID; letters, digits and `-`, at most 64 characters). Needed to cancel it. |
| `X-Chapterly-Priority` | `now` (default) or `prefetch`. Anything else is `BAD_INPUT`. |

The response is `200 audio/mpeg` with these headers:

| Header | Meaning |
|---|---|
| `X-TTS-Provider` | The provider that produced the audio. |
| `X-TTS-Voice` | The voice actually used. |
| `X-TTS-Fallback` | `true` if a different provider than the requested one answered. |

**Fallback rule:**
1. The requested provider is tried first, with the requested voice.
2. If it fails with a recoverable error (`QUOTA`, `TIMEOUT` or `UNAVAILABLE`, for example when Kokoro isn't running) and `chapterly.fallback` is `true` (the default), the other providers are tried in `chapterly.providers` order. Each uses **its own default voice**, and providers that aren't configured are skipped.
3. Other errors are returned straight away. If every attempt fails, the last error is returned.

**Errors** always come as JSON, for example `{"error": "UNAVAILABLE", "message": "...", "provider": "kokoro"}`. The `provider` field names the provider that produced the final error.

| `error` | HTTP status |
|---|---|
| `BAD_INPUT` | 400 (unknown voice or provider, Azure not configured, empty or too-long text) |
| `QUOTA` | 503 |
| `UNAVAILABLE` | 503 |
| `TIMEOUT` | 504 |
| `UPSTREAM_ERROR` | 502 |
| `UNAUTHORIZED` | 401 (the [shared token](#shared-token) is set and the request sent none or a wrong one) |
| `CANCELLED` | 409 (the request was cancelled while it waited in the queue; the client has normally stopped listening by then) |

### `DELETE /api/tts/requests/{id}`

Cancels the request with that `X-Chapterly-Request-Id` if it is still waiting in the Kokoro queue. Always answers `204 No Content`: an unknown id, or a request that already started or finished, is not an error. The extension sends this whenever it aborts a request (a skip, a seek, a voice change, stop). A cancel that arrives before its request is remembered for a minute, so the request is dropped when it does arrive.

### `GET /api/voices`

```json
{"defaultProvider": "kokoro",
 "providers": [
   {"name": "kokoro", "displayName": "Kokoro (local)", "available": true, "defaultVoice": "af_heart",
    "voices": [{"id": "af_heart", "label": "Heart (US, female)", "language": "en-US", "gender": "female"}]},
   {"name": "azure", "displayName": "Microsoft Azure", "available": false, "defaultVoice": "en-US-BrianNeural", "voices": []}]}
```

CORS allows `GET`, `POST` and `DELETE` from `chrome-extension://*` and `moz-extension://*`, accepts the `Content-Type`, `X-Chapterly-Request-Id`, `X-Chapterly-Priority` and `X-Chapterly-Token` request headers, and exposes the three `X-TTS-*` response headers.

## Try it

```bash
curl -X POST localhost:8080/api/tts -H "Content-Type: application/json" \
  -d '{"text":"Hello from Kokoro."}' -i --output kokoro.mp3
curl -X POST localhost:8080/api/tts -H "Content-Type: application/json" \
  -d '{"text":"Hello, this is Brian.","provider":"azure","voice":"en-US-BrianNeural"}' --output brian.mp3
curl localhost:8080/api/voices
# a prefetch that can be cancelled while it waits
curl -X POST localhost:8080/api/tts -H "Content-Type: application/json" \
  -H "X-Chapterly-Request-Id: 3f1c2a9e-0b7d-4c55-9f00-1a2b3c4d5e6f" -H "X-Chapterly-Priority: prefetch" \
  -d '{"text":"Later."}' --output later.mp3
curl -X DELETE localhost:8080/api/tts/requests/3f1c2a9e-0b7d-4c55-9f00-1a2b3c4d5e6f
```

In PowerShell, use `curl.exe` and escape the inner quotes, as in `-d '{\"text\":\"Hello.\"}'`. If something goes wrong, run the command without `--output` to see the JSON error.

## Test

```bash
mvn test
```

The tests make no real network calls. Kokoro is simulated by a local `HttpServer` on a random port. `EnvFileBindingTest` starts the real configuration with a temporary `.env` file, so your own `.env` is never read. `ApiTokenTest` covers the shared token: open without a token, 401 for a missing or wrong token (with CORS headers), OK with the right one, and preflights passing. `TtsQueueTest` covers the priority order, cancelling a waiting request and an unknown id, and that concurrency 1 is honoured; `TtsServiceTest` checks that a Kokoro timeout still falls back to Azure through the queue, and `KokoroTtsProviderTest` that time in the queue doesn't count toward the timeout.

## Extension

The Chrome extension (Manifest V3) that reads web novel chapters and selected text aloud through this backend is in [`extension/`](extension/). The [extension README](extension/README.md) covers how to load it unpacked, choose a voice, and test it.
