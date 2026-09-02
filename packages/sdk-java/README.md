# GuardLLM Java SDK

The Java 21 SDK uses `java.net.http.HttpClient`. Applications should inject an
`HttpClient` configured with the enterprise trust store and client certificate.
The SDK signs context v3 and prepares synchronous, SSE and direct Guard requests.
JSON serialization remains under the application's existing JSON library.

Use the constructor overload with `credentialId` and the `newContext` overload
with `principalId` to enable signed credential and user quotas. Existing
constructors remain source compatible and emit v3 with empty identity fields.
