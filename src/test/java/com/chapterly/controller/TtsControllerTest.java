package com.chapterly.controller;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.provider.Voice;
import com.chapterly.service.TtsResult;
import com.chapterly.service.TtsService;
import com.chapterly.service.VoiceCatalog;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(TtsController.class)
class TtsControllerTest {

    private static final byte[] MP3 = {0x49, 0x44, 0x33};

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private TtsService ttsService;

    private org.springframework.test.web.servlet.ResultActions postJson(String json) throws Exception {
        return mvc.perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content(json));
    }

    @Test
    void textOnlyBodyStillWorks() throws Exception {
        when(ttsService.synthesize("Hello", null, null)).thenReturn(new TtsResult(MP3, "kokoro", "af_heart", false));

        postJson("{\"text\":\"Hello\"}")
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/mpeg"))
                .andExpect(header().string("X-TTS-Provider", "kokoro"))
                .andExpect(header().string("X-TTS-Voice", "af_heart"))
                .andExpect(header().string("X-TTS-Fallback", "false"))
                .andExpect(content().bytes(MP3));
    }

    @Test
    void providerAndVoiceArePassedThrough() throws Exception {
        when(ttsService.synthesize("Hello", "azure", "en-US-BrianNeural"))
                .thenReturn(new TtsResult(MP3, "azure", "en-US-BrianNeural", false));

        postJson("{\"text\":\"Hello\",\"provider\":\"azure\",\"voice\":\"en-US-BrianNeural\"}")
                .andExpect(status().isOk())
                .andExpect(header().string("X-TTS-Provider", "azure"))
                .andExpect(header().string("X-TTS-Voice", "en-US-BrianNeural"));
    }

    @Test
    void fallbackIsReportedInTheHeaders() throws Exception {
        when(ttsService.synthesize("Hello", "kokoro", "bm_george"))
                .thenReturn(new TtsResult(MP3, "azure", "en-US-BrianNeural", true));

        postJson("{\"text\":\"Hello\",\"provider\":\"kokoro\",\"voice\":\"bm_george\"}")
                .andExpect(status().isOk())
                .andExpect(header().string("X-TTS-Provider", "azure"))
                .andExpect(header().string("X-TTS-Voice", "en-US-BrianNeural"))
                .andExpect(header().string("X-TTS-Fallback", "true"));
    }

    @Test
    void blankProviderAndVoiceMeanDefault() throws Exception {
        when(ttsService.synthesize("Hello", null, null)).thenReturn(new TtsResult(MP3, "kokoro", "af_heart", false));

        postJson("{\"text\":\"Hello\",\"provider\":\"\",\"voice\":\" \"}").andExpect(status().isOk());
        verify(ttsService).synthesize("Hello", null, null);
    }

    @Test
    void malformedVoiceIdIsRejected() throws Exception {
        postJson("{\"text\":\"Hello\",\"voice\":\"<script>\"}")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("BAD_INPUT"));
        verifyNoInteractions(ttsService);
    }

    @Test
    void returns400OnEmptyText() throws Exception {
        postJson("{\"text\":\"\"}")
                .andExpect(status().isBadRequest())
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("BAD_INPUT"))
                .andExpect(jsonPath("$.provider").doesNotExist());
        verifyNoInteractions(ttsService);
    }

    @Test
    void returns400OnMissingText() throws Exception {
        postJson("{}").andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("BAD_INPUT"));
    }

    @Test
    void returns400OnTooLongText() throws Exception {
        String text = "a".repeat(TtsController.MAX_CHARS + 1);
        postJson("{\"text\":\"" + text + "\"}")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("BAD_INPUT"));
        verifyNoInteractions(ttsService);
    }

    @Test
    void returns400OnMalformedJson() throws Exception {
        postJson("{not json").andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("BAD_INPUT"));
    }

    @ParameterizedTest
    @CsvSource({
            "QUOTA, 503, azure",
            "UNAVAILABLE, 503, kokoro",
            "TIMEOUT, 504, kokoro",
            "UPSTREAM_ERROR, 502, azure",
            "BAD_INPUT, 400, kokoro"
    })
    void mapsServiceErrorsToStatusCodesWithTheProvider(Reason reason, int expectedStatus, String provider) throws Exception {
        doThrow(new TtsException(reason, "boom").withProvider(provider))
                .when(ttsService).synthesize(anyString(), any(), any());

        postJson("{\"text\":\"Hello\"}")
                .andExpect(status().is(expectedStatus))
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value(reason.name()))
                .andExpect(jsonPath("$.message").value("boom"))
                .andExpect(jsonPath("$.provider").value(provider));
    }

    @Test
    void voicesReturnsTheCatalog() throws Exception {
        when(ttsService.listVoices()).thenReturn(new VoiceCatalog("kokoro", List.of(
                new VoiceCatalog.ProviderVoices("kokoro", "Kokoro (local)", true, "af_heart",
                        List.of(new Voice("af_heart", "Heart (US, female)", "en-US", "female"))),
                new VoiceCatalog.ProviderVoices("azure", "Microsoft Azure", false, "en-US-BrianNeural", List.of()))));

        mvc.perform(get("/api/voices"))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.defaultProvider").value("kokoro"))
                .andExpect(jsonPath("$.providers[0].name").value("kokoro"))
                .andExpect(jsonPath("$.providers[0].displayName").value("Kokoro (local)"))
                .andExpect(jsonPath("$.providers[0].available").value(true))
                .andExpect(jsonPath("$.providers[0].defaultVoice").value("af_heart"))
                .andExpect(jsonPath("$.providers[0].voices[0].id").value("af_heart"))
                .andExpect(jsonPath("$.providers[0].voices[0].label").value("Heart (US, female)"))
                .andExpect(jsonPath("$.providers[0].voices[0].language").value("en-US"))
                .andExpect(jsonPath("$.providers[0].voices[0].gender").value("female"))
                .andExpect(jsonPath("$.providers[1].available").value(false))
                .andExpect(jsonPath("$.providers[1].voices").isEmpty());
    }

    @Test
    void allowsBrowserExtensionOriginsForPostAndGetAndExposesTheHeaders() throws Exception {
        for (String method : List.of("POST", "GET")) {
            mvc.perform(options("/api/tts")
                            .header("Origin", "chrome-extension://abcdefghijklmnop")
                            .header("Access-Control-Request-Method", method))
                    .andExpect(status().isOk())
                    .andExpect(header().string("Access-Control-Allow-Origin", "chrome-extension://abcdefghijklmnop"));
        }
        when(ttsService.synthesize("Hello", null, null)).thenReturn(new TtsResult(MP3, "kokoro", "af_heart", false));
        mvc.perform(post("/api/tts").header("Origin", "chrome-extension://abc")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"Hello\"}"))
                .andExpect(header().string("Access-Control-Expose-Headers", "X-TTS-Provider, X-TTS-Voice, X-TTS-Fallback"));
    }

    @Test
    void rejectsOtherOrigins() throws Exception {
        mvc.perform(options("/api/tts")
                        .header("Origin", "https://evil.example")
                        .header("Access-Control-Request-Method", "POST"))
                .andExpect(status().isForbidden());
    }
}
