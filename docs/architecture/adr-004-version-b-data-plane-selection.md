# ADR-004: Version B Network Data-Plane Selection

- Status: accepted for the B0 software-baseline boundary; full Version B data-plane
  selection, target POC and commercial approval remain pending
- Date: 2026-09-04
- Scope: B-WP01 / UWP-12

## Current Release Boundary

The current release name authorized by this record is **GuardLLM B0 Software Baseline**.
B0 provides signed appliance contracts, capability and policy-bundle validation, local policy
prepare/activate/rollback control, a loopback-only authenticated management agent, and durable
file-backed evidence persistence around signed evidence records.

B0 does not deliver or claim any of the following:

- a production packet data plane, transparent L2-L4 forwarding or target-NIC packet I/O;
- TLS interception, IPS, antivirus, hardware bypass or OEM forwarding integration;
- production HA, a linearizable witness, split-brain fencing or validated failover;
- physical A/B slot writes, bootloader integration, reboot execution or fleet rollout control;
- target throughput, latency, packet-loss, fail-open/fail-closed, 72-hour or hardware acceptance.

Reference and conformance components such as `FastPathReferenceModel`, `VirtualApplianceLab`,
`WitnessLeaseAuthority`, `AbSystemUpdater` and `ApplianceBundleRollout` are executable
specifications and test harnesses. Their presence in the repository, or a temporary compatibility
export used by tests, does not make the corresponding production capability part of B0.

The systemd container uses host networking only to make the agent's container loopback listener
available on the host loopback interface. The agent configuration parser accepts only
`127.0.0.1` or `::1`; non-health APIs additionally require the configured bearer token. This is a
single-host management boundary, not a remote management-plane endpoint. Remote access requires
a separately approved authenticated proxy or an implemented Unix-domain-socket transport.

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
- Repository reference models and conformance results are not production or target-hardware
  acceptance evidence.
- Host networking for the B0 agent is acceptable only while the runtime continues to enforce a
  loopback-only listener. The container remains read-only, capability-free and bearer-protected;
  operators must not place untrusted workloads in that container.

## Rollback

If no candidate passes all mandatory gates, deliver only the B0 software baseline. A reverse-proxy
profile may be named separately only after its own integration and acceptance evidence exists.
Do not relabel B0, a reverse proxy, TAP sensor or API limiter as the Version B full network data
plane.
