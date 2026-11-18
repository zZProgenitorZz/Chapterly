package com.chapterly.error;

/** Missing or wrong X-Chapterly-Token while chapterly.api-token is set: HTTP 401. */
public class UnauthorizedException extends Exception {

    public UnauthorizedException(String message) {
        super(message);
    }
}
