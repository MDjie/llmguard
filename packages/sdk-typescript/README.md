# GuardLLM TypeScript SDK

This server-side SDK signs trusted gateway context using the v3 format
and supports synchronous OpenAI-compatible chat, SSE chat and direct Guard v1
evaluation. Never bundle `contextHmacSecret` or `guardApiKey` into browser code.

The SDK validates tenant/application scope, bounds deadlines to 60 seconds and
propagates request, trace and optional session identifiers. Configure
`credentialId` on the client and pass `principalId` per call to enable signed,
cluster-wide credential and user quotas. The gateway accepts legacy v2 only
when these identity fields are absent.
