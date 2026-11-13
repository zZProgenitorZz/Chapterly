package com.chapterly.error;

/** JSON error body returned for every failed request. */
public record ErrorResponse(String error, String message) {
}
