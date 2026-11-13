package com.chapterly.controller;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.service.TtsResult;
import com.chapterly.service.TtsService;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** HTTP + input validation only; all TTS logic lives in {@link TtsService}. */
@RestController
@RequestMapping("/api")
public class TtsController {

    public static final int MAX_CHARS = 3000;
    public static final String PROVIDER_HEADER = "X-TTS-Provider";
    private static final MediaType AUDIO_MPEG = MediaType.parseMediaType("audio/mpeg");

    private final TtsService ttsService;

    public TtsController(TtsService ttsService) {
        this.ttsService = ttsService;
    }

    @PostMapping(path = "/tts", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<byte[]> tts(@RequestBody(required = false) TtsRequest request) throws TtsException {
        String text = request == null ? null : request.text();
        if (text == null || text.isBlank()) {
            throw new TtsException(Reason.BAD_INPUT, "text must not be empty");
        }
        if (text.length() > MAX_CHARS) {
            throw new TtsException(Reason.BAD_INPUT, "text must be at most " + MAX_CHARS + " characters");
        }

        TtsResult result = ttsService.synthesize(text);
        return ResponseEntity.ok()
                .contentType(AUDIO_MPEG)
                .header(PROVIDER_HEADER, result.provider())
                .body(result.audio());
    }
}
