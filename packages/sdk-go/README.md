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


## Gateway V2 迁移

聊天调用现在同时携带应用 API Key、X-Guard-Deadline 和业务 Idempotency-Key。连接 V2 代理须配置有效应用凭据与可信客户端 TLS 证书；旧 context HMAC / tenant / principal 头仅保留兼容旧服务，V2 不根据这些调用方声明授予用户权限。V2 以应用凭据查得的作用域或控制台签名用户身份为准。已有检测 v1 方法保持原契约。

相同 requestId 用于同一次业务重试；发生 409 或执行状态未知时查询原请求，不生成新的 requestId 自动重放。流式完成不代表真实语义质量或客户端已完整收到，实际能力与状态以执行记录为准。
