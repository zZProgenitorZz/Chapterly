# Chapterly backend

A local text-to-speech backend for Chapterly, an app that reads web novels aloud. The browser extension sends text and gets MP3 audio back.

- **Default voice engine:** [Kokoro](https://github.com/remsky/Kokoro-FastAPI), running on your own machine.
- **Optional:** Microsoft Azure voices (Brian and others), once you add Azure credentials.

It's built with Java 21, Spring Boot 3 and Maven, and runs on `http://localhost:8080`.

## Architecture

The code is layered and uses the strategy pattern. Each layer has its own package under `com.chapterly`:

| Package       | Responsibility |
|---------------|----------------|
| `controller/` | `TtsController`: `POST /api/tts` and `GET /api/voices`. It validates input (text not empty, at most 3000 characters). It handles HTTP only and depends only on `TtsService`. |
| `service/`    | `TtsService`: picks a provider and voice, falls back to another provider when needed, and lists the voices. It logs the provider, voice, sizes and timings, never the text or the key. |
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

**Speed:** on CPU, a 1200-character chunk can take 15–25 seconds. On a GPU it takes about 3 seconds. The backend waits up to 30 seconds per request (`chapterly.kokoro.timeout`).

**Voices:** only English voices are offered: `af_*` and `am_*` (American, female/male) and `bf_*` and `bm_*` (British). The default is `af_heart`. Labels are built from the id, so `am_michael` becomes "Michael (US, male)".

**What the backend calls:**
- `POST /v1/audio/speech` with `{"model": "kokoro", "input": "...", "voice": "af_heart", "response_format": "mp3", "speed": 1.0, "stream": false}`.
- `GET /v1/audio/voices`. The result is cached for 5 minutes; if Kokoro can't be reached, `chapterly.kokoro.fallback-voices` is used instead.

| Setting | Default |
|---|---|
| `chapterly.kokoro.base-url` (env `KOKORO_BASE_URL`) | `http://localhost:8880` |
| `chapterly.kokoro.default-voice` | `af_heart` |
| `chapterly.kokoro.model` | `kokoro` |
| `chapterly.kokoro.timeout` | `30s` |
| `chapterly.kokoro.fallback-voices` | 12 English voices (see `application.yml`) |

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

## API

### `POST /api/tts`

```json
{"text": "Hello there.", "provider": "kokoro", "voice": "af_heart"}
```

`provider` (`kokoro` or `azure`) and `voice` are optional. A body with only `text` uses the default provider (the first available one in `chapterly.providers`, normally Kokoro) and its default voice.

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

### `GET /api/voices`

```json
{"defaultProvider": "kokoro",
 "providers": [
   {"name": "kokoro", "displayName": "Kokoro (local)", "available": true, "defaultVoice": "af_heart",
    "voices": [{"id": "af_heart", "label": "Heart (US, female)", "language": "en-US", "gender": "female"}]},
   {"name": "azure", "displayName": "Microsoft Azure", "available": false, "defaultVoice": "en-US-BrianNeural", "voices": []}]}
```

CORS allows `GET` and `POST` from `chrome-extension://*` and `moz-extension://*`, and exposes the three `X-TTS-*` headers.

## Try it

```bash
curl -X POST localhost:8080/api/tts -H "Content-Type: application/json" \
  -d '{"text":"Hello from Kokoro."}' -i --output kokoro.mp3
curl -X POST localhost:8080/api/tts -H "Content-Type: application/json" \
  -d '{"text":"Hello, this is Brian.","provider":"azure","voice":"en-US-BrianNeural"}' --output brian.mp3
curl localhost:8080/api/voices
```

In PowerShell, use `curl.exe` and escape the inner quotes, as in `-d '{\"text\":\"Hello.\"}'`. If something goes wrong, run the command without `--output` to see the JSON error.

## Test

```bash
mvn test
```

The tests make no real network calls. Kokoro is simulated by a local `HttpServer` on a random port. `EnvFileBindingTest` starts the real configuration with a temporary `.env` file, so your own `.env` is never read.

## Extension

The Chrome extension (Manifest V3) that reads web novel chapters and selected text aloud through this backend is in [`extension/`](extension/). The [extension README](extension/README.md) covers how to load it unpacked, choose a voice, and test it.
