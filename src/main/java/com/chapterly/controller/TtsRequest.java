package com.chapterly.controller;

/**
 * Body of POST /api/tts.
 *
 * @param provider optional: "kokoro" or "azure"; default is the first available provider
 * @param voice    optional voice id of that provider; default is the provider's default voice
 */
public record TtsRequest(String text, String provider, String voice) {

    public TtsRequest(String text) {
        this(text, null, null);
    }
}
