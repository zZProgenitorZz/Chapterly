package com.chapterly.provider;

import com.chapterly.config.AzureProperties;
import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Azure Speech (REST) provider. Knows only the Azure API. */
@Component
public class AzureTtsProvider implements TtsProvider {

    static final String OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

    /** "en-US-BrianNeural" -> locale "en-US", name "Brian". */
    private static final Pattern VOICE_ID = Pattern.compile("^([a-z]{2,3})-([A-Z]{2})-([A-Za-z]+?)(?:Multilingual)?Neural$");

    /** Azure voice ids don't encode gender; these are the ones we offer by default. */
    private static final Map<String, String> KNOWN_GENDERS = Map.ofEntries(
            Map.entry("Brian", "male"), Map.entry("Andrew", "male"), Map.entry("Guy", "male"),
            Map.entry("Ryan", "male"), Map.entry("Davis", "male"), Map.entry("Christopher", "male"),
            Map.entry("Ava", "female"), Map.entry("Emma", "female"), Map.entry("Jenny", "female"),
            Map.entry("Sonia", "female"), Map.entry("Aria", "female"), Map.entry("Libby", "female"));

    private final AzureProperties props;
    private final SsmlBuilder ssmlBuilder;
    private final HttpClient httpClient;

    public AzureTtsProvider(AzureProperties props, SsmlBuilder ssmlBuilder) {
        this.props = props;
        this.ssmlBuilder = ssmlBuilder;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(props.timeout())
                .build();
    }

    @Override
    public String name() {
        return "azure";
    }

    @Override
    public String displayName() {
        return "Microsoft Azure";
    }

    @Override
    public boolean isAvailable() {
        return props.isConfigured();
    }

    @Override
    public String defaultVoice() {
        return props.voice();
    }

    /** The configured list (default voice first if it is missing from the list). No API call. */
    @Override
    public List<Voice> voices() {
        return offeredVoiceIds().stream().map(AzureTtsProvider::toVoice).toList();
    }

    @Override
    public byte[] synthesize(String text, String voice) throws TtsException {
        if (!props.isConfigured()) {
            throw new TtsException(Reason.BAD_INPUT, "Azure is not configured on the backend");
        }
        String voiceId = voice == null || voice.isBlank() ? props.voice() : voice;
        if (!offeredVoiceIds().contains(voiceId)) {
            throw new TtsException(Reason.BAD_INPUT, "Unknown Azure voice");
        }

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://" + props.region() + ".tts.speech.microsoft.com/cognitiveservices/v1"))
                .timeout(props.timeout())
                .header("Ocp-Apim-Subscription-Key", props.key())
                .header("Content-Type", "application/ssml+xml")
                .header("X-Microsoft-OutputFormat", OUTPUT_FORMAT)
                .header("User-Agent", "chapterly")
                .POST(HttpRequest.BodyPublishers.ofString(ssmlBuilder.build(voiceId, text), StandardCharsets.UTF_8))
                .build();

        HttpResponse<byte[]> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
        } catch (HttpTimeoutException e) { // includes HttpConnectTimeoutException
            throw new TtsException(Reason.TIMEOUT,
                    "Azure did not respond within " + props.timeout().toMillis() + " ms", e);
        } catch (IOException e) {
            throw new TtsException(Reason.UPSTREAM_ERROR,
                    "Could not reach Azure (" + e.getClass().getSimpleName() + ")", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new TtsException(Reason.UPSTREAM_ERROR, "Interrupted while calling Azure", e);
        }

        return handleResponse(response.statusCode(), response.body());
    }

    private List<String> offeredVoiceIds() {
        List<String> ids = new ArrayList<>(props.voices());
        if (!ids.contains(props.voice())) {
            ids.addFirst(props.voice());
        }
        return ids;
    }

    /** "en-US-BrianNeural" -> Voice("en-US-BrianNeural", "Brian (US, male)", "en-US", "male"). */
    static Voice toVoice(String id) {
        Matcher m = VOICE_ID.matcher(id);
        if (!m.matches()) {
            return new Voice(id, id, null, null);
        }
        String country = m.group(2);
        String name = m.group(3);
        String gender = KNOWN_GENDERS.get(name);
        String label = name + " (" + country + (gender != null ? ", " + gender : "") + ")";
        return new Voice(id, label, m.group(1) + "-" + country, gender);
    }

    /** Maps an Azure HTTP response to MP3 bytes or a TtsException. Package-private for tests. */
    static byte[] handleResponse(int status, byte[] body) throws TtsException {
        if (status == 200) {
            if (body == null || body.length == 0) {
                throw new TtsException(Reason.UPSTREAM_ERROR, "Azure returned empty audio");
            }
            return body;
        }
        if (status == 429) {
            throw new TtsException(Reason.QUOTA, "Azure rate limit reached (HTTP 429)");
        }
        if (status == 403 && isQuotaError(body)) {
            throw new TtsException(Reason.QUOTA, "Azure quota exceeded (HTTP 403)");
        }
        throw new TtsException(Reason.UPSTREAM_ERROR, "Azure returned HTTP " + status);
    }

    private static boolean isQuotaError(byte[] body) {
        if (body == null || body.length == 0) {
            return false;
        }
        String s = new String(body, StandardCharsets.UTF_8).toLowerCase(Locale.ROOT);
        return s.contains("quota") || s.contains("out of call volume");
    }
}
