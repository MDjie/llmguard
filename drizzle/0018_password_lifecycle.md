# 0018 password lifecycle migration

- Adds a bounded bcrypt password-history table. Current hashes are copied into history only when a password changes; no plaintext is stored.
- Existing users with a null or older-than-policy `password_changed_at` are forced to change password on their next successful login by application logic.
- Roll forward: retry the idempotent table and index statements.
- Rollback: stop application versions that use password history, export only aggregate audit counts, then drop `password_history`. Removing this table weakens password-reuse enforcement and requires security approval.
