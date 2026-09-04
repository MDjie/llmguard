# ADR-004: Version B Network Data-Plane Selection

- Status: proposed; target POC and commercial approval pending
- Date: 2026-09-04
- Scope: B-WP01 / UWP-12

## Context

Version B requires transparent forwarding, protocol framing, TLS interception, ACL, IPS,
antivirus, DoS controls, reinjection, high availability and hardware integration. The current
application repository provides the AI guard and management foundation but does not provide a
general-purpose TCP stack, packet-forwarding engine, IPS, antivirus engine or hardware bypass
driver.

Implementing every network-security primitive from scratch would make the 28-week objective,
line-rate performance, protocol safety, licensing and long-term maintenance unverifiable.

## Proposed Decision

Adopt a hybrid, replaceable architecture:

1. Use an approved OEM or mature user-space forwarding engine for the primary L2-L4 data plane.
2. Use eBPF/XDP only for bounded pre-filtering, DoS controls and telemetry where the target OS and
   NIC combination has signed evidence.
3. Use a mature L7 proxy/protocol framework for TCP, TLS and application-message boundaries.
4. Integrate approved IPS and antivirus engines through a GuardLLM-owned adapter contract.
5. Retain GuardLLM ownership of appliance contracts, policy signing, capability admission,
   failure policy, AI decisions, enforcement receipts, evidence and rollback.

No named supplier is selected by this ADR. A final amendment requires target-hardware POC results,
license approval, CVE and supply-chain review, a maintenance owner and a tested removal path.

## Mandatory Candidate Gates

- Transparent L2 operation and deterministic reinjection on the target NIC.
- Structured flow, frame, finding, health, rule-version and enforcement evidence.
- Explicit backpressure, timeout and failure semantics; no hidden fail-open path.
- Signed rule/configuration update with atomic activation and rollback.
- x86_64 and required ARM64/domestic-platform support with immutable driver and firmware identity.
- PCAP replay, malformed-protocol, flood, line-rate, 72-hour and failover testability.
- Commercial redistribution rights, security-fix SLA and acceptable end-of-life terms.

## Consequences

- The online packet path is isolated from Next.js and mutable control-plane databases.
- Network engines can be replaced without changing Guard v1 or the AI policy model.
- Appliance claims remain blocked until a final selection and target evidence exist.
- The team must maintain the appliance-v1 adapter conformance kit as a product component.

## Rollback

If no candidate passes all mandatory gates, deliver only the B0 reverse-proxy appliance milestone.
Do not relabel a reverse proxy, TAP sensor or API limiter as the Version B full network data plane.
