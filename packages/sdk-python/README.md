# GuardLLM Python SDK

The Python SDK uses only the standard library. It supports trusted context v3,
OpenAI-compatible synchronous/SSE chat, direct Guard v1 evaluation and optional
client certificate authentication. Context HMAC and API keys are server-side
credentials and must never be distributed to browsers.

Set `credential_id` when constructing the client and pass `principal_id` to
`chat`/`chat_stream` when user-level quotas are required. Both values are
covered by the context HMAC.
