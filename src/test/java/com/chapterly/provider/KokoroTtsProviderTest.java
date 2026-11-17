package com.chapterly.provider;

import com.chapterly.config.KokoroProperties;
import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Talks to a small local HttpServer that plays Kokoro-FastAPI; no real network. */
class KokoroTtsProviderTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final byte[] MP3 = {0x49, 0x44, 0x33, 1, 2, 3};
    private static final List<String> FALLBACK = List.of("af_heart", "bm_george", "not-a-voice");

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<Responder> speech = new AtomicReference<>();
    private final AtomicReference<Responder> voices = new AtomicReference<>();
    private final AtomicReference<JsonNode> lastBody = new AtomicReference<>();
    private final AtomicInteger voiceCalls = new AtomicInteger();

    @FunctionalInterface
    interface Responder {
        void respond(HttpExchange exchange) throws IOException;
    }

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/audio/speech", ex -> {
            lastBody.set(JSON.readTree(ex.getRequestBody().readAllBytes()));
            speech.get().respond(ex);
        });
        server.createContext("/v1/audio/voices", ex -> {
            voiceCalls.incrementAndGet();
            voices.get().respond(ex);
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private KokoroTtsProvider provider(String url, Duration timeout, Clock clock) {
        return new KokoroTtsProvider(new KokoroProperties(url, "af_heart", "kokoro", timeout, FALLBACK), JSON, clock);
    }

    private KokoroTtsProvider provider() {
        return provider(baseUrl, Duration.ofSeconds(5), Clock.systemUTC());
    }

    private static Responder reply(int status, String contentType, byte[] body) {
        return ex -> {
            ex.getResponseHeaders().add("Content-Type", contentType);
            ex.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
            if (body.length > 0) {
                ex.getResponseBody().write(body);
            }
            ex.close();
        };
    }

    private static Responder json(int status, String body) {
        return reply(status, "application/json", body.getBytes(StandardCharsets.UTF_8));
    }

    private static Reason reasonOf(Throwable e) {
        return ((TtsException) e).getReason();
    }

    // ---------- synthesize ----------

    @Test
    void returnsMp3AndSendsTheOpenAiStyleBody() throws TtsException {
        speech.set(reply(200, "audio/mpeg", MP3));

        byte[] audio = provider().synthesize("Hello \"there\" & you", "bm_george");

        assertThat(audio).isEqualTo(MP3);
        JsonNode body = lastBody.get();
        assertThat(body.path("model").asText()).isEqualTo("kokoro");
        assertThat(body.path("input").asText()).isEqualTo("Hello \"there\" & you");
        assertThat(body.path("voice").asText()).isEqualTo("bm_george");
        assertThat(body.path("response_format").asText()).isEqualTo("mp3");
        assertThat(body.path("speed").asDouble()).isEqualTo(1.0);
        assertThat(body.path("stream").asBoolean(true)).isFalse();
    }

    @Test
    void nullVoiceUsesTheDefaultVoice() throws TtsException {
        speech.set(reply(200, "audio/mpeg", MP3));
        provider().synthesize("Hi", null);
        assertThat(lastBody.get().path("voice").asText()).isEqualTo("af_heart");
    }

    @Test
    void emptyAudioIsUpstreamError() {
        speech.set(reply(200, "audio/mpeg", new byte[0]));
        assertThatThrownBy(() -> provider().synthesize("Hi", null))
                .extracting(KokoroTtsProviderTest::reasonOf).isEqualTo(Reason.UPSTREAM_ERROR);
    }

    @Test
    void http400WithDetailObjectIsBadInputWithKokorosMessage() {
        speech.set(json(400, "{\"detail\":{\"error\":\"validation_error\",\"message\":\"Voice 'af_x' not found.\",\"type\":\"invalid_request_error\"}}"));
        assertThatThrownBy(() -> provider().synthesize("Hi", "af_x"))
                .hasMessage("Kokoro rejected the request: Voice 'af_x' not found.")
                .extracting(KokoroTtsProviderTest::reasonOf).isEqualTo(Reason.BAD_INPUT);
    }

    @Test
    void http400WithDetailStringIsBadInput() {
        speech.set(json(400, "{\"detail\":\"Invalid model\"}"));
        assertThatThrownBy(() -> provider().synthesize("Hi", null)).hasMessage("Kokoro rejected the request: Invalid model");
    }

    @Test
    void http422ValidationArrayIsBadInput() {
        speech.set(json(422, "{\"detail\":[{\"type\":\"missing\",\"loc\":[\"body\",\"input\"],\"msg\":\"Field required\"}]}"));
        assertThatThrownBy(() -> provider().synthesize("Hi", null))
                .hasMessage("Kokoro rejected the request: Field required")
                .extracting(KokoroTtsProviderTest::reasonOf).isEqualTo(Reason.BAD_INPUT);
    }

    @Test
    void http404WithoutBodyIsBadInput() {
        speech.set(reply(404, "text/plain", new byte[0]));
        assertThatThrownBy(() -> provider().synthesize("Hi", null))
                .hasMessage("Kokoro rejected the request (HTTP 404)")
                .extracting(KokoroTtsProviderTest::reasonOf).isEqualTo(Reason.BAD_INPUT);
    }

    @Test
    void longDetailIsShortened() {
        String detail = "Voice 'x' not found. Available voices: " + "af_voice, ".repeat(60);
        assertThat(KokoroTtsProvider.detailMessage(("{\"detail\":{\"message\":\"" + detail + "\"}}").getBytes(), JSON))
                .hasSizeLessThanOrEqualTo(201).endsWith("…");
    }

    @Test
    void http500IsUpstreamError() {
        speech.set(json(500, "{\"detail\":\"boom\"}"));
        assertThatThrownBy(() -> provider().synthesize("Hi", null))
                .hasMessage("Kokoro returned HTTP 500")
                .extracting(KokoroTtsProviderTest::reasonOf).isEqualTo(Reason.UPSTREAM_ERROR);
    }

    @Test
    void connectionRefusedIsUnavailable() throws IOException {
        int closedPort;
        try (ServerSocket s = new ServerSocket(0)) {
            closedPort = s.getLocalPort();
        }
        String url = "http://127.0.0.1:" + closedPort;
        assertThatThrownBy(() -> provider(url, Duration.ofSeconds(5), Clock.systemUTC()).synthesize("Hi", null))
                .hasMessage("Kokoro server not reachable at " + url + ". Is it running?")
                .extracting(KokoroTtsProviderTest::reasonOf).isEqualTo(Reason.UNAVAILABLE);
        assertThat(Reason.UNAVAILABLE.isRecoverable()).isTrue();
    }

    @Test
    void slowServerIsTimeout() {
        speech.set(ex -> {
            try {
                Thread.sleep(1500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            reply(200, "audio/mpeg", MP3).respond(ex);
        });
        assertThatThrownBy(() -> provider(baseUrl, Duration.ofMillis(300), Clock.systemUTC()).synthesize("Hi", null))
                .extracting(KokoroTtsProviderTest::reasonOf).isEqualTo(Reason.TIMEOUT);
    }

    @Test
    void invalidVoiceIdsAreRejectedBeforeCallingKokoro() {
        for (String voice : List.of("zf_xiaobei", "af_heart+af_bella", "AF_HEART", "af_", "af_amelia_inno", "../x")) {
            assertThatThrownBy(() -> provider().synthesize("Hi", voice))
                    .as(voice)
                    .hasMessage("Unknown Kokoro voice")
                    .extracting(KokoroTtsProviderTest::reasonOf).isEqualTo(Reason.BAD_INPUT);
        }
        assertThat(lastBody.get()).isNull();
    }

    // ---------- voices ----------

    @Test
    void labelsAreBuiltFromTheId() {
        assertThat(KokoroTtsProvider.toVoice("am_michael")).isEqualTo(new Voice("am_michael", "Michael (US, male)", "en-US", "male"));
        assertThat(KokoroTtsProvider.toVoice("af_heart")).isEqualTo(new Voice("af_heart", "Heart (US, female)", "en-US", "female"));
        assertThat(KokoroTtsProvider.toVoice("bf_emma")).isEqualTo(new Voice("bf_emma", "Emma (GB, female)", "en-GB", "female"));
        assertThat(KokoroTtsProvider.toVoice("bm_george").label()).isEqualTo("George (GB, male)");
    }

    @Test
    void voicesKeepsEnglishOnlySortedUsFemaleFirst() {
        // Kokoro-FastAPI 0.10 returns objects; older versions return plain strings.
        voices.set(json(200, "{\"voices\":[{\"id\":\"bm_george\"},{\"id\":\"zf_xiaobei\"},{\"id\":\"am_michael\"},"
                + "{\"id\":\"bf_emma\"},{\"id\":\"af_v0bella\"},{\"id\":\"af_heart\"},{\"id\":\"am_adam\"},"
                + "{\"id\":\"jf_alpha\"},{\"id\":\"af_amelia_inno\"},{\"id\":\"af_bella\"}]}"));

        assertThat(provider().voices()).extracting(Voice::id)
                .containsExactly("af_bella", "af_heart", "am_adam", "am_michael", "bf_emma", "bm_george");
    }

    @Test
    void voicesAcceptsAPlainStringList() {
        voices.set(json(200, "{\"voices\":[\"am_michael\",\"af_heart\",\"ef_dora\"]}"));
        assertThat(provider().voices()).extracting(Voice::id).containsExactly("af_heart", "am_michael");
    }

    @Test
    void voicesAreCachedForFiveMinutes() {
        voices.set(json(200, "{\"voices\":[\"af_heart\"]}"));
        MutableClock clock = new MutableClock(Instant.parse("2026-11-17T10:00:00Z"));
        KokoroTtsProvider kokoro = provider(baseUrl, Duration.ofSeconds(5), clock);

        kokoro.voices();
        kokoro.voices();
        clock.advance(Duration.ofMinutes(4));
        kokoro.voices();
        assertThat(voiceCalls.get()).isEqualTo(1);

        clock.advance(Duration.ofMinutes(2));
        kokoro.voices();
        assertThat(voiceCalls.get()).isEqualTo(2);
    }

    @Test
    void voicesFallBackToTheConfiguredListWhenTheServerFails() {
        voices.set(json(500, "{}"));
        assertThat(provider().voices()).extracting(Voice::id).containsExactly("af_heart", "bm_george");
    }

    @Test
    void voicesFallBackWhenTheServerIsDown() throws IOException {
        int closedPort;
        try (ServerSocket s = new ServerSocket(0)) {
            closedPort = s.getLocalPort();
        }
        KokoroTtsProvider kokoro = provider("http://127.0.0.1:" + closedPort, Duration.ofSeconds(5), Clock.systemUTC());
        assertThat(kokoro.voices()).extracting(Voice::id).containsExactly("af_heart", "bm_george");
    }

    @Test
    void describesItself() {
        KokoroTtsProvider kokoro = provider();
        assertThat(kokoro.name()).isEqualTo("kokoro");
        assertThat(kokoro.displayName()).isEqualTo("Kokoro (local)");
        assertThat(kokoro.isAvailable()).isTrue();
        assertThat(kokoro.defaultVoice()).isEqualTo("af_heart");
    }

    static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(Duration d) {
            now = now.plus(d);
        }

        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
