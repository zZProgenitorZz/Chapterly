package com.chapterly.service;

/** MP3 audio plus the name of the provider that produced it. */
public record TtsResult(byte[] audio, String provider) {
}
