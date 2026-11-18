package com.chapterly.config;

import com.chapterly.error.UnauthorizedException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Optional shared token. When {@code chapterly.api-token} (env CHAPTERLY_API_TOKEN) is set,
 * every /api/** request must send it in {@code X-Chapterly-Token}, else 401 UNAUTHORIZED.
 * Without a token the API stays open, as before (fine while it is bound to 127.0.0.1).
 *
 * <p>An interceptor rather than a servlet filter: Spring's CORS handling runs first, so a
 * 401 still carries the CORS headers and the extension can show "wrong token" instead of
 * "backend not reachable". CORS preflights (OPTIONS) never carry custom headers and are
 * exempt.
 */
@Configuration
public class ApiTokenConfig implements WebMvcConfigurer {

    public static final String TOKEN_HEADER = "X-Chapterly-Token";

    private final byte[] expectedHash;

    public ApiTokenConfig(@Value("${chapterly.api-token:}") String token) {
        this.expectedHash = token == null || token.isBlank() ? null : sha256(token.strip());
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        if (expectedHash != null) {
            registry.addInterceptor(new TokenInterceptor(expectedHash)).addPathPatterns("/api/**");
        }
    }

    /** Package-private for tests. */
    static final class TokenInterceptor implements HandlerInterceptor {
        private final byte[] expectedHash;

        TokenInterceptor(byte[] expectedHash) {
            this.expectedHash = expectedHash;
        }

        @Override
        public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
                throws UnauthorizedException {
            if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
                return true;
            }
            String sent = request.getHeader(TOKEN_HEADER);
            if (sent == null || sent.isBlank()) {
                throw new UnauthorizedException("Missing " + TOKEN_HEADER + " header");
            }
            // Compare hashes in constant time: neither the content nor the length leaks.
            if (!MessageDigest.isEqual(expectedHash, sha256(sent.strip()))) {
                throw new UnauthorizedException("Wrong " + TOKEN_HEADER);
            }
            return true;
        }
    }

    static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
