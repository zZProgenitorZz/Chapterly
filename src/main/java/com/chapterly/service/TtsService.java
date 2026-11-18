package com.chapterly.service;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.provider.TtsProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Picks the provider for a request. The requested provider (default: the first available
 * one in {@code chapterly.providers}) is tried first with the requested voice. On a
 * recoverable failure (QUOTA, TIMEOUT, UNAVAILABLE), and only if fallback is enabled, the
 * other available providers are tried in config order, each with its own default voice.
 * Non-recoverable errors are rethrown immediately; if every attempt fails, the last
 * error is thrown. Never logs the text or any credentials.
 *
 * <p>Providers that are {@link TtsProvider#queued() queued} (Kokoro) run through the
 * {@link TtsQueue}: one request at a time, the chunk a listener waits for first. The time a
 * request waits there does not count toward the provider's timeout, so a Kokoro TIMEOUT still
 * means slow generation and still falls back to the next provider. A request cancelled while
 * queued ends with a {@link java.util.concurrent.CancellationException} and never falls back.
 */
public class TtsService {

    private static final Logger log = LoggerFactory.getLogger(TtsService.class);

    private final List<TtsProvider> providers;
    private final boolean fallback;
    private final TtsQueue queue;

    /** Without a queue: every provider is called directly. */
    public TtsService(List<TtsProvider> providers, boolean fallback) {
        this(providers, fallback, null);
    }

    public TtsService(List<TtsProvider> providers, boolean fallback, TtsQueue queue) {
        if (providers == null || providers.isEmpty()) {
            throw new IllegalArgumentException("At least one TTS provider is required (chapterly.providers)");
        }
        this.providers = List.copyOf(providers);
        this.fallback = fallback;
        this.queue = queue;
    }

    /** Default provider and voice. */
    public TtsResult synthesize(String text) throws TtsException {
        return synthesize(text, null, null);
    }

    /**
     * @param providerName provider to try first, or null for the default provider
     * @param voice        voice for that provider, or null for its default voice
     */
    public TtsResult synthesize(String text, String providerName, String voice) throws TtsException {
        return synthesize(text, providerName, voice, TtsRequestOptions.DEFAULT);
    }

    /**
     * @param options request id (for {@link #cancel}) and priority in the queue
     * @throws java.util.concurrent.CancellationException if the request was cancelled while queued
     */
    public TtsResult synthesize(String text, String providerName, String voice, TtsRequestOptions options)
            throws TtsException {
        TtsRequestOptions opts = options == null ? TtsRequestOptions.DEFAULT : options;
        TtsProvider requested = resolve(providerName);

        List<TtsProvider> attempts = new ArrayList<>();
        attempts.add(requested);
        if (fallback) {
            providers.stream().filter(p -> p != requested && p.isAvailable()).forEach(attempts::add);
        }

        TtsException last = null;
        for (TtsProvider provider : attempts) {
            boolean isFallback = provider != requested;
            String voiceToUse = isFallback || voice == null || voice.isBlank() ? provider.defaultVoice() : voice;
            long start = System.nanoTime();
            try {
                byte[] audio = call(provider, text, voiceToUse, opts);
                log.info("TTS served by '{}' voice '{}'{} ({} chars -> {} bytes in {} ms)",
                        provider.name(), voiceToUse, isFallback ? " [fallback]" : "",
                        text.length(), audio.length, (System.nanoTime() - start) / 1_000_000);
                return new TtsResult(audio, provider.name(), voiceToUse, isFallback);
            } catch (TtsException e) {
                e.withProvider(provider.name());
                if (!e.isRecoverable()) {
                    log.warn("TTS provider '{}' voice '{}' failed: {} (not recoverable)", provider.name(), voiceToUse, e.getReason());
                    throw e;
                }
                log.warn("TTS provider '{}' voice '{}' failed: {}{}", provider.name(), voiceToUse, e.getReason(),
                        fallback ? ", trying next provider" : " (fallback disabled)");
                last = e;
            }
        }
        throw last;
    }

    /**
     * Drops a request that is still waiting in the queue. Never fails; a request that already
     * started runs to its end.
     *
     * @return true if a waiting request was removed
     */
    public boolean cancel(String requestId) {
        return queue != null && queue.cancel(requestId);
    }

    private byte[] call(TtsProvider provider, String text, String voice, TtsRequestOptions opts) throws TtsException {
        if (queue == null || !provider.queued()) {
            return provider.synthesize(text, voice);
        }
        return queue.run(opts.requestId(), opts.priority(), () -> provider.synthesize(text, voice));
    }

    /** Every configured provider with its voices (empty for providers that are not available). */
    public VoiceCatalog listVoices() {
        List<VoiceCatalog.ProviderVoices> list = providers.stream()
                .map(p -> new VoiceCatalog.ProviderVoices(
                        p.name(), p.displayName(), p.isAvailable(), p.defaultVoice(),
                        p.isAvailable() ? p.voices() : List.of()))
                .toList();
        return new VoiceCatalog(defaultProvider().name(), list);
    }

    /** First available provider in config order (the first one if none is available). */
    TtsProvider defaultProvider() {
        return providers.stream().filter(TtsProvider::isAvailable).findFirst().orElse(providers.getFirst());
    }

    private TtsProvider resolve(String providerName) throws TtsException {
        if (providerName == null || providerName.isBlank()) {
            return defaultProvider();
        }
        TtsProvider provider = providers.stream()
                .filter(p -> p.name().equalsIgnoreCase(providerName.strip()))
                .findFirst()
                .orElseThrow(() -> new TtsException(Reason.BAD_INPUT, "Unknown TTS provider '" + providerName.strip() + "'"));
        if (!provider.isAvailable()) {
            throw new TtsException(Reason.BAD_INPUT, capitalize(provider.name()) + " is not configured on the backend")
                    .withProvider(provider.name());
        }
        return provider;
    }

    private static String capitalize(String s) {
        return s.isEmpty() ? s : s.substring(0, 1).toUpperCase(Locale.ROOT) + s.substring(1);
    }
}
