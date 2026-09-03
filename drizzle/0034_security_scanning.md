# 0034 Security scanning

Adds tenant-scoped asynchronous security scan tasks, immutable execution attempts,
deduplicated findings and immutable independent-review records.

Targets must resolve to active tenant-scoped asset records with matching version
and model digest. Scanner endpoint configuration remains in the signed
server-side scanner catalog and is never accepted from API callers.
