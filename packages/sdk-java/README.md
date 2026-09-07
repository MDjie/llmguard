# GuardLLM Java SDK

The Java 21 SDK uses `java.net.http.HttpClient`. Applications should inject an
`HttpClient` configured with the enterprise trust store and client certificate.
The SDK signs context v3 and prepares synchronous, SSE and direct Guard requests.
JSON serialization remains under the application's existing JSON library.

Use the constructor overload with `credentialId` and the `newContext` overload
with `principalId` to enable signed credential and user quotas. Existing
constructors remain source compatible and emit v3 with empty identity fields.


## Gateway V2 迁移

聊天调用现在同时携带应用 API Key、X-Guard-Deadline 和业务 Idempotency-Key。连接 V2 代理须配置有效应用凭据与可信客户端 TLS 证书；旧 context HMAC / tenant / principal 头仅保留兼容旧服务，V2 不根据这些调用方声明授予用户权限。V2 以应用凭据查得的作用域或控制台签名用户身份为准。已有检测 v1 方法保持原契约。

相同 requestId 用于同一次业务重试；发生 409 或执行状态未知时查询原请求，不生成新的 requestId 自动重放。流式完成不代表真实语义质量或客户端已完整收到，实际能力与状态以执行记录为准。
