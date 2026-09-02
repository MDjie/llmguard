# Migration 0016: signed callback delivery

Adds bounded callback attempts, next-at scheduling and sanitized last-error metadata. Callback
payloads use HMAC over timestamp, nonce and exact body hash; `jobId` is the receiver idempotency
key. Five failed attempts are terminal and remain visible for operator replay.
