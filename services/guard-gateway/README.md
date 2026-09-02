# Guard Gateway

Java 21 / Spring Boot WebFlux data-plane gateway. It verifies a signed tenant/application
request context, selects active/canary policy deterministically, evaluates input and output,
enforces a non-blocking bulkhead and records shadow decision differences without logging content.

Build and test with `docker build -t guardllm/guard-gateway:dev .` from this directory. The
runtime image is non-root. Production east-west traffic must use mutual TLS. Kubernetes defaults
to transparent STRICT service-mesh mTLS. For direct mTLS, set `GATEWAY_MTLS_REQUIRED=true` and
mount PEM CA, client certificate and private key through the three `GATEWAY_*_CERTIFICATE/KEY`
settings. `X-Guard-Context-Signature` is lower-case hex HMAC-SHA256 over
`tenantId + "\\n" + applicationId + "\\n" + requestId + "\\n" + deadline`.

The synchronous route intentionally rejects `stream=true`; streaming is handled by the separate
commit-gate module so unsafe bytes cannot be emitted before an output decision.
