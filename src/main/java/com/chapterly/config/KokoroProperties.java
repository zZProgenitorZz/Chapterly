package com.chapterly.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;
import java.util.List;

/**
 * Local Kokoro-FastAPI server.
 *
 * @param baseUrl        server root, e.g. http://localhost:8880 (env KOKORO_BASE_URL)
 * @param defaultVoice   voice used when a request names none
 * @param model          "model" field sent to /v1/audio/speech
 * @param timeout        per request; Kokoro on CPU can need 15-25 s for a 1200-character chunk
 * @param fallbackVoices offered when GET /v1/audio/voices can't be reached
 * @param maxConcurrent  Kokoro requests that run at the same time; the rest wait in the
 *                       TtsQueue ("now" before "prefetch"). A GPU does one at a time anyway.
 */
@ConfigurationProperties(prefix = "chapterly.kokoro")
public record KokoroProperties(
        @DefaultValue("http://localhost:8880") String baseUrl,
        @DefaultValue("af_heart") String defaultVoice,
        @DefaultValue("kokoro") String model,
        @DefaultValue("30s") Duration timeout,
        @DefaultValue({
                "af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael", "am_adam", "am_fenrir",
                "bf_emma", "bf_isabella", "bm_george", "bm_fable", "bm_lewis"
        }) List<String> fallbackVoices,
        @DefaultValue("1") int maxConcurrent) {

    public KokoroProperties {
        maxConcurrent = Math.max(1, maxConcurrent);
        baseUrl = baseUrl == null ? "" : baseUrl.strip().replaceAll("/+$", "");
        fallbackVoices = fallbackVoices == null ? List.of() : List.copyOf(fallbackVoices);
    }
}
