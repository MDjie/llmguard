# Cryptographic and PKI profile

## Default profile

- External and east-west TLS is TLS 1.2 or newer; mTLS is mandatory between the gateway, guard
  service, model service, analyzers and tool gateway.
- cert-manager requests short-lived workload certificates from the enterprise CA. Private keys
  are non-exportable where the target PKI/HSM supports it and rotate at renewal.
- Stored provider/callback secrets use AES-256-GCM envelopes with authenticated context and a
  versioned master-key ID. Production master keys reside in KMS/HSM, not environment files.
- Policy bundles use Ed25519 signatures; evidence, application credentials and provenance use
  separate HMAC-SHA-256 keys. Key reuse across purposes is forbidden.
- Passwords use bcrypt with an operationally calibrated work factor. Database and object storage
  use encrypted volumes and independent backup keys.

## Chinese commercial cryptography profile

Where the target assessment requires SM2/SM3/SM4 and TLCP/GMSSL, terminate the approved protocol
on a certified cryptographic gateway or service mesh and keep mTLS to GuardLLM workloads. Envelope
key operations are delegated to the approved HSM/KMS provider. The adapter must expose key ID,
algorithm suite, device serial, operation result and audit reference without exposing key bytes.

Release is blocked until the target vendor, product model, certification validity, supported
algorithm suite, benchmark and failover behavior have been verified in the customer's
environment. This repository provides the integration boundary and certificate resources; it
does not claim a cryptographic product certificate.

## Rotation and revocation

Certificates renew at least seven days before expiry. Compromised credentials are revoked at the
issuer, removed from the secret controller and rolled without restarting every replica at once.
Policy verification keeps the previous public key during a controlled overlap window. Secret
envelopes are rewrapped by key ID; bulk plaintext export is prohibited.
