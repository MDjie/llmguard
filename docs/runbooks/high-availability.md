# High availability operating standard

## Objective

The production topology has no single application-process failure point. The gateway and online
application run at least three replicas across hosts and zones. Every worker has at least two
replicas and claims jobs transactionally. Stateful services use quorum-based topologies:
PostgreSQL 3 instances, Redis 1 primary plus 3 replicas and 3 Sentinels, Kafka 3 controllers plus
3 brokers with minimum ISR 2, MinIO 4 servers and OpenSearch 3 master/data nodes.

The target service SLO is 99.99% monthly availability. The recovery objectives are RPO no greater
than 15 minutes and RTO no greater than 30 minutes. These values are targets until a dated,
environment-specific drill report proves them.

## Failure handling

1. Freeze policy publication and preserve the active signed bundle.
2. Confirm the gateway keeps using the last-known-good bundle and required-detector failure mode.
3. Let the Kubernetes controller replace stateless pods. Do not manually delete multiple quorum
   members at once.
4. For PostgreSQL, confirm the operator promoted the most advanced healthy replica and that the
   read-write service points to it. Record last archived WAL time.
5. For Redis and Kafka, confirm quorum and replica synchronization before restoring producers.
6. For MinIO or OpenSearch, restore service only after the cluster is healthy or read-only;
   artifact quarantine must fail closed while object verification is unavailable.
7. Run the smoke POCs and reconcile queued jobs by idempotency key.

## Required evidence

Capture incident start, detection, promotion, application recovery, data checkpoint, lost
transactions, commands, operator events and approver. Store the evidence under a new immutable
acceptance run directory. Never replace an older drill result.
