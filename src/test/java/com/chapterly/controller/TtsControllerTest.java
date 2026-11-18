package com.chapterly.controller;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.provider.Voice;
import com.chapterly.service.TtsQueue.Priority;
import com.chapterly.service.TtsRequestOptions;
import com.chapterly.service.TtsResult;
import com.chapterly.service.TtsService;
import com.chapterly.service.VoiceCatalog;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.ResultHandler;
import org.springframework.test.web.servlet.ResultMatcher;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.util.List;
import java.util.concurrent.CancellationException;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
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

    private ResultActions postJson(String json) throws Exception {
        return perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content(json));
    }

    /** Performs the request and, if it went async (POST /api/tts), the async dispatch too. */
    private ResultActions perform(MockHttpServletRequestBuilder builder) throws Exception {
        MvcResult first = mvc.perform(builder).andReturn();
        if (!first.getRequest().isAsyncStarted()) {
            return actions(first);
        }
        first.getAsyncResult(5_000); // wait for the virtual thread
        return mvc.perform(asyncDispatch(first));
    }

    private static ResultActions actions(MvcResult result) {
        return new ResultActions() {
            @Override
            public ResultActions andExpect(ResultMatcher matcher) throws Exception {
                matcher.match(result);
                return this;
            }

            @Override
            public ResultActions andDo(ResultHandler handler) throws Exception {
                handler.handle(result);
                return this;
            }

            @Override
            public MvcResult andReturn() {
                return result;
            }
        };
    }

    @Test
    void textOnlyBodyStillWorks() throws Exception {
        when(ttsService.synthesize(eq("Hello"), isNull(), isNull(), any())).thenReturn(new TtsResult(MP3, "kokoro", "af_heart", false));

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
        when(ttsService.synthesize(eq("Hello"), eq("azure"), eq("en-US-BrianNeural"), any()))
                .thenReturn(new TtsResult(MP3, "azure", "en-US-BrianNeural", false));

        postJson("{\"text\":\"Hello\",\"provider\":\"azure\",\"voice\":\"en-US-BrianNeural\"}")
                .andExpect(status().isOk())
                .andExpect(header().string("X-TTS-Provider", "azure"))
                .andExpect(header().string("X-TTS-Voice", "en-US-BrianNeural"));
    }

    @Test
    void fallbackIsReportedInTheHeaders() throws Exception {
        when(ttsService.synthesize(eq("Hello"), eq("kokoro"), eq("bm_george"), any()))
                .thenReturn(new TtsResult(MP3, "azure", "en-US-BrianNeural", true));

        postJson("{\"text\":\"Hello\",\"provider\":\"kokoro\",\"voice\":\"bm_george\"}")
                .andExpect(status().isOk())
                .andExpect(header().string("X-TTS-Provider", "azure"))
                .andExpect(header().string("X-TTS-Voice", "en-US-BrianNeural"))
                .andExpect(header().string("X-TTS-Fallback", "true"));
    }

    @Test
    void blankProviderAndVoiceMeanDefault() throws Exception {
        when(ttsService.synthesize(eq("Hello"), isNull(), isNull(), any())).thenReturn(new TtsResult(MP3, "kokoro", "af_heart", false));

        postJson("{\"text\":\"Hello\",\"provider\":\"\",\"voice\":\" \"}").andExpect(status().isOk());
        verify(ttsService).synthesize(eq("Hello"), isNull(), isNull(), any());
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
                .when(ttsService).synthesize(anyString(), any(), any(), any());

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
        when(ttsService.synthesize(eq("Hello"), isNull(), isNull(), any())).thenReturn(new TtsResult(MP3, "kokoro", "af_heart", false));
        perform(post("/api/tts").header("Origin", "chrome-extension://abc")
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

    // ---------- queue headers, cancel endpoint ----------

    @Test
    void requestIdAndPriorityHeadersArePassedToTheService() throws Exception {
        when(ttsService.synthesize(eq("Hello"), isNull(), isNull(), any())).thenReturn(new TtsResult(MP3, "kokoro", "af_heart", false));

        perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"Hello\"}")
                .header("X-Chapterly-Request-Id", "3f1c2a9e-0b7d-4c55-9f00-1a2b3c4d5e6f")
                .header("X-Chapterly-Priority", "prefetch"))
                .andExpect(status().isOk());

        verify(ttsService).synthesize(eq("Hello"), isNull(), isNull(),
                eq(new TtsRequestOptions("3f1c2a9e-0b7d-4c55-9f00-1a2b3c4d5e6f", Priority.PREFETCH)));
    }

    @Test
    void withoutHeadersTheRequestIsNowWithAnInternalId() throws Exception {
        when(ttsService.synthesize(eq("Hello"), isNull(), isNull(), any())).thenReturn(new TtsResult(MP3, "kokoro", "af_heart", false));

        postJson("{\"text\":\"Hello\"}").andExpect(status().isOk());

        ArgumentCaptor<TtsRequestOptions> options = ArgumentCaptor.forClass(TtsRequestOptions.class);
        verify(ttsService).synthesize(eq("Hello"), isNull(), isNull(), options.capture());
        assertThat(options.getValue().priority()).isEqualTo(Priority.NOW);
        assertThat(options.getValue().requestId()).startsWith("anon-");
    }

    @Test
    void invalidPriorityOrRequestIdIsBadInput() throws Exception {
        perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"Hello\"}")
                .header("X-Chapterly-Priority", "urgent"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("BAD_INPUT"));
        perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"Hello\"}")
                .header("X-Chapterly-Request-Id", "not an id!"))
                .andExpect(status().isBadRequest());
        verifyNoInteractions(ttsService);
    }

    @Test
    void aRequestCancelledWhileQueuedEndsWith409Cancelled() throws Exception {
        doThrow(new CancellationException()).when(ttsService).synthesize(anyString(), any(), any(), any());

        postJson("{\"text\":\"Hello\"}")
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("CANCELLED"));
    }

    @Test
    void deleteCancelsAQueuedRequestAndIsAlways204() throws Exception {
        when(ttsService.cancel("abc-1")).thenReturn(true);
        mvc.perform(delete("/api/tts/requests/abc-1")).andExpect(status().isNoContent());
        verify(ttsService).cancel("abc-1");

        // Unknown (or already running) id: still 204.
        when(ttsService.cancel("unknown")).thenReturn(false);
        mvc.perform(delete("/api/tts/requests/unknown")).andExpect(status().isNoContent());

        // Malformed id: 204 without asking the service.
        mvc.perform(delete("/api/tts/requests/a_b")).andExpect(status().isNoContent());
        verify(ttsService, never()).cancel("a_b");
    }

    @Test
    void corsAllowsDeleteAndTheQueueHeaders() throws Exception {
        mvc.perform(options("/api/tts/requests/abc")
                        .header("Origin", "chrome-extension://abcdefghijklmnop")
                        .header("Access-Control-Request-Method", "DELETE"))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", "chrome-extension://abcdefghijklmnop"));
        mvc.perform(options("/api/tts")
                        .header("Origin", "chrome-extension://abcdefghijklmnop")
                        .header("Access-Control-Request-Method", "POST")
                        .header("Access-Control-Request-Headers", "content-type, x-chapterly-request-id, x-chapterly-priority"))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Headers",
                        org.hamcrest.Matchers.containsStringIgnoringCase("x-chapterly-priority")));
    }
}
