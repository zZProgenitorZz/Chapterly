package com.chapterly.provider;

import com.chapterly.config.KokoroProperties;
import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.channels.UnresolvedAddressException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Local Kokoro-FastAPI server (OpenAI-compatible speech API). Knows only the Kokoro API.
 *
 * <p>Only English voices are offered: ids "af_*", "am_*" (American) and "bf_*", "bm_*"
 * (British), first letter = language, second = gender.
 */
@Component
public class KokoroTtsProvider implements TtsProvider {

    private static final Logger log = LoggerFactory.getLogger(KokoroTtsProvider.class);

    /** Voices we accept and offer: English, single voice (no "a+b" mixes), simple name. */
    static final Pattern VOICE_ID = Pattern.compile("^[ab][fm]_[a-z0-9]+$");
    static final Duration VOICE_CACHE_TTL = Duration.ofMinutes(5);
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(3);
    private static final Duration VOICES_TIMEOUT = Duration.ofSeconds(5);
    private static final int MAX_DETAIL_CHARS = 200;

    private final KokoroProperties props;
    private final ObjectMapper json;
    private final HttpClient httpClient;
    private final Clock clock;

    private List<Voice> cachedVoices;
    private Instant cachedAt;

    @Autowired
    public KokoroTtsProvider(KokoroProperties props, ObjectMapper json) {
        this(props, json, Clock.systemUTC());
    }

    KokoroTtsProvider(KokoroProperties props, ObjectMapper json, Clock clock) {
        this.props = props;
        this.json = json;
        this.clock = clock;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(min(CONNECT_TIMEOUT, props.timeout()))
                .build();
    }

    @Override
    public String name() {
        return "kokoro";
    }

    @Override
    public String displayName() {
        return "Kokoro (local)";
    }

    /** Always offered; a server that is down is a runtime error (UNAVAILABLE). */
    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public String defaultVoice() {
        return props.defaultVoice();
    }

    @Override
    public byte[] synthesize(String text, String voice) throws TtsException {
        String voiceId = voice == null || voice.isBlank() ? props.defaultVoice() : voice;
        if (!VOICE_ID.matcher(voiceId).matches()) {
            throw new TtsException(Reason.BAD_INPUT, "Unknown Kokoro voice");
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", props.model());
        body.put("input", text);
        body.put("voice", voiceId);
        body.put("response_format", "mp3");
        body.put("speed", 1.0);
        body.put("stream", false); // complete file + real status codes (a stream can't report late errors)

        HttpRequest request;
        try {
            request = HttpRequest.newBuilder()
                    .uri(URI.create(props.baseUrl() + "/v1/audio/speech"))
                    .timeout(props.timeout())
                    .header("Content-Type", "application/json")
                    .header("Accept", "audio/mpeg")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(body)))
                    .build();
        } catch (IOException | IllegalArgumentException e) {
            throw new TtsException(Reason.UPSTREAM_ERROR, "Invalid Kokoro request (check chapterly.kokoro.base-url)", e);
        }

        HttpResponse<byte[]> response = send(request, props.timeout());
        return handleResponse(response.statusCode(), response.body(), json);
    }

    /** English voices from the server, cached for 5 minutes; the fallback list if the server can't be reached. */
    @Override
    public synchronized List<Voice> voices() {
        Instant now = clock.instant();
        if (cachedVoices != null && cachedAt.plus(VOICE_CACHE_TTL).isAfter(now)) {
            return cachedVoices;
        }
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(props.baseUrl() + "/v1/audio/voices"))
                    .timeout(min(VOICES_TIMEOUT, props.timeout()))
                    .GET()
                    .build();
            HttpResponse<byte[]> response = send(request, props.timeout());
            if (response.statusCode() != 200) {
                throw new IOException("HTTP " + response.statusCode());
            }
            List<Voice> voices = englishVoices(parseVoiceIds(json.readTree(response.body())));
            if (voices.isEmpty()) {
                throw new IOException("no English voices in the response");
            }
            cachedVoices = voices;
            cachedAt = now;
            return voices;
        } catch (Exception e) {
            // Not cached: the list refreshes as soon as the server is back.
            log.warn("Kokoro voice list unavailable ({}), using the fallback list", e.getMessage());
            return englishVoices(props.fallbackVoices());
        }
    }

    private HttpResponse<byte[]> send(HttpRequest request, Duration timeout) throws TtsException {
        try {
            return httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
        } catch (HttpConnectTimeoutException e) {
            throw unavailable(e);
        } catch (HttpTimeoutException e) {
            throw new TtsException(Reason.TIMEOUT, "Kokoro did not respond within " + timeout.toSeconds() + " s", e);
        } catch (IOException e) {
            if (isConnectFailure(e)) {
                throw unavailable(e);
            }
            throw new TtsException(Reason.UPSTREAM_ERROR, "Kokoro request failed (" + e.getClass().getSimpleName() + ")", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new TtsException(Reason.UPSTREAM_ERROR, "Interrupted while calling Kokoro", e);
        } catch (UnresolvedAddressException e) {
            throw unavailable(e);
        }
    }

    private TtsException unavailable(Throwable cause) {
        return new TtsException(Reason.UNAVAILABLE,
                "Kokoro server not reachable at " + props.baseUrl() + ". Is it running?", cause);
    }

    private static boolean isConnectFailure(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof ConnectException || t instanceof UnresolvedAddressException) {
                return true;
            }
        }
        return false;
    }

    /** Maps a Kokoro HTTP response to MP3 bytes or a TtsException. Package-private for tests. */
    static byte[] handleResponse(int status, byte[] body, ObjectMapper json) throws TtsException {
        if (status == 200) {
            if (body == null || body.length == 0) {
                throw new TtsException(Reason.UPSTREAM_ERROR, "Kokoro returned empty audio");
            }
            return body;
        }
        if (status == 400 || status == 404 || status == 422) {
            String detail = detailMessage(body, json);
            throw new TtsException(Reason.BAD_INPUT,
                    "Kokoro rejected the request" + (detail.isEmpty() ? " (HTTP " + status + ")" : ": " + detail));
        }
        throw new TtsException(Reason.UPSTREAM_ERROR, "Kokoro returned HTTP " + status);
    }

    /**
     * Kokoro-FastAPI error bodies: {"detail": "text"}, {"detail": {"error", "message", "type"}}
     * (its own errors) or {"detail": [{"msg", ...}]} (FastAPI request validation).
     */
    static String detailMessage(byte[] body, ObjectMapper json) {
        if (body == null || body.length == 0) {
            return "";
        }
        try {
            JsonNode detail = json.readTree(body).path("detail");
            String text;
            if (detail.isTextual()) {
                text = detail.asText();
            } else if (detail.isObject()) {
                text = detail.path("message").asText(detail.path("error").asText(""));
            } else if (detail.isArray()) {
                List<String> msgs = new ArrayList<>();
                detail.forEach(d -> msgs.add(d.path("msg").asText(d.asText(""))));
                text = String.join("; ", msgs);
            } else {
                text = "";
            }
            text = text.strip();
            // "Voice 'x' not found. Available voices: <70 ids>" -> keep it short.
            return text.length() > MAX_DETAIL_CHARS ? text.substring(0, MAX_DETAIL_CHARS) + "…" : text;
        } catch (IOException e) {
            return "";
        }
    }

    /** {"voices": ["af_heart", ...]} or {"voices": [{"id": "af_heart", ...}, ...]} (Kokoro-FastAPI 0.10+). */
    static List<String> parseVoiceIds(JsonNode root) {
        List<String> ids = new ArrayList<>();
        for (JsonNode v : root.path("voices")) {
            String id = v.isTextual() ? v.asText() : v.path("id").asText(v.path("name").asText(""));
            if (!id.isEmpty()) {
                ids.add(id);
            }
        }
        return ids;
    }

    /**
     * Keeps English single voices, drops legacy "v0" duplicates (af_v0bella next to af_bella),
     * sorts US before GB, female before male, then by name.
     */
    static List<Voice> englishVoices(List<String> ids) {
        return ids.stream()
                .distinct()
                .filter(id -> VOICE_ID.matcher(id).matches())
                .filter(id -> !id.substring(3).startsWith("v0"))
                .sorted(Comparator.comparing((String id) -> id.charAt(0))
                        .thenComparing(id -> id.charAt(1))
                        .thenComparing(id -> id.substring(3)))
                .map(KokoroTtsProvider::toVoice)
                .toList();
    }

    /** "am_michael" -> Voice("am_michael", "Michael (US, male)", "en-US", "male"). */
    static Voice toVoice(String id) {
        boolean us = id.charAt(0) == 'a';
        String gender = id.charAt(1) == 'f' ? "female" : "male";
        String raw = id.substring(3);
        String name = Character.toUpperCase(raw.charAt(0)) + raw.substring(1);
        return new Voice(id, name + " (" + (us ? "US" : "GB") + ", " + gender + ")", us ? "en-US" : "en-GB", gender);
    }

    private static Duration min(Duration a, Duration b) {
        return a.compareTo(b) <= 0 ? a : b;
    }
}
