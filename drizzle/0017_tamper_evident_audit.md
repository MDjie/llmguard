# 0017 tamper-evident audit migration

- Compatibility: existing events remain readable with `chain_version IS NULL`; new events use chain version 1.
- Lock impact: columns are nullable and metadata-only on supported PostgreSQL versions. The partial unique index scans the audit table and must be scheduled outside peak ingestion.
- Roll forward: if index creation is interrupted, rerun the migration. Existing rows are intentionally not assigned unverifiable synthetic hashes.
- Rollback: stop writers using chain fields, drop the append-only trigger and partial index, then drop the six nullable columns. Export and retain all version-1 events before rollback because their integrity metadata would otherwise be lost.
- Operational rule: application roles must only have `INSERT` and `SELECT`; trigger disablement is a break-glass DBA action and must be independently audited.
