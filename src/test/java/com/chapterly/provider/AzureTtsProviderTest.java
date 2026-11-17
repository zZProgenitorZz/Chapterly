package com.chapterly.provider;

import com.chapterly.config.AzureProperties;
import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Tests the HTTP status -> Reason mapping, voices and config without calling Azure. */
class AzureTtsProviderTest {

    @Test
    void returnsAudioOn200() throws TtsException {
        byte[] mp3 = {1, 2, 3};
        assertThat(AzureTtsProvider.handleResponse(200, mp3)).isEqualTo(mp3);
    }

    @Test
    void mapsRateLimitToQuota() {
        assertReason(429, "", Reason.QUOTA);
    }

    @Test
    void mapsQuota403ToQuota() {
        assertReason(403, "{\"error\":\"Out of call volume quota\"}", Reason.QUOTA);
    }

    @Test
    void mapsOther403ToUpstreamError() {
        assertReason(403, "Forbidden", Reason.UPSTREAM_ERROR);
    }

    @Test
    void mapsAuthAndServerErrorsToUpstreamError() {
        assertReason(401, "", Reason.UPSTREAM_ERROR);
        assertReason(500, "", Reason.UPSTREAM_ERROR);
    }

    @Test
    void emptyAudioIsUpstreamError() {
        assertReason(200, "", Reason.UPSTREAM_ERROR);
    }

    // ---------- voices and configuration (no network) ----------

    private static AzureProperties props(String key, String region) {
        return new AzureProperties(key, region, "en-US-BrianNeural", Duration.ofSeconds(8),
                List.of("en-US-BrianNeural", "en-US-AvaNeural", "en-GB-RyanNeural", "en-GB-SoniaNeural"));
    }

    @Test
    void describesItself() {
        AzureTtsProvider azure = new AzureTtsProvider(props("k", "switzerlandnorth"), new SsmlBuilder());
        assertThat(azure.name()).isEqualTo("azure");
        assertThat(azure.displayName()).isEqualTo("Microsoft Azure");
        assertThat(azure.defaultVoice()).isEqualTo("en-US-BrianNeural");
    }

    @Test
    void availableOnlyWithKeyAndRegion() {
        assertThat(new AzureTtsProvider(props("k", "switzerlandnorth"), new SsmlBuilder()).isAvailable()).isTrue();
        assertThat(new AzureTtsProvider(props("", "switzerlandnorth"), new SsmlBuilder()).isAvailable()).isFalse();
        assertThat(new AzureTtsProvider(props("k", null), new SsmlBuilder()).isAvailable()).isFalse();
    }

    @Test
    void voicesComeFromConfigWithLabels() {
        List<Voice> voices = new AzureTtsProvider(props("k", "r"), new SsmlBuilder()).voices();
        assertThat(voices).extracting(Voice::id)
                .containsExactly("en-US-BrianNeural", "en-US-AvaNeural", "en-GB-RyanNeural", "en-GB-SoniaNeural");
        assertThat(voices.getFirst()).isEqualTo(new Voice("en-US-BrianNeural", "Brian (US, male)", "en-US", "male"));
        assertThat(voices.get(3)).isEqualTo(new Voice("en-GB-SoniaNeural", "Sonia (GB, female)", "en-GB", "female"));
    }

    @Test
    void labelsForOtherVoiceIds() {
        assertThat(AzureTtsProvider.toVoice("en-US-AndrewMultilingualNeural").label()).isEqualTo("Andrew (US, male)");
        assertThat(AzureTtsProvider.toVoice("en-AU-NatashaNeural")).isEqualTo(new Voice("en-AU-NatashaNeural", "Natasha (AU)", "en-AU", null));
        assertThat(AzureTtsProvider.toVoice("weird").label()).isEqualTo("weird");
    }

    @Test
    void defaultVoiceIsOfferedEvenIfMissingFromTheList() {
        AzureProperties p = new AzureProperties("k", "r", "en-US-JennyNeural", Duration.ofSeconds(8), List.of("en-US-BrianNeural"));
        assertThat(new AzureTtsProvider(p, new SsmlBuilder()).voices()).extracting(Voice::id)
                .containsExactly("en-US-JennyNeural", "en-US-BrianNeural");
    }

    @Test
    void rejectsVoicesOutsideTheConfiguredList() {
        AzureTtsProvider azure = new AzureTtsProvider(props("k", "switzerlandnorth"), new SsmlBuilder());
        assertThatThrownBy(() -> azure.synthesize("Hi", "en-US-SomeoneElseNeural"))
                .hasMessage("Unknown Azure voice")
                .extracting(e -> ((TtsException) e).getReason())
                .isEqualTo(Reason.BAD_INPUT);
    }

    @Test
    void refusesToRunWithoutCredentials() {
        AzureTtsProvider azure = new AzureTtsProvider(props("", ""), new SsmlBuilder());
        assertThatThrownBy(() -> azure.synthesize("Hi", null))
                .hasMessage("Azure is not configured on the backend")
                .extracting(e -> ((TtsException) e).getReason())
                .isEqualTo(Reason.BAD_INPUT);
    }

    @Test
    void credentialsAreTrimmedAndUnquoted() {
        AzureProperties p = props(" \"abc123\" ", "'switzerlandnorth'");
        assertThat(p.key()).isEqualTo("abc123");
        assertThat(p.region()).isEqualTo("switzerlandnorth");
        assertThat(p.toString()).doesNotContain("abc123").contains("key=***");
    }

    @Test
    void ssmlLanguageFollowsTheVoice() {
        assertThat(new SsmlBuilder().build("en-GB-RyanNeural", "Hi")).contains("xml:lang=\"en-GB\"");
        assertThat(new SsmlBuilder().build("en-US-BrianNeural", "Hi")).contains("xml:lang=\"en-US\"");
    }

    private static void assertReason(int status, String body, Reason expected) {
        assertThatThrownBy(() -> AzureTtsProvider.handleResponse(status, body.getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(TtsException.class)
                .extracting(e -> ((TtsException) e).getReason())
                .isEqualTo(expected);
    }
}
