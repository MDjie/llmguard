# 0020 incident workflow

- Adds tenant/application-scoped incidents and an append-only transition ledger.
- The application enforces legal transitions, disposition notes, assignment, optimistic versioning and SLA calculations. Database checks constrain status/severity values.
- Rollback must export open incidents and their transition ledger. Dropping active response records requires security-operations approval.
