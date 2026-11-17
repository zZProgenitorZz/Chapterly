package com.chapterly.service;

/**
 * MP3 audio plus who made it.
 *
 * @param provider name of the provider that answered
 * @param voice    voice actually used
 * @param fallback true if another provider than the requested one answered
 */
public record TtsResult(byte[] audio, String provider, String voice, boolean fallback) {
}
