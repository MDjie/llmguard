# 0027 data lineage and deletion proofs

Adds tenant-scoped provenance edges for transformations and HMAC-signed batch
deletion evidence. A deletion proof binds the cutoff, exact deleted-object ID
digests, storage phase states, completion time and key version.

The retention worker records only work it completed. Object storage, search
index and backup deletion remain explicitly marked as not applicable or pending
until their deployment adapters return verifiable receipts.

Rollback must preserve exported lineage and deletion evidence for the applicable
compliance retention period. No automated destructive rollback is supplied.
