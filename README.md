# Chapterly backend

A local text-to-speech backend for Chapterly, an app that reads web novels aloud.
The browser extension sends text and gets MP3 audio back.

Built with Java 21, Spring Boot 3 and Maven. It runs on `http://localhost:8080`.

## Architecture

The code is layered and uses the strategy pattern. Each layer has its own package under `com.chapterly`:

| Package       | Responsibility |
|---------------|----------------|
| `controller/` | `TtsController` handles `POST /api/tts` with a body of `{"text": "..."}`. It validates the text (not empty, at most 3000 characters) and returns `audio/mpeg` with an `X-TTS-Provider` header. It handles HTTP only and depends only on `TtsService`. |
| `service/`    | `TtsService` tries an ordered `List<TtsProvider>`. When a provider fails with a recoverable error (`QUOTA`, `TIMEOUT`), it moves on to the next one. It rethrows any other error straight away. If every provider fails, it throws the last error. It logs which provider served each request, but never the text or the key. |
| `provider/`   | `TtsProvider` interface (`name()`, `synthesize(text)`). `AzureTtsProvider` calls the Azure Speech REST API. `SsmlBuilder` builds the SSML and XML-escapes the text. Each provider knows only its own API. |
| `config/`     | `@ConfigurationProperties` for Azure, CORS and the provider order (`chapterly.providers`). `ProviderConfig` builds the ordered provider list from that setting. |
| `error/`      | `TtsException` with a `Reason` (`QUOTA`, `TIMEOUT`, `UPSTREAM_ERROR`, `BAD_INPUT`). `GlobalExceptionHandler` maps these to 503, 504, 502 and 400, always with a JSON body: `{"error": "QUOTA", "message": "..."}`. |

**Output contract:** every provider must return MP3 (`audio/mpeg`). That way the extension never needs to know which provider was used.

### Adding a provider (e.g. Kokoro)

1. Create `provider/KokoroTtsProvider implements TtsProvider` as a `@Component`, with `name()` returning `"kokoro"`. It must return MP3 and throw `TtsException` with the right reason.
2. Add its name to the order in `application.yml`:
   ```yaml
   chapterly:
     providers: [azure, kokoro]
   ```

You don't need to change the controller or the service. If the config names a provider that doesn't exist, the app fails at startup.

## Configuration

The Azure credentials come from environment variables. Never commit or log the key.

**PowerShell**
```powershell
$env:AZURE_SPEECH_KEY = "your-key"
$env:AZURE_SPEECH_REGION = "westeurope"
```

**bash / zsh**
```bash
export AZURE_SPEECH_KEY="your-key"
export AZURE_SPEECH_REGION="westeurope"
```

You can also copy `application.yml.example` to `application-local.yml` in the project root. Git ignores that file, and the app loads it automatically if it exists.

| Setting                      | Default             |
|------------------------------|---------------------|
| `chapterly.azure.voice`      | `en-US-BrianNeural` |
| `chapterly.azure.timeout`    | `8s`                |
| `chapterly.providers`        | `[azure]`           |
| `chapterly.cors.allowed-origin-patterns` | `chrome-extension://*`, `moz-extension://*` |

## Run

```bash
mvn spring-boot:run
```

## Try it

```bash
curl -X POST localhost:8080/api/tts -H "Content-Type: application/json" \
  -d '{"text":"Hello, this is Brian."}' --output test.mp3
```

In PowerShell, use `curl.exe` and escape the inner quotes:

```powershell
curl.exe -X POST localhost:8080/api/tts -H "Content-Type: application/json" `
  -d '{\"text\":\"Hello, this is Brian.\"}' --output test.mp3
```

Add `-i` to see the `X-TTS-Provider` header. If something goes wrong, run the command without `--output` to see the JSON error.

## Test

```bash
mvn test
```
