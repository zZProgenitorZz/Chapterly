package com.chapterly.service;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.provider.TtsProvider;
import com.chapterly.provider.Voice;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TtsServiceTest {

    /** Fake provider: returns fixed audio or throws a given reason, and records the voices it was asked for. */
    static final class FakeProvider implements TtsProvider {
        private final String name;
        private final String defaultVoice;
        private final boolean available;
        private Reason failWith;
        boolean queued;
        final List<String> calls = new ArrayList<>();
        int voicesCalls;

        FakeProvider(String name, String defaultVoice, boolean available, Reason failWith) {
            this.name = name;
            this.defaultVoice = defaultVoice;
            this.available = available;
            this.failWith = failWith;
        }

        static FakeProvider kokoro() {
            return new FakeProvider("kokoro", "af_heart", true, null);
        }

        static FakeProvider azure() {
            return new FakeProvider("azure", "en-US-BrianNeural", true, null);
        }

        FakeProvider failing(Reason reason) {
            this.failWith = reason;
            return this;
        }

        FakeProvider unavailable() {
            return new FakeProvider(name, defaultVoice, false, failWith);
        }

        @Override
        public String name() {
            return name;
        }

        @Override
        public String displayName() {
            return name + " display";
        }

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public String defaultVoice() {
            return defaultVoice;
        }

        @Override
        public List<Voice> voices() {
            voicesCalls++;
            return List.of(new Voice(defaultVoice, "Default", "en-US", "female"));
        }

        FakeProvider asQueued() {
            this.queued = true;
            return this;
        }

        @Override
        public boolean queued() {
            return queued;
        }

        @Override
        public byte[] synthesize(String text, String voice) throws TtsException {
            calls.add(voice);
            if (failWith != null) {
                throw new TtsException(failWith, name + " failed");
            }
            return (name + ":" + voice).getBytes();
        }
    }

    @Test
    void textOnlyUsesTheFirstProviderAndItsDefaultVoice() throws TtsException {
        FakeProvider kokoro = FakeProvider.kokoro();
        FakeProvider azure = FakeProvider.azure();

        TtsResult result = new TtsService(List.of(kokoro, azure), true).synthesize("hi");

        assertThat(result.provider()).isEqualTo("kokoro");
        assertThat(result.voice()).isEqualTo("af_heart");
        assertThat(result.fallback()).isFalse();
        assertThat(kokoro.calls).containsExactly("af_heart");
        assertThat(azure.calls).isEmpty();
    }

    @Test
    void requestedProviderAndVoiceAreTriedFirst() throws TtsException {
        FakeProvider kokoro = FakeProvider.kokoro();
        FakeProvider azure = FakeProvider.azure();

        TtsResult result = new TtsService(List.of(kokoro, azure), true).synthesize("hi", "azure", "en-GB-RyanNeural");

        assertThat(result.provider()).isEqualTo("azure");
        assertThat(result.voice()).isEqualTo("en-GB-RyanNeural");
        assertThat(result.fallback()).isFalse();
        assertThat(kokoro.calls).isEmpty();
    }

    @ParameterizedTest
    @EnumSource(value = Reason.class, names = {"QUOTA", "TIMEOUT", "UNAVAILABLE"})
    void recoverableFailureFallsBackToTheOtherProviderWithItsDefaultVoice(Reason reason) throws TtsException {
        FakeProvider kokoro = FakeProvider.kokoro().failing(reason);
        FakeProvider azure = FakeProvider.azure();

        TtsResult result = new TtsService(List.of(kokoro, azure), true).synthesize("hi", "kokoro", "bm_george");

        assertThat(kokoro.calls).containsExactly("bm_george");
        assertThat(azure.calls).containsExactly("en-US-BrianNeural");
        assertThat(result.provider()).isEqualTo("azure");
        assertThat(result.voice()).isEqualTo("en-US-BrianNeural");
        assertThat(result.fallback()).isTrue();
    }

    @Test
    void fallbackFollowsConfigOrderAfterTheRequestedProvider() throws TtsException {
        FakeProvider a = new FakeProvider("a", "va", true, null);
        FakeProvider b = new FakeProvider("b", "vb", true, Reason.QUOTA);
        FakeProvider c = new FakeProvider("c", "vc", true, null);

        TtsResult result = new TtsService(List.of(a, b, c), true).synthesize("hi", "b", null);

        assertThat(result.provider()).isEqualTo("a");
        assertThat(c.calls).isEmpty();
    }

    @Test
    void noFallbackWhenDisabled() {
        FakeProvider kokoro = FakeProvider.kokoro().failing(Reason.UNAVAILABLE);
        FakeProvider azure = FakeProvider.azure();

        assertThatThrownBy(() -> new TtsService(List.of(kokoro, azure), false).synthesize("hi"))
                .isInstanceOf(TtsException.class)
                .satisfies(e -> {
                    assertThat(((TtsException) e).getReason()).isEqualTo(Reason.UNAVAILABLE);
                    assertThat(((TtsException) e).getProvider()).isEqualTo("kokoro");
                });
        assertThat(azure.calls).isEmpty();
    }

    @Test
    void unavailableProvidersAreSkippedDuringFallback() {
        FakeProvider kokoro = FakeProvider.kokoro().failing(Reason.UNAVAILABLE);
        FakeProvider azure = FakeProvider.azure().unavailable();

        assertThatThrownBy(() -> new TtsService(List.of(kokoro, azure), true).synthesize("hi"))
                .satisfies(e -> assertThat(((TtsException) e).getReason()).isEqualTo(Reason.UNAVAILABLE));
        assertThat(azure.calls).isEmpty();
    }

    @ParameterizedTest
    @EnumSource(value = Reason.class, names = {"BAD_INPUT", "UPSTREAM_ERROR"})
    void nonRecoverableFailureIsNotRetriedElsewhere(Reason reason) {
        FakeProvider kokoro = FakeProvider.kokoro().failing(reason);
        FakeProvider azure = FakeProvider.azure();

        assertThatThrownBy(() -> new TtsService(List.of(kokoro, azure), true).synthesize("hi"))
                .satisfies(e -> assertThat(((TtsException) e).getReason()).isEqualTo(reason));
        assertThat(azure.calls).isEmpty();
    }

    @Test
    void lastErrorIsThrownWhenAllProvidersFail() {
        FakeProvider kokoro = FakeProvider.kokoro().failing(Reason.UNAVAILABLE);
        FakeProvider azure = FakeProvider.azure().failing(Reason.QUOTA);

        assertThatThrownBy(() -> new TtsService(List.of(kokoro, azure), true).synthesize("hi"))
                .hasMessage("azure failed")
                .satisfies(e -> {
                    assertThat(((TtsException) e).getReason()).isEqualTo(Reason.QUOTA);
                    assertThat(((TtsException) e).getProvider()).isEqualTo("azure");
                });
    }

    @Test
    void unknownProviderIsBadInput() {
        assertThatThrownBy(() -> new TtsService(List.of(FakeProvider.kokoro()), true).synthesize("hi", "polly", null))
                .hasMessage("Unknown TTS provider 'polly'")
                .satisfies(e -> assertThat(((TtsException) e).getReason()).isEqualTo(Reason.BAD_INPUT));
    }

    @Test
    void requestingAnUnconfiguredProviderIsBadInput() {
        FakeProvider azure = FakeProvider.azure().unavailable();

        assertThatThrownBy(() -> new TtsService(List.of(FakeProvider.kokoro(), azure), true).synthesize("hi", "azure", null))
                .hasMessage("Azure is not configured on the backend")
                .satisfies(e -> {
                    assertThat(((TtsException) e).getReason()).isEqualTo(Reason.BAD_INPUT);
                    assertThat(((TtsException) e).getProvider()).isEqualTo("azure");
                });
        assertThat(azure.calls).isEmpty();
    }

    @Test
    void defaultProviderIsTheFirstAvailableOne() throws TtsException {
        FakeProvider azure = FakeProvider.azure().unavailable();
        FakeProvider kokoro = FakeProvider.kokoro();

        assertThat(new TtsService(List.of(azure, kokoro), true).synthesize("hi").provider()).isEqualTo("kokoro");
    }

    @Test
    void listVoicesSkipsVoicesOfUnavailableProviders() {
        FakeProvider kokoro = FakeProvider.kokoro();
        FakeProvider azure = FakeProvider.azure().unavailable();

        VoiceCatalog catalog = new TtsService(List.of(kokoro, azure), true).listVoices();

        assertThat(catalog.defaultProvider()).isEqualTo("kokoro");
        assertThat(catalog.providers()).extracting(VoiceCatalog.ProviderVoices::name).containsExactly("kokoro", "azure");
        VoiceCatalog.ProviderVoices k = catalog.providers().get(0);
        assertThat(k.available()).isTrue();
        assertThat(k.defaultVoice()).isEqualTo("af_heart");
        assertThat(k.voices()).hasSize(1);
        VoiceCatalog.ProviderVoices a = catalog.providers().get(1);
        assertThat(a.available()).isFalse();
        assertThat(a.voices()).isEmpty();
        assertThat(azure.voicesCalls).isZero();
    }

    // ---------- with the Kokoro queue ----------

    @Test
    void queuedProviderTimeoutStillFallsBackToAzure() throws TtsException {
        FakeProvider kokoro = FakeProvider.kokoro().asQueued().failing(Reason.TIMEOUT);
        FakeProvider azure = FakeProvider.azure();
        TtsQueue queue = new TtsQueue(1);

        TtsResult result = new TtsService(List.of(kokoro, azure), true, queue)
                .synthesize("hi", "kokoro", null, new TtsRequestOptions("r1", TtsQueue.Priority.NOW));

        assertThat(result.provider()).isEqualTo("azure");
        assertThat(result.fallback()).isTrue();
        assertThat(kokoro.calls).containsExactly("af_heart");
        assertThat(queue.running()).isZero();
    }

    @Test
    void aRequestCancelledBeforeItRanNeverFallsBack() {
        FakeProvider kokoro = FakeProvider.kokoro().asQueued();
        FakeProvider azure = FakeProvider.azure();
        TtsService service = new TtsService(List.of(kokoro, azure), true, new TtsQueue(1));

        assertThat(service.cancel("gone")).isFalse(); // not queued (yet): remembered
        assertThatThrownBy(() -> service.synthesize("hi", null, null, new TtsRequestOptions("gone", TtsQueue.Priority.PREFETCH)))
                .isInstanceOf(CancellationException.class);
        assertThat(kokoro.calls).isEmpty();
        assertThat(azure.calls).isEmpty();
    }

    @Test
    void azureDoesNotWaitBehindABusyKokoroQueue() throws Exception {
        FakeProvider kokoro = FakeProvider.kokoro().asQueued();
        FakeProvider azure = FakeProvider.azure();
        TtsQueue queue = new TtsQueue(1);
        TtsService service = new TtsService(List.of(kokoro, azure), true, queue);

        CountDownLatch release = new CountDownLatch(1);
        Thread busy = Thread.ofVirtual().start(() -> {
            try {
                queue.run("busy", TtsQueue.Priority.NOW, () -> {
                    try {
                        release.await();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                    return null;
                });
            } catch (Exception ignored) {
                // test cleanup
            }
        });
        while (queue.running() == 0) {
            Thread.sleep(2);
        }

        TtsResult result = service.synthesize("hi", "azure", null, new TtsRequestOptions("a", TtsQueue.Priority.PREFETCH));
        assertThat(result.provider()).isEqualTo("azure");

        release.countDown();
        busy.join(TimeUnit.SECONDS.toMillis(5));
    }

    @Test
    void withoutAQueueCancelIsANoOp() {
        assertThat(new TtsService(List.of(FakeProvider.kokoro()), true).cancel("x")).isFalse();
    }
}
