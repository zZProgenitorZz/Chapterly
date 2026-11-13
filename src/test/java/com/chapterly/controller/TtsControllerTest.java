package com.chapterly.controller;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.service.TtsResult;
import com.chapterly.service.TtsService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(TtsController.class)
class TtsControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private TtsService ttsService;

    @Test
    void returnsMp3WithProviderHeader() throws Exception {
        byte[] mp3 = {0x49, 0x44, 0x33};
        when(ttsService.synthesize("Hello")).thenReturn(new TtsResult(mp3, "azure"));

        mvc.perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"Hello\"}"))
                .andExpect(status().isOk())
                .andExpect(content().contentType("audio/mpeg"))
                .andExpect(header().string("X-TTS-Provider", "azure"))
                .andExpect(content().bytes(mp3));
    }

    @Test
    void returns400OnEmptyText() throws Exception {
        mvc.perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("BAD_INPUT"));
        verifyNoInteractions(ttsService);
    }

    @Test
    void returns400OnMissingText() throws Exception {
        mvc.perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("BAD_INPUT"));
    }

    @Test
    void returns400OnTooLongText() throws Exception {
        String text = "a".repeat(TtsController.MAX_CHARS + 1);
        mvc.perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"" + text + "\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("BAD_INPUT"));
        verifyNoInteractions(ttsService);
    }

    @Test
    void returns400OnMalformedJson() throws Exception {
        mvc.perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("BAD_INPUT"));
    }

    @ParameterizedTest
    @CsvSource({"QUOTA, 503", "TIMEOUT, 504", "UPSTREAM_ERROR, 502", "BAD_INPUT, 400"})
    void mapsServiceErrorsToStatusCodes(Reason reason, int expectedStatus) throws Exception {
        doThrow(new TtsException(reason, "boom")).when(ttsService).synthesize(anyString());

        mvc.perform(post("/api/tts").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"Hello\"}"))
                .andExpect(status().is(expectedStatus))
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value(reason.name()))
                .andExpect(jsonPath("$.message").value("boom"));
    }

    @Test
    void allowsBrowserExtensionOrigins() throws Exception {
        mvc.perform(options("/api/tts")
                        .header("Origin", "chrome-extension://abcdefghijklmnop")
                        .header("Access-Control-Request-Method", "POST"))
                .andExpect(status().isOk())
                .andExpect(header().string("Access-Control-Allow-Origin", "chrome-extension://abcdefghijklmnop"));
    }

    @Test
    void rejectsOtherOrigins() throws Exception {
        mvc.perform(options("/api/tts")
                        .header("Origin", "https://evil.example")
                        .header("Access-Control-Request-Method", "POST"))
                .andExpect(status().isForbidden());
    }
}
