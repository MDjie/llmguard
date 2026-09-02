# 0026 audit trusted timestamp

Adds verified, immutable-by-reference trusted-time evidence for HMAC audit-chain
events. The worker verifies the timestamp provider signature, nonce, digest,
clock window and configured public-key fingerprint before insertion.

Rollback requires an approved evidence-retention exception. The table is
intentionally not removed by an automated rollback because it contains
compliance evidence.
