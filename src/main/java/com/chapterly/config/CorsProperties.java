package com.chapterly.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.util.List;

@ConfigurationProperties(prefix = "chapterly.cors")
public record CorsProperties(
        @DefaultValue({"chrome-extension://*", "moz-extension://*"}) List<String> allowedOriginPatterns) {
}
