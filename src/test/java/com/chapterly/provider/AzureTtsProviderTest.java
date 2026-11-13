package com.chapterly.provider;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Tests the HTTP status -> Reason mapping without calling Azure. */
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

    private static void assertReason(int status, String body, Reason expected) {
        assertThatThrownBy(() -> AzureTtsProvider.handleResponse(status, body.getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(TtsException.class)
                .extracting(e -> ((TtsException) e).getReason())
                .isEqualTo(expected);
    }
}
