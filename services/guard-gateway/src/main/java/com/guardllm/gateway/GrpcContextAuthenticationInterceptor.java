package com.guardllm.gateway;

import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;

final class GrpcContextAuthenticationInterceptor implements ServerInterceptor {
    private static final Metadata.Key<String> SIGNATURE_HEADER =
            Metadata.Key.of("x-guard-context-signature", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> VERSION_HEADER =
            Metadata.Key.of("x-guard-context-version", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> PRINCIPAL_HEADER =
            Metadata.Key.of("x-principal-id", Metadata.ASCII_STRING_MARSHALLER);
    private static final Metadata.Key<String> CREDENTIAL_HEADER =
            Metadata.Key.of("x-credential-id", Metadata.ASCII_STRING_MARSHALLER);
    static final Context.Key<String> SIGNATURE_CONTEXT = Context.key("guard-context-signature");
    static final Context.Key<String> VERSION_CONTEXT = Context.key("guard-context-version");
    static final Context.Key<String> PRINCIPAL_CONTEXT = Context.key("guard-principal-id");
    static final Context.Key<String> CREDENTIAL_CONTEXT = Context.key("guard-credential-id");

    @Override
    public <RequestT, ResponseT> ServerCall.Listener<RequestT> interceptCall(
            ServerCall<RequestT, ResponseT> call,
            Metadata headers,
            ServerCallHandler<RequestT, ResponseT> next) {
        String signature = headers.get(SIGNATURE_HEADER);
        String version = headers.get(VERSION_HEADER);
        if (signature == null || signature.isBlank() || signature.length() > 128
                || (!"2".equals(version) && !"3".equals(version))) {
            call.close(Status.UNAUTHENTICATED.withDescription(
                    "Trusted context signature v2 or v3 is required"), new Metadata());
            return new ServerCall.Listener<>() { };
        }
        return Contexts.interceptCall(Context.current()
                .withValue(SIGNATURE_CONTEXT, signature)
                .withValue(VERSION_CONTEXT, version)
                .withValue(PRINCIPAL_CONTEXT, headers.get(PRINCIPAL_HEADER))
                .withValue(CREDENTIAL_CONTEXT, headers.get(CREDENTIAL_HEADER)),
                call, headers, next);
    }
}
