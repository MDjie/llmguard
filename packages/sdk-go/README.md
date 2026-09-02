# GuardLLM Go SDK

The Go SDK uses only the standard library at runtime. It supports synchronous
OpenAI-compatible chat, guarded SSE streaming, direct Guard evaluation, signed
trusted request context, HTTPS and optional mutual TLS.

Run tests from this directory with:

    go test ./...

Production endpoints must use HTTPS. Configure both client certificate and
private key when mutual TLS is required. Request deadlines are capped at 60
seconds and are included in the HMAC-signed v3 context. Set
`Config.CredentialID` and `ChatOptions.PrincipalID` to enable signed,
cluster-wide credential and user quotas.
