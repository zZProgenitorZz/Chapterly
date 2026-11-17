package com.chapterly.config;

import com.chapterly.ChapterlyApplication;
import com.chapterly.provider.AzureTtsProvider;
import com.chapterly.service.TtsService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The backend reads ./.env as a properties file (spring.config.import in application.yml),
 * so ${AZURE_SPEECH_KEY:} and ${AZURE_SPEECH_REGION:} resolve from it. This boots the real
 * application config with a .env-style file in a temp directory.
 */
class EnvFileBindingTest {

    @TempDir
    Path dir;

    private ConfigurableApplicationContext start(Path envFile) {
        return new SpringApplicationBuilder(ChapterlyApplication.class)
                .web(WebApplicationType.NONE)
                .logStartupInfo(false)
                // The import line in application.yml, pointed at the temp file instead of ./.env
                // (so the developer's real .env never leaks into the test).
                .run("--chapterly.env-file=" + envFile.toAbsolutePath().toString().replace('\\', '/'));
    }

    @Test
    void azureCredentialsBindFromADotEnvFile() throws IOException {
        // Real environment variables win over the file; skip if this machine sets them.
        assumeTrue(System.getenv("AZURE_SPEECH_KEY") == null && System.getenv("AZURE_SPEECH_REGION") == null
                && System.getenv("KOKORO_BASE_URL") == null);

        Path env = dir.resolve(".env");
        Files.writeString(env, """
                # comments and blank lines are fine

                AZURE_SPEECH_KEY = "test-key-123"
                AZURE_SPEECH_REGION=switzerlandnorth
                KOKORO_BASE_URL=http://kokoro.test:9999
                ```
                """);

        try (ConfigurableApplicationContext ctx = start(env)) {
            AzureProperties azure = ctx.getBean(AzureProperties.class);
            assertThat(azure.key()).isEqualTo("test-key-123"); // quotes stripped
            assertThat(azure.region()).isEqualTo("switzerlandnorth");
            assertThat(azure.isConfigured()).isTrue();
            assertThat(ctx.getBean(AzureTtsProvider.class).isAvailable()).isTrue();
            assertThat(ctx.getBean(KokoroProperties.class).baseUrl()).isEqualTo("http://kokoro.test:9999");
            assertThat(ctx.getBean(TtsService.class).listVoices().providers())
                    .extracting(p -> p.name() + ":" + p.available())
                    .containsExactly("kokoro:true", "azure:true");
        }
    }

    @Test
    void withoutADotEnvFileAzureIsNotConfigured() {
        assumeTrue(System.getenv("AZURE_SPEECH_KEY") == null);

        try (ConfigurableApplicationContext ctx = start(dir.resolve("missing.env"))) {
            assertThat(ctx.getBean(AzureProperties.class).isConfigured()).isFalse();
            assertThat(ctx.getBean(KokoroProperties.class).baseUrl()).isEqualTo("http://localhost:8880");
            assertThat(ctx.getBean(TtsService.class).listVoices().defaultProvider()).isEqualTo("kokoro");
        }
    }
}
