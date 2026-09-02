# 0007 Tenancy And Applications

This migration is an expand/backfill/constrain migration:

1. Create tenants, applications, application credentials and the explicit legacy scope.
2. Add nullable scope columns to every business table.
3. Backfill existing rows to the legacy scope.
4. Add non-null, tenant and composite tenant/application foreign keys plus scope indexes.
5. Replace global provider, policy and dimension uniqueness with scope-local uniqueness.
6. Create memberships and attach existing users to the migrated default application.

Before production execution, record row counts per table and verify there are no
pre-existing identifiers equal to the reserved legacy IDs. Large tables should be
migrated in bounded batches during the approved change window; the SQL here is the
deterministic empty/small-database path used by CI and Compose.

Rollback is roll-forward only after writes begin. Disable new scoped writes, restore
the previous application release, keep the added columns/tables, and repair data in
a new migration. Dropping scope columns would destroy ownership evidence and is not
an approved rollback.
