package com.chapterly.provider;

import com.chapterly.error.TtsException;

/**
 * A text-to-speech backend.
 *
 * <p>Contract: {@link #synthesize} must return MP3 audio (audio/mpeg), so callers never
 * need to know which provider produced it. Failures must be reported as a
 * {@link TtsException} with the right reason; QUOTA and TIMEOUT let the service fall back
 * to the next provider.
 */
public interface TtsProvider {

    /** Short, stable id used in {@code chapterly.providers} and the X-TTS-Provider header. */
    String name();

    byte[] synthesize(String text) throws TtsException;
}
