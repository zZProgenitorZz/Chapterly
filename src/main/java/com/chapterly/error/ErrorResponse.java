package com.chapterly.error;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * JSON error body returned for every failed request. {@code provider} names the
 * provider that produced the final error ("kokoro", "azure"); omitted when not
 * provider-specific (e.g. input validation).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ErrorResponse(String error, String message, String provider) {

    public ErrorResponse(String error, String message) {
        this(error, message, null);
    }
}
