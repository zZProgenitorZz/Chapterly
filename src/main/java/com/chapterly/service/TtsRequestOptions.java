package com.chapterly.service;

import com.chapterly.service.TtsQueue.Priority;

/**
 * Scheduling details of one request.
 *
 * @param requestId id the client can cancel the request with (DELETE /api/tts/requests/{id}), or null
 * @param priority  NOW for the chunk a listener is waiting for, PREFETCH for audio needed later
 */
public record TtsRequestOptions(String requestId, Priority priority) {

    public static final TtsRequestOptions DEFAULT = new TtsRequestOptions(null, Priority.NOW);

    public TtsRequestOptions {
        priority = priority == null ? Priority.NOW : priority;
    }
}
