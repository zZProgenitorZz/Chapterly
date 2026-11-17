package com.chapterly.controller;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.service.TtsResult;
import com.chapterly.service.TtsService;
import com.chapterly.service.VoiceCatalog;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.regex.Pattern;

/** HTTP + input validation only; all TTS logic lives in {@link TtsService}. */
@RestController
@RequestMapping("/api")
public class TtsController {

    public static final int MAX_CHARS = 3000;
    public static final String PROVIDER_HEADER = "X-TTS-Provider";
    public static final String VOICE_HEADER = "X-TTS-Voice";
    public static final String FALLBACK_HEADER = "X-TTS-Fallback";
    private static final MediaType AUDIO_MPEG = MediaType.parseMediaType("audio/mpeg");
    /** Cheap sanity check; providers validate the actual ids. */
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_.-]{1,64}$");

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
        String provider = optionalId(request.provider(), "provider");
        String voice = optionalId(request.voice(), "voice");

        TtsResult result = ttsService.synthesize(text, provider, voice);
        return ResponseEntity.ok()
                .contentType(AUDIO_MPEG)
                .header(PROVIDER_HEADER, result.provider())
                .header(VOICE_HEADER, result.voice())
                .header(FALLBACK_HEADER, String.valueOf(result.fallback()))
                .body(result.audio());
    }

    @GetMapping(path = "/voices", produces = MediaType.APPLICATION_JSON_VALUE)
    public VoiceCatalog voices() {
        return ttsService.listVoices();
    }

    private static String optionalId(String value, String field) throws TtsException {
        if (value == null || value.isBlank()) {
            return null;
        }
        String v = value.strip();
        if (!ID.matcher(v).matches()) {
            throw new TtsException(Reason.BAD_INPUT, "Invalid " + field);
        }
        return v;
    }
}
