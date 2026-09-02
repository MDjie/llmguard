# Migration 0009: asynchronous evaluation

This migration adds durable idempotent evaluation runs, immutable dataset/request hashes,
retry history, detailed metrics, policy-bundle binding and tenant/application composite
foreign keys. Existing runs remain readable; only newly submitted runs require a signed
`bundle_id` at the API layer.

Apply `0008` first. The migration is additive and can be re-run safely. Rollback is a
forward migration that first drains workers, preserves result exports, removes the new
constraints/indexes and only then drops columns.
