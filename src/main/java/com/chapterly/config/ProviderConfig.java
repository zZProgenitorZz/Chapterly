package com.chapterly.config;

import com.chapterly.provider.TtsProvider;
import com.chapterly.service.TtsService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Wires every {@link TtsProvider} bean into {@link TtsService} in the order given by
 * {@code chapterly.providers}. Adding a provider = a new {@code @Component} + its name in config.
 */
@Configuration
public class ProviderConfig {

    @Bean
    public TtsService ttsService(ChapterlyProperties props, List<TtsProvider> available) {
        Map<String, TtsProvider> byName = available.stream()
                .collect(Collectors.toMap(TtsProvider::name, Function.identity()));

        List<TtsProvider> ordered = props.providers().stream()
                .map(name -> {
                    TtsProvider provider = byName.get(name);
                    if (provider == null) {
                        throw new IllegalStateException("Unknown TTS provider '" + name
                                + "' in chapterly.providers. Available: " + byName.keySet());
                    }
                    return provider;
                })
                .toList();

        return new TtsService(ordered, props.fallback());
    }
}
