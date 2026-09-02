# 0008 Policy bundles and evaluation results

## Roll forward

Apply after `0007_tenancy_and_applications.sql` with `ON_ERROR_STOP=1`. The migration
creates the previously optional evaluation result table, immutable signed policy
bundles, and the per-application activation pointer. Composite foreign keys prevent a
bundle or activation pointer from crossing tenant/application scope.

## Rollback

1. Stop policy compilation and activation writes.
2. Preserve `policy_bundles` as an evidence export.
3. Repoint readers to the legacy policy profile during the rollback window.
4. Drop `application_policy_bindings`, then `policy_bundles`.
5. Drop `evaluation_results` only when no evaluation evidence must be retained.

Dropping bundle tables destroys approval and activation history, so rollback requires
the change owner and audit owner to approve the evidence export first.
