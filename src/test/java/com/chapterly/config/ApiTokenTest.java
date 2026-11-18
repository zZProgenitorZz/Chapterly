package com.chapterly.config;

import com.chapterly.controller.TtsController;
import com.chapterly.error.UnauthorizedException;
import com.chapterly.service.TtsService;
import com.chapterly.service.VoiceCatalog;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ApiTokenTest {

    private static final String ORIGIN = "chrome-extension://abcdefghijklmnop";
    private static final VoiceCatalog CATALOG = new VoiceCatalog("kokoro", List.of());

    // ---------- the interceptor on its own ----------

    private static ApiTokenConfig.TokenInterceptor interceptor(String token) {
        return new ApiTokenConfig.TokenInterceptor(ApiTokenConfig.sha256(token));
    }

    private static MockHttpServletRequest request(String method, String token) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, "/api/tts");
        if (token != null) {
            request.addHeader(ApiTokenConfig.TOKEN_HEADER, token);
        }
        return request;
    }

    @Test
    void rightTokenPasses() throws Exception {
        assertThat(interceptor("s3cret").preHandle(request("POST", "s3cret"), new MockHttpServletResponse(), null)).isTrue();
    }

    @Test
    void wrongOrMissingTokenIsUnauthorized() {
        var check = interceptor("s3cret");
        assertThatThrownBy(() -> check.preHandle(request("POST", "s3cret!"), new MockHttpServletResponse(), null))
                .isInstanceOf(UnauthorizedException.class).hasMessageContaining("Wrong");
        assertThatThrownBy(() -> check.preHandle(request("GET", "S3CRET"), new MockHttpServletResponse(), null))
                .isInstanceOf(UnauthorizedException.class);
        assertThatThrownBy(() -> check.preHandle(request("GET", null), new MockHttpServletResponse(), null))
                .isInstanceOf(UnauthorizedException.class).hasMessageContaining("Missing");
    }

    @Test
    void preflightIsExempt() throws Exception {
        assertThat(interceptor("s3cret").preHandle(request("OPTIONS", null), new MockHttpServletResponse(), null)).isTrue();
    }

    // ---------- wired into Spring MVC ----------

    /** No token configured: the API is open, as before. */
    @Nested
    @WebMvcTest(TtsController.class)
    class WithoutToken {
        @Autowired
        MockMvc mvc;
        @MockitoBean
        TtsService ttsService;

        @Test
        void requestsWithoutTheHeaderPass() throws Exception {
            when(ttsService.listVoices()).thenReturn(CATALOG);
            mvc.perform(get("/api/voices")).andExpect(status().isOk());
        }
    }

    @Nested
    @WebMvcTest(controllers = TtsController.class, properties = "chapterly.api-token=s3cret")
    class WithToken {
        @Autowired
        MockMvc mvc;
        @MockitoBean
        TtsService ttsService;

        @Test
        void missingTokenIs401WithJsonAndCorsHeaders() throws Exception {
            mvc.perform(get("/api/voices").header("Origin", ORIGIN))
                    .andExpect(status().isUnauthorized())
                    .andExpect(content().contentType("application/json"))
                    .andExpect(jsonPath("$.error").value("UNAUTHORIZED"))
                    // so the extension sees the 401 instead of a CORS failure
                    .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN));
            verifyNoInteractions(ttsService);
        }

        @Test
        void wrongTokenIs401AndNothingIsSynthesized() throws Exception {
            mvc.perform(post("/api/tts").header("X-Chapterly-Token", "guess")
                            .contentType("application/json").content("{\"text\":\"Hello\"}"))
                    .andExpect(status().isUnauthorized())
                    .andExpect(jsonPath("$.error").value("UNAUTHORIZED"));
            mvc.perform(delete("/api/tts/requests/abc").header("X-Chapterly-Token", "guess"))
                    .andExpect(status().isUnauthorized());
            verifyNoInteractions(ttsService);
        }

        @Test
        void rightTokenIsOk() throws Exception {
            when(ttsService.listVoices()).thenReturn(CATALOG);
            mvc.perform(get("/api/voices").header("X-Chapterly-Token", "s3cret"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.defaultProvider").value("kokoro"));
        }

        @Test
        void preflightPassesWithoutTokenAndAllowsTheHeader() throws Exception {
            mvc.perform(options("/api/tts")
                            .header("Origin", ORIGIN)
                            .header("Access-Control-Request-Method", "POST")
                            .header("Access-Control-Request-Headers", "content-type, x-chapterly-token"))
                    .andExpect(status().isOk())
                    .andExpect(header().string("Access-Control-Allow-Origin", ORIGIN))
                    .andExpect(header().string("Access-Control-Allow-Headers",
                            org.hamcrest.Matchers.containsStringIgnoringCase("x-chapterly-token")));
        }
    }
}
