package com.chapterly.provider;

/**
 * A voice a provider offers.
 *
 * @param id       provider-specific id sent back in requests ("af_heart", "en-US-BrianNeural")
 * @param label    human-readable label ("Heart (US, female)")
 * @param language BCP 47 language ("en-US", "en-GB")
 * @param gender   "female", "male", or null if unknown
 */
public record Voice(String id, String label, String language, String gender) {
}
