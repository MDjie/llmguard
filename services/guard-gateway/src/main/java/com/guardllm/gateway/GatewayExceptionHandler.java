package com.guardllm.gateway;

import java.util.Map;
import java.util.concurrent.TimeoutException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.reactive.function.client.WebClientException;

@RestControllerAdvice
final class GatewayExceptionHandler {
    @ExceptionHandler(ReactiveBulkhead.BulkheadFullException.class)
    ResponseEntity<Map<String, Object>> bulkhead() {
        return problem(HttpStatus.TOO_MANY_REQUESTS, "GATEWAY_BULKHEAD_FULL");
    }

    @ExceptionHandler(ReactiveBulkhead.DistributedBackendUnavailableException.class)
    ResponseEntity<Map<String, Object>> concurrencyBackend() {
        return problem(HttpStatus.SERVICE_UNAVAILABLE, "GATEWAY_CONCURRENCY_BACKEND_UNAVAILABLE");
    }

    @ExceptionHandler(GatewayRateLimiter.QuotaExceededException.class)
    ResponseEntity<Map<String, Object>> quota() {
        return problem(HttpStatus.TOO_MANY_REQUESTS, "GATEWAY_QUOTA_EXCEEDED");
    }

    @ExceptionHandler(GatewayRateLimiter.QuotaBackendUnavailableException.class)
    ResponseEntity<Map<String, Object>> quotaBackend() {
        return problem(HttpStatus.SERVICE_UNAVAILABLE, "GATEWAY_QUOTA_BACKEND_UNAVAILABLE");
    }

    @ExceptionHandler(GatewayRateLimiter.RequestCapacityExceededException.class)
    ResponseEntity<Map<String, Object>> requestCapacity() {
        return problem(HttpStatus.CONTENT_TOO_LARGE, "GATEWAY_REQUEST_CAPACITY_EXCEEDED");
    }

    @ExceptionHandler(TimeoutException.class)
    ResponseEntity<Map<String, Object>> timeout() {
        return problem(HttpStatus.GATEWAY_TIMEOUT, "GATEWAY_DEADLINE_EXCEEDED");
    }

    @ExceptionHandler(WebClientException.class)
    ResponseEntity<Map<String, Object>> upstream() {
        return problem(HttpStatus.BAD_GATEWAY, "GATEWAY_UPSTREAM_FAILED");
    }

    private static ResponseEntity<Map<String, Object>> problem(HttpStatus status, String code) {
        return ResponseEntity.status(status).body(Map.of(
                "type", "about:blank",
                "title", status.getReasonPhrase(),
                "status", status.value(),
                "code", code));
    }
}
