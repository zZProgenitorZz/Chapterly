package com.chapterly.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

/** Azure Speech settings. The key comes from AZURE_SPEECH_KEY and must never be logged. */
@ConfigurationProperties(prefix = "chapterly.azure")
public record AzureProperties(
        String key,
        String region,
        @DefaultValue("en-US-BrianNeural") String voice,
        @DefaultValue("8s") Duration timeout) {

    public boolean isConfigured() {
        return key != null && !key.isBlank() && region != null && !region.isBlank();
    }

    /** Redacts the key so accidentally logging this object is harmless. */
    @Override
    public String toString() {
        return "AzureProperties[region=" + region + ", voice=" + voice + ", timeout=" + timeout + ", key=***]";
    }
}
