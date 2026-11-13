package com.chapterly.service;

import com.chapterly.error.TtsException;
import com.chapterly.provider.TtsProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;

/**
 * Tries providers in order. Recoverable failures (QUOTA, TIMEOUT) move on to the next
 * provider; anything else is rethrown immediately. If every provider fails, the last
 * error is thrown. Never logs the text or any credentials.
 */
public class TtsService {

    private static final Logger log = LoggerFactory.getLogger(TtsService.class);

    private final List<TtsProvider> providers;

    public TtsService(List<TtsProvider> providers) {
        if (providers == null || providers.isEmpty()) {
            throw new IllegalArgumentException("At least one TTS provider is required (chapterly.providers)");
        }
        this.providers = List.copyOf(providers);
    }

    public TtsResult synthesize(String text) throws TtsException {
        TtsException last = null;
        for (TtsProvider provider : providers) {
            long start = System.nanoTime();
            try {
                byte[] audio = provider.synthesize(text);
                log.info("TTS served by '{}' ({} chars -> {} bytes in {} ms)",
                        provider.name(), text.length(), audio.length, (System.nanoTime() - start) / 1_000_000);
                return new TtsResult(audio, provider.name());
            } catch (TtsException e) {
                if (!e.isRecoverable()) {
                    log.warn("TTS provider '{}' failed: {} (not recoverable)", provider.name(), e.getReason());
                    throw e;
                }
                log.warn("TTS provider '{}' failed: {}, trying next provider", provider.name(), e.getReason());
                last = e;
            }
        }
        throw last;
    }
}
