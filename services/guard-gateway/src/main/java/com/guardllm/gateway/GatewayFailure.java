package com.guardllm.gateway;

final class GatewayFailure extends RuntimeException {
    private final String code;
    private final int status;
    GatewayFailure(String code, int status) { super(code); this.code = code; this.status = status; }
    String code() { return code; }
    int status() { return status; }
}
