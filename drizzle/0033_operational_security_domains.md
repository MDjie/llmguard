# 0033 operational security domains

Creates one immutable, monthly partitionable event model for audit, runtime,
network-security and model-security telemetry. The default partition prevents
event loss when scheduled partition maintenance is delayed. Raw model content is
not stored; callers provide only HMACs and evidence digests.

The partition maintenance job must call
ensure_operational_security_event_partition ahead of each month. Retention,
archive and restore operations require an approved evidence-retention policy.
