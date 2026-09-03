# 0035 Guard quota ledger

Adds policy-versioned counters and request-idempotent charges for distributed
Guard admission. Concurrency charges are leases and are released on completion
or recovered after their bounded TTL.
