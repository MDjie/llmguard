# Backup and restore runbook

## Backup policy

- PostgreSQL continuously archives WAL with an archive timeout no greater than five minutes and
  performs a full backup daily. Keep 30 days locally and an approved cross-failure-domain copy.
- Object storage enables versioning, object lock for policy/evidence buckets and site
  replication. Database backup and object version checkpoints are recorded together.
- Kafka is not the system of record. Retain topics long enough to replay in-flight work; database
  idempotency keys prevent duplicate outcomes.
- Redis contains disposable cache, locks and rate counters. Persistent queues must not exist only
  in Redis.
- OpenSearch indexes are reconstructed from PostgreSQL audit metadata and object evidence; still
  take daily snapshots to reduce RTO.
- Backup credentials are read-only/write-only as appropriate, rotated independently and never
  included in the backup payload.

## Restore procedure

1. Open an approved change and create an isolated namespace and new database cluster. A restore
   must never target the active production service name.
2. Select a full backup and point-in-time WAL position at or before the declared recovery point.
3. Restore PostgreSQL, then verify migrations, tenant counts, policy bundle signatures, audit hash
   chains and referential checks.
4. Restore object versions at the coordinated checkpoint and verify sampled artifact hashes.
5. Rebuild search indexes and start consumers with outbound callbacks disabled.
6. Run smoke, tenancy isolation, policy rollback and the 15 POC scenarios.
7. Record actual RPO/RTO with scripts/dr/record-drill.mjs. Only a passing signed report may close
   the drill.

## Quarterly verification

Perform at least one full isolated restore and one stateful failover each quarter. A checksum-only
backup check is useful but does not count as a restore test.
