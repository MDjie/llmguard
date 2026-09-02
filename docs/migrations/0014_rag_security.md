# Migration 0014: five-stage RAG security

Adds governed sources, signed chunk provenance and retrieval audit records. Source URI values are
stored as hashes; raw content remains in retained artifacts. Every retrieval candidate must match
tenant/application, ACL, classification, accepted state, content hash and provenance signature.
