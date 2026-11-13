package com.chapterly.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.util.List;

/** Top-level settings. {@code providers} is the fallback order, by provider name. */
@ConfigurationProperties(prefix = "chapterly")
public record ChapterlyProperties(@DefaultValue("azure") List<String> providers) {
}
