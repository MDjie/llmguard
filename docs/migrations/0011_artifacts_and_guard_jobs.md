# Migration 0011: artifacts and guard jobs

Creates the shared asynchronous substrate for document, image, audio, video, RAG and tool-result
inspection. Sizes use `bigint` so the 3GB video limit is representable. Artifact parts and jobs
use composite tenant/application foreign keys, idempotency constraints and append-only job events.

Drain workers before rollback. Preserve job/event exports, delete object-store parts using the
recorded prefixes, then remove the tables in reverse dependency order.
