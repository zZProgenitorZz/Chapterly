package com.chapterly.error;

/**
 * Single exception type for all TTS failures. The {@link Reason} decides both the
 * HTTP status and whether {@code TtsService} may fall back to the next provider.
 * {@link #getProvider()} names the provider that failed (set by the service), so the
 * client can tell "Kokoro" from "Azure" errors.
 */
public class TtsException extends Exception {

    public enum Reason {
        QUOTA(true),
        TIMEOUT(true),
        /** The provider can't be reached at all (e.g. local Kokoro server not running). */
        UNAVAILABLE(true),
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
    private String provider;

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

    /** Name of the provider that produced this error, or null if it is not provider-specific. */
    public String getProvider() {
        return provider;
    }

    /** Records which provider failed; the first provider set wins. */
    public TtsException withProvider(String provider) {
        if (this.provider == null) {
            this.provider = provider;
        }
        return this;
    }
}
