package com.chapterly.service;

import com.chapterly.provider.Voice;

import java.util.List;

/** Response of GET /api/voices: every configured provider with its voices. */
public record VoiceCatalog(String defaultProvider, List<ProviderVoices> providers) {

    /** {@code voices} is empty for providers that are not available. */
    public record ProviderVoices(
            String name, String displayName, boolean available, String defaultVoice, List<Voice> voices) {
    }
}
