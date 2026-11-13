package com.chapterly.error;

/**
 * Single exception type for all TTS failures. The {@link Reason} decides both the
 * HTTP status and whether {@code TtsService} may fall back to the next provider.
 */
public class TtsException extends Exception {

    public enum Reason {
        QUOTA(true),
        TIMEOUT(true),
        UPSTREAM_ERROR(false),
        BAD_INPUT(false);

        private final boolean recoverable;

        Reason(boolean recoverable) {
            this.recoverable = recoverable;
        }

        /** True if another provider might succeed where this one failed. */
        public boolean isRecoverable() {
            return recoverable;
        }
    }

    private final Reason reason;

    public TtsException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    public TtsException(Reason reason, String message, Throwable cause) {
        super(message, cause);
        this.reason = reason;
    }

    public Reason getReason() {
        return reason;
    }

    public boolean isRecoverable() {
        return reason.isRecoverable();
    }
}
