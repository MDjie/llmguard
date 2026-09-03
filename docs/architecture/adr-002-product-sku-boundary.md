# ADR-002: Product SKU boundary

- Status: accepted for implementation; commercial approval pending
- Date: 2026-09-03
- Scope: UWP-00 / FIX-000

## Context

The implementation combines an AI application gateway, guard runtime, RAG controls, Agent action
controls and evidence services. It does not currently contain a complete transparent network
security data plane. Treating those two products as one release would make performance,
certification and failure-mode claims unverifiable.

## Decision

Version A, the software guard gateway, is the default implementation target. Its scope is recorded
in acceptance/integrated-plan/scope-manifest.json.

Version B, the full appliance, is a separate optional SKU. It remains BLOCKED_EXTERNAL until the
commercial scope, hardware bill of materials, target network, regulatory scope and data-plane
technology are approved. Version A documentation and acceptance must not claim Version B
transparent forwarding, general IPS, antivirus, volumetric DDoS or appliance certification.

Source-controlled development versions are not target-environment certification. The target model,
tokenizer, accelerator, OS, database, middleware, endpoints and KMS/HSM must be frozen separately
and accompanied by immutable evidence.

## Consequences

- Software security work can proceed without inventing appliance evidence.
- Claims for 99 percent effectiveness, 128K coverage, millisecond latency and domestic-platform
  compatibility stay unapproved until their named external evidence exists.
- Third-party candidates remain evaluation-only and cannot enter an environment until pinned,
  hashed, licensed, reviewed, owned and reversible.

## Rollback

If Version A is not the approved product target, pause implementation after source-compatible
changes and obtain a new SKU decision. Version B work cannot be enabled by changing a feature flag;
it requires its own architecture, threat model, acceptance environment and rollback owner.
