package com.chapterly.provider;

import com.chapterly.error.TtsException;

import java.util.List;

/**
 * A text-to-speech backend.
 *
 * <p>Contract: {@link #synthesize} must return MP3 audio (audio/mpeg), so callers never
 * need to know which provider produced it. Failures must be reported as a
 * {@link TtsException} with the right reason; QUOTA, TIMEOUT and UNAVAILABLE let the
 * service fall back to another provider.
 */
public interface TtsProvider {

    /** Short, stable id used in config ({@code chapterly.providers}), requests and the X-TTS-Provider header. */
    String name();

    /** Name shown to users, e.g. "Kokoro (local)". */
    String displayName();

    /**
     * Whether the provider is configured and may be offered. A configured provider can
     * still fail at runtime (e.g. a local server that is down); that is a TtsException.
     */
    boolean isAvailable();

    /** Voice used when a request names none, and when this provider serves as a fallback. */
    String defaultVoice();

    /** Voices to offer. May call the provider, but must not throw: return a fallback list instead. */
    List<Voice> voices();

    /**
     * @param voice voice id from {@link #voices()}, or null for {@link #defaultVoice()}
     * @throws TtsException BAD_INPUT for a voice this provider does not offer
     */
    byte[] synthesize(String text, String voice) throws TtsException;

    /**
     * True for a local engine that does one request at a time anyway (Kokoro on one GPU or
     * CPU): its requests then go through the {@code TtsQueue}, so the chunk a listener is
     * waiting for runs before prefetches and cancelled requests never reach the engine.
     * Remote providers (Azure) run in parallel and return false.
     */
    default boolean queued() {
        return false;
    }
}
