package com.chapterly.service;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.provider.TtsProvider;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TtsServiceTest {

    /** Fake provider that either returns fixed audio or throws a given reason, and counts calls. */
    static final class FakeProvider implements TtsProvider {
        private final String name;
        private final Reason failWith;
        int calls;

        FakeProvider(String name, Reason failWith) {
            this.name = name;
            this.failWith = failWith;
        }

        static FakeProvider ok(String name) {
            return new FakeProvider(name, null);
        }

        static FakeProvider failing(String name, Reason reason) {
            return new FakeProvider(name, reason);
        }

        @Override
        public String name() {
            return name;
        }

        @Override
        public byte[] synthesize(String text) throws TtsException {
            calls++;
            if (failWith != null) {
                throw new TtsException(failWith, name + " failed");
            }
            return name.getBytes();
        }
    }

    @Test
    void usesFirstProviderWhenItSucceeds() throws TtsException {
        FakeProvider first = FakeProvider.ok("first");
        FakeProvider second = FakeProvider.ok("second");

        TtsResult result = new TtsService(List.of(first, second)).synthesize("hi");

        assertThat(result.provider()).isEqualTo("first");
        assertThat(result.audio()).isEqualTo("first".getBytes());
        assertThat(second.calls).isZero();
    }

    @Test
    void fallsBackOnQuota() throws TtsException {
        FakeProvider first = FakeProvider.failing("first", Reason.QUOTA);
        FakeProvider second = FakeProvider.ok("second");

        TtsResult result = new TtsService(List.of(first, second)).synthesize("hi");

        assertThat(result.provider()).isEqualTo("second");
        assertThat(first.calls).isEqualTo(1);
    }

    @Test
    void fallsBackOnTimeout() throws TtsException {
        FakeProvider first = FakeProvider.failing("first", Reason.TIMEOUT);
        FakeProvider second = FakeProvider.ok("second");

        TtsResult result = new TtsService(List.of(first, second)).synthesize("hi");

        assertThat(result.provider()).isEqualTo("second");
    }

    @Test
    void doesNotFallBackOnBadInput() {
        FakeProvider first = FakeProvider.failing("first", Reason.BAD_INPUT);
        FakeProvider second = FakeProvider.ok("second");

        assertThatThrownBy(() -> new TtsService(List.of(first, second)).synthesize("hi"))
                .isInstanceOf(TtsException.class)
                .extracting(e -> ((TtsException) e).getReason())
                .isEqualTo(Reason.BAD_INPUT);
        assertThat(second.calls).isZero();
    }

    @Test
    void doesNotFallBackOnUpstreamError() {
        FakeProvider first = FakeProvider.failing("first", Reason.UPSTREAM_ERROR);
        FakeProvider second = FakeProvider.ok("second");

        assertThatThrownBy(() -> new TtsService(List.of(first, second)).synthesize("hi"))
                .extracting(e -> ((TtsException) e).getReason())
                .isEqualTo(Reason.UPSTREAM_ERROR);
        assertThat(second.calls).isZero();
    }

    @Test
    void throwsLastErrorWhenAllProvidersFail() {
        FakeProvider first = FakeProvider.failing("first", Reason.QUOTA);
        FakeProvider second = FakeProvider.failing("second", Reason.TIMEOUT);

        assertThatThrownBy(() -> new TtsService(List.of(first, second)).synthesize("hi"))
                .isInstanceOf(TtsException.class)
                .hasMessage("second failed")
                .extracting(e -> ((TtsException) e).getReason())
                .isEqualTo(Reason.TIMEOUT);
        assertThat(first.calls).isEqualTo(1);
        assertThat(second.calls).isEqualTo(1);
    }
}
