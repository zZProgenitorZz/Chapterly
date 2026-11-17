package com.chapterly.error;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/** Turns every failure into a JSON {@link ErrorResponse} with the right status code. */
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(TtsException.class)
    public ResponseEntity<ErrorResponse> handleTts(TtsException e) {
        HttpStatus status = switch (e.getReason()) {
            case BAD_INPUT -> HttpStatus.BAD_REQUEST;
            case QUOTA, UNAVAILABLE -> HttpStatus.SERVICE_UNAVAILABLE;
            case TIMEOUT -> HttpStatus.GATEWAY_TIMEOUT;
            case UPSTREAM_ERROR -> HttpStatus.BAD_GATEWAY;
        };
        return body(status, new ErrorResponse(e.getReason().name(), e.getMessage(), e.getProvider()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorResponse> handleUnreadable(HttpMessageNotReadableException e) {
        return body(HttpStatus.BAD_REQUEST, new ErrorResponse(TtsException.Reason.BAD_INPUT.name(),
                "Request body must be JSON like {\"text\": \"...\"}"));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ErrorResponse> handleMediaType(HttpMediaTypeNotSupportedException e) {
        return body(HttpStatus.UNSUPPORTED_MEDIA_TYPE, new ErrorResponse(TtsException.Reason.BAD_INPUT.name(),
                "Content-Type must be application/json"));
    }

    private static ResponseEntity<ErrorResponse> body(HttpStatus status, ErrorResponse error) {
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .body(error);
    }
}
