package com.chapterly.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;
import java.util.List;

/**
 * Azure Speech settings. The key comes from AZURE_SPEECH_KEY (environment or ./.env)
 * and must never be logged.
 *
 * @param voice  default voice
 * @param voices voices offered to users; requests for other voices are rejected
 */
@ConfigurationProperties(prefix = "chapterly.azure")
public record AzureProperties(
        String key,
        String region,
        @DefaultValue("en-US-BrianNeural") String voice,
        @DefaultValue("8s") Duration timeout,
        @DefaultValue({
                "en-US-BrianNeural", "en-US-AndrewNeural", "en-US-GuyNeural", "en-US-AvaNeural",
                "en-US-EmmaNeural", "en-US-JennyNeural", "en-GB-RyanNeural", "en-GB-SoniaNeural"
        }) List<String> voices) {

    public AzureProperties {
        // .env files are read as .properties: KEY = "value" keeps the quotes. Strip them.
        key = clean(key);
        region = clean(region);
        voices = voices == null ? List.of() : voices.stream().map(AzureProperties::clean).filter(v -> !v.isEmpty()).toList();
    }

    public boolean isConfigured() {
        return !key.isEmpty() && !region.isEmpty();
    }

    /** Trims and removes one pair of surrounding quotes. */
    static String clean(String value) {
        if (value == null) {
            return "";
        }
        String v = value.strip();
        if (v.length() >= 2 && (v.startsWith("\"") && v.endsWith("\"") || v.startsWith("'") && v.endsWith("'"))) {
            v = v.substring(1, v.length() - 1).strip();
        }
        return v;
    }

    /** Redacts the key so accidentally logging this object is harmless. */
    @Override
    public String toString() {
        return "AzureProperties[region=" + region + ", voice=" + voice + ", timeout=" + timeout
                + ", voices=" + voices + ", key=***]";
    }
}
