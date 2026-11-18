package com.chapterly.controller;

import com.chapterly.error.TtsException;
import com.chapterly.error.TtsException.Reason;
import com.chapterly.service.TtsQueue.Priority;
import com.chapterly.service.TtsRequestOptions;
import com.chapterly.service.TtsResult;
import com.chapterly.service.TtsService;
import com.chapterly.service.VoiceCatalog;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.UUID;
import java.util.regex.Pattern;

/**
 * HTTP + input validation only; all TTS logic lives in {@link TtsService}.
 *
 * <p>POST /api/tts is asynchronous: the request is validated on the Tomcat thread, then
 * synthesized on a virtual thread (which may wait in the Kokoro queue), so Tomcat threads are
 * never blocked by a slow engine. If the async request times out or fails (e.g. the client went
 * away), a request that is still queued is dropped.
 */
@RestController
@RequestMapping("/api")
public class TtsController {

    public static final int MAX_CHARS = 3000;
    public static final String PROVIDER_HEADER = "X-TTS-Provider";
    public static final String VOICE_HEADER = "X-TTS-Voice";
    public static final String FALLBACK_HEADER = "X-TTS-Fallback";
    public static final String REQUEST_ID_HEADER = "X-Chapterly-Request-Id";
    public static final String PRIORITY_HEADER = "X-Chapterly-Priority";
    /** Above the slowest path: Kokoro (30 s) plus an Azure fallback (8 s) plus some queueing. */
    static final long ASYNC_TIMEOUT_MS = 90_000;
    private static final MediaType AUDIO_MPEG = MediaType.parseMediaType("audio/mpeg");
    /** Cheap sanity check; providers validate the actual ids. */
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_.-]{1,64}$");
    /** Request ids from the extension are UUIDs; anything id-like is accepted. */
    private static final Pattern REQUEST_ID = Pattern.compile("^[A-Za-z0-9-]{1,64}$");

    private final TtsService ttsService;

    public TtsController(TtsService ttsService) {
        this.ttsService = ttsService;
    }

    /**
     * Optional headers: {@code X-Chapterly-Request-Id} (makes the request cancellable) and
     * {@code X-Chapterly-Priority: now|prefetch}. Without them the request is "now" and can't be
     * cancelled, so plain curl calls keep working.
     */
    @PostMapping(path = "/tts", consumes = MediaType.APPLICATION_JSON_VALUE)
    public DeferredResult<ResponseEntity<byte[]>> tts(
            @RequestBody(required = false) TtsRequest request,
            @RequestHeader(name = REQUEST_ID_HEADER, required = false) String requestIdHeader,
            @RequestHeader(name = PRIORITY_HEADER, required = false) String priorityHeader) throws TtsException {
        String text = request == null ? null : request.text();
        if (text == null || text.isBlank()) {
            throw new TtsException(Reason.BAD_INPUT, "text must not be empty");
        }
        if (text.length() > MAX_CHARS) {
            throw new TtsException(Reason.BAD_INPUT, "text must be at most " + MAX_CHARS + " characters");
        }
        String provider = optionalId(request.provider(), "provider");
        String voice = optionalId(request.voice(), "voice");
        String requestId = optionalRequestId(requestIdHeader);
        Priority priority = Priority.parse(priorityHeader);
        // Without a client id the job still needs one, so a timeout can drop it from the queue.
        String jobId = requestId != null ? requestId : "anon-" + UUID.randomUUID();
        TtsRequestOptions options = new TtsRequestOptions(jobId, priority);

        DeferredResult<ResponseEntity<byte[]>> deferred = new DeferredResult<>(ASYNC_TIMEOUT_MS);
        deferred.onTimeout(() -> {
            ttsService.cancel(jobId);
            deferred.setErrorResult(new TtsException(Reason.TIMEOUT, "No audio within " + ASYNC_TIMEOUT_MS / 1000 + " s"));
        });
        deferred.onError(e -> ttsService.cancel(jobId));

        Thread.ofVirtual().name("tts-" + jobId).start(() -> {
            try {
                TtsResult result = ttsService.synthesize(text, provider, voice, options);
                deferred.setResult(ResponseEntity.ok()
                        .contentType(AUDIO_MPEG)
                        .header(PROVIDER_HEADER, result.provider())
                        .header(VOICE_HEADER, result.voice())
                        .header(FALLBACK_HEADER, String.valueOf(result.fallback()))
                        .body(result.audio()));
            } catch (Exception e) {
                deferred.setErrorResult(e); // TtsException, CancellationException, ... -> GlobalExceptionHandler
            }
        });
        return deferred;
    }

    /**
     * Cancels a request that is still waiting in the queue. Always 204: an unknown id, or one
     * that already started or finished, is not an error (a started request runs to its end).
     */
    @DeleteMapping("/tts/requests/{id}")
    public ResponseEntity<Void> cancel(@PathVariable String id) {
        if (REQUEST_ID.matcher(id).matches()) {
            ttsService.cancel(id);
        }
        return ResponseEntity.noContent().build();
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

    private static String optionalRequestId(String value) throws TtsException {
        if (value == null || value.isBlank()) {
            return null;
        }
        String v = value.strip();
        if (!REQUEST_ID.matcher(v).matches()) {
            throw new TtsException(Reason.BAD_INPUT, "Invalid " + REQUEST_ID_HEADER);
        }
        return v;
    }
}
