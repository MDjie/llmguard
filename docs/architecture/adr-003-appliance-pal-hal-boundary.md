# ADR-003: Appliance PAL/HAL Boundary

Status: accepted for Version B integration; data-plane implementation blocked.

The product will not implement a new general-purpose IPS, antivirus engine, TCP stack or
DDoS engine in this application repository. A selected kernel/eBPF, user-space or commercial
OEM data plane must integrate through the protocol abstraction layer (PAL), emit framed source
evidence, and wait for an inspection decision before forwarding protected traffic.

Inspection failures are fail closed. A bypass is available only for traffic explicitly marked
unprotected and only with a signed, scoped, time-limited, dual-approved permit. The permit and
every bypass transition are audit evidence.

Hardware and accelerator providers integrate through the hardware abstraction layer (HAL).
HAL reports immutable driver/firmware identities and bounded telemetry; the control plane maps
it to healthy, degraded or drain decisions. HAL does not assert hardware compatibility by
itself.

Data-plane selection, licensing, target hardware, protocol conformance, PCAP escape testing,
flood testing, line-rate measurements, certificate rotation and field failover remain
`BLOCKED_EXTERNAL`. No Version B product claim is allowed until signed target evidence exists.
