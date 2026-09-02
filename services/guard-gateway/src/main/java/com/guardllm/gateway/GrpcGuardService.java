package com.guardllm.gateway;

import io.grpc.Status;
import io.grpc.stub.ServerCallStreamObserver;
import io.grpc.stub.StreamObserver;
import io.guardllm.contracts.v1.proto.GuardRequest;
import io.guardllm.contracts.v1.proto.GuardServiceGrpc;
import java.time.Clock;
import java.util.ArrayDeque;
import java.util.Queue;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

@Component
final class GrpcGuardService extends GuardServiceGrpc.GuardServiceImplBase {
    private final GuardClient guardClient;
    private final RequestContextVerifier verifier;
    private final GatewayRateLimiter rateLimiter;
    private final GrpcDecisionMapper mapper = new GrpcDecisionMapper();
    private final int maxBufferedRequests;

    GrpcGuardService(GuardClient guardClient, GatewayRateLimiter rateLimiter,
            GuardGatewayProperties properties, GrpcServerProperties grpc) {
        this.guardClient = guardClient;
        this.rateLimiter = rateLimiter;
        this.verifier = new RequestContextVerifier(properties.contextHmacSecret(), Clock.systemUTC());
        this.maxBufferedRequests = grpc.maxBufferedRequests();
    }

    @Override
    public void evaluate(GuardRequest request, StreamObserver<io.guardllm.contracts.v1.proto.GuardDecision> response) {
        evaluateRequest(request).subscribe(
                value -> { response.onNext(value); response.onCompleted(); },
                error -> response.onError(toStatus(error).asRuntimeException()));
    }

    @Override
    public StreamObserver<GuardRequest> evaluateStream(
            StreamObserver<io.guardllm.contracts.v1.proto.GuardDecision> response) {
        return new SequentialRequestObserver(response);
    }

    private Mono<io.guardllm.contracts.v1.proto.GuardDecision> evaluateRequest(GuardRequest request) {
        try {
            if (!"1.0".equals(request.getContractVersion()) || !request.hasContext()
                    || !request.hasContent() || !request.getContent().hasText()) {
                return Mono.error(Status.INVALID_ARGUMENT.withDescription("A valid v1 text GuardRequest is required").asRuntimeException());
            }
            var source = request.getContext();
            var context = new GatewayRequestContext(
                    required(source.getTenantId()), required(source.getApplicationId()),
                    optional(GrpcContextAuthenticationInterceptor.PRINCIPAL_CONTEXT.get()),
                    optional(GrpcContextAuthenticationInterceptor.CREDENTIAL_CONTEXT.get()),
                    required(source.getRequestId()), required(source.getTraceId()),
                    source.hasSessionId() ? optional(source.getSessionId()) : null,
                    source.getAbsoluteDeadlineEpochMs());
            String signature = GrpcContextAuthenticationInterceptor.SIGNATURE_CONTEXT.get();
            String signatureVersion = GrpcContextAuthenticationInterceptor.VERSION_CONTEXT.get();
            if (!verifier.verify(context, signature, signatureVersion)) {
                return Mono.error(Status.UNAUTHENTICATED.withDescription("Trusted request context is invalid").asRuntimeException());
            }
            String direction = source.getDirection().name().replace("DIRECTION_", "");
            return rateLimiter.check(context, "guard.grpc." + direction.toLowerCase(),
                            request.getContent().getText().length())
                    .then(guardClient.evaluate(
                            request.getContent().getText(), direction, context,
                            required(source.getPolicyBundleId()), false))
                    .map(decision -> mapper.toProto(decision, context.traceId()));
        } catch (IllegalArgumentException error) {
            return Mono.error(Status.INVALID_ARGUMENT.withDescription("GuardRequest fields are invalid").asRuntimeException());
        }
    }

    private static String required(String value) {
        if (value == null || value.isBlank() || value.length() > 128) throw new IllegalArgumentException();
        return value;
    }

    private static String optional(String value) {
        if (value == null || value.isBlank()) return null;
        return required(value);
    }

    private static Status toStatus(Throwable error) {
        Status existing = Status.fromThrowable(error);
        if (existing.getCode() != Status.Code.UNKNOWN) return existing;
        if (error instanceof java.util.concurrent.TimeoutException) return Status.DEADLINE_EXCEEDED;
        if (error instanceof GatewayRateLimiter.QuotaExceededException) return Status.RESOURCE_EXHAUSTED;
        if (error instanceof GatewayRateLimiter.QuotaBackendUnavailableException) {
            return Status.UNAVAILABLE.withDescription("Gateway quota backend is unavailable");
        }
        return Status.UNAVAILABLE.withDescription("Guard evaluation is unavailable");
    }

    private final class SequentialRequestObserver implements StreamObserver<GuardRequest> {
        private final StreamObserver<io.guardllm.contracts.v1.proto.GuardDecision> response;
        private final Queue<GuardRequest> queue = new ArrayDeque<>();
        private boolean processing;
        private boolean inputCompleted;
        private boolean terminated;

        SequentialRequestObserver(StreamObserver<io.guardllm.contracts.v1.proto.GuardDecision> response) {
            this.response = response;
        }

        @Override
        public synchronized void onNext(GuardRequest value) {
            if (terminated) return;
            if (queue.size() >= maxBufferedRequests) {
                fail(Status.RESOURCE_EXHAUSTED.withDescription("gRPC guard stream buffer is full").asRuntimeException());
                return;
            }
            queue.add(value);
            drain();
        }

        @Override
        public synchronized void onError(Throwable error) {
            terminated = true;
            queue.clear();
        }

        @Override
        public synchronized void onCompleted() {
            inputCompleted = true;
            completeIfDone();
        }

        private synchronized void drain() {
            if (processing || terminated) return;
            GuardRequest next = queue.poll();
            if (next == null) {
                completeIfDone();
                return;
            }
            processing = true;
            evaluateRequest(next).subscribe(this::succeed, this::fail);
        }

        private synchronized void succeed(io.guardllm.contracts.v1.proto.GuardDecision decision) {
            if (terminated) return;
            if (response instanceof ServerCallStreamObserver<?> observer && observer.isCancelled()) {
                terminated = true;
                queue.clear();
                return;
            }
            response.onNext(decision);
            processing = false;
            drain();
        }

        private synchronized void fail(Throwable error) {
            if (terminated) return;
            terminated = true;
            queue.clear();
            response.onError(toStatus(error).asRuntimeException());
        }

        private synchronized void completeIfDone() {
            if (inputCompleted && !processing && queue.isEmpty() && !terminated) {
                terminated = true;
                response.onCompleted();
            }
        }
    }
}
