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
import java.util.Locale;

/** Azure Speech (REST) provider. Knows only the Azure API. */
@Component
public class AzureTtsProvider implements TtsProvider {

    static final String OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

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
    public byte[] synthesize(String text) throws TtsException {
        if (!props.isConfigured()) {
            throw new TtsException(Reason.UPSTREAM_ERROR,
                    "Azure is not configured (set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION)");
        }

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://" + props.region() + ".tts.speech.microsoft.com/cognitiveservices/v1"))
                .timeout(props.timeout())
                .header("Ocp-Apim-Subscription-Key", props.key())
                .header("Content-Type", "application/ssml+xml")
                .header("X-Microsoft-OutputFormat", OUTPUT_FORMAT)
                .header("User-Agent", "chapterly")
                .POST(HttpRequest.BodyPublishers.ofString(ssmlBuilder.build(props.voice(), text), StandardCharsets.UTF_8))
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
