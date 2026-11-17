package com.chapterly.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.util.List;

/**
 * Top-level settings.
 *
 * @param providers configured providers by name; the first available one is the default
 * @param fallback  whether to try the other providers when the requested one fails recoverably
 */
@ConfigurationProperties(prefix = "chapterly")
public record ChapterlyProperties(
        @DefaultValue({"kokoro", "azure"}) List<String> providers,
        @DefaultValue("true") boolean fallback) {
}
