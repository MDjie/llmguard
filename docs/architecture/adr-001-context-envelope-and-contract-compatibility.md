# ADR-001: Context envelope and Guard v1 compatibility

- Status: accepted
- Date: 2026-09-03
- Scope: UWP-01 / FIX-001 / FIX-004 / FIX-008

## Context

Guard v1 already defines the authoritative request, observation and decision objects. Introducing a
parallel SecurityDecision would create conflicting terminal actions and make replay ambiguous.
The existing contract did not identify the source, trust, instruction authority or policy version
of individual context ranges.

## Decision

Guard v1 remains the canonical protocol and receives additive optional fields. ContextEnvelope and
ActionIntent are new definitions; EvidenceRef is extended in place to carry RiskEvidence semantics.
The source schema remains packages/contracts/model/guard-v1.schema.json and generates TypeScript,
Java, Python, Go, OpenAPI and protobuf artifacts.

Context envelopes use UTF-16 character offsets because current TypeScript detector evidence uses
JavaScript string offsets. Envelopes supplied by a caller must form an exact, non-overlapping
partition of text. Each range is bound to tenant, application, optional session, SHA-256 content
hash, source type, trust, instruction capability, policy version and sequence number.

Legacy requests without envelopes receive one deterministic compatibility envelope. The profile is
conservative: RAG, tool, memory, file and media sources cannot grant instruction authority. A
caller that explicitly supplies envelopes receives strict validation; invalid scope, expiry, hash,
range, duplicate identity or capability escalation fails before detector execution.

Token ranges are optional and are valid only with a tokenizer identifier. They will become
mandatory for long-context acceptance after the target tokenizer and digest are frozen in UWP-03.

External Agent and harness events retain optional signature fields for wire compatibility, but the
external verification boundary requires sequence, expiry, key id and signature. Verification order
is schema, authenticated scope, nested payload scope, lifetime, key, constant-time signature and
atomic replay claim.

## Consequences

- Existing clients continue to parse and send Guard v1 messages.
- New consumers can explain every text evidence item through sourceEnvelopeIds.
- Adding an event payload branch is treated as backward compatible; removing an existing branch is
  rejected by the compatibility gate.
- Production event consumers must provide a tenant-aware key registry and an atomic shared replay
  store. The in-memory store is suitable only for unit tests and single-process development.

## Rollback

Stop sending new optional fields and roll back runtime use of ContextEnvelope. Do not delete the
additive schema fields or reuse protobuf field numbers. The accepted Guard v1 baseline remains the
compatibility floor.
