# 0038 policy governance rollback

This migration is additive and intentionally has no automatic destructive rollback.

Safe rollback procedure:

1. Stop policy/template writes and roll the application back to the previous image.
2. Keep the added columns and tables in place; previous application versions ignore them.
3. Export `dictionary_releases`, `dictionary_release_transitions`, `response_templates`,
   `detector_calibrations`, and `badcase_feedback` with checksums before any manual cleanup.
4. Only after the retention owner and security approver sign off may an operator remove the
   triggers, constraints, columns, or tables in a dedicated maintenance migration.
5. If a maintenance migration removes the schema, drop the child release-scope and
   application-scope foreign keys before dropping the dictionary scope index or parent tables.
   Preserve the existing application scope keys used by pre-existing product tables.

Never delete release or transition rows as part of an ordinary application rollback.
