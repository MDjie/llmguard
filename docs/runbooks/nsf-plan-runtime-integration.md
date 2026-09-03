# NSF plan runtime integration

## Scope

This runbook activates the repository-deliverable parts of plan 11 for the
Version A software gateway. It does not authorize Version B network-appliance
claims. Transparent forwarding, IPS, AV, volumetric DoS mitigation, hardware
certification, differential privacy and confidential computing remain separate
acceptance projects.

## Preconditions

1. Freeze the target environment manifest, target model and exact tokenizer
   digests, scanner products, licenses, blind datasets and named approvers.
2. Provision PostgreSQL, Redis, Kafka or Syslog, object storage, PKI and
   observability outside the chart.
3. Put all credentials and private key material in the runtime Secret. Keep only
   public configuration in environment-owned Helm values.
4. Add every HTTPS sidecar hostname to PROVIDER_ALLOWED_HOSTS. Private service
   DNS names require explicit PROVIDER_ALLOWED_PRIVATE_HOSTS and must remain
   inside the service-mesh identity boundary.

## Database rollout

Apply migrations in numeric order. The additions for this plan are:

- 0033: four-domain, append-only operational events and monthly partitions.
- 0034: registered scan assets, asynchronous tasks, immutable attempts,
  findings and independent reviews.
- 0035: policy-versioned quota counters and request-idempotent charges.

Run migrations first on a restored production-sized copy. Verify constraints,
triggers, query plans and rollback compatibility before changing application
traffic. Migrations 0033 to 0035 are additive; rollback the application before
dropping any new table.

## Signed policy build inputs

SEMANTIC_CLASSIFIER_CONFIG_JSON and GUARD_RESOURCE_ADMISSION_CONFIG_JSON are
build inputs to policy compilation. They are embedded in the canonical policy
payload before Ed25519 signing. Changing either environment variable does not
alter an active bundle; compile, test, approve, shadow, canary and activate a new
bundle.

The semantic classifier configuration pins detector, model, weight digest,
quantization, endpoint, batch, timeout, calibration temperature, labels and
failure policy. Enforce mode is rejected unless it is fail-closed.

The resource admission configuration pins the target model, exact tokenizer,
tokenizer digest and endpoint. It also defines output/session reserves,
complexity pricing, lease TTL and all 42 scope/metric/window limits. Missing
tenant, application, user, user-group, credential, model or API coverage makes
policy compilation fail. User-group charges are created only from explicit
authenticated userGroupIds claims; platform roles are not treated as user groups.

## Security scanner activation

1. Put Ed25519 public keys in SUPPLY_CHAIN_TRUSTED_PUBLIC_KEYS_JSON.
2. Put signed scanner definitions in SECURITY_SCANNER_DEFINITIONS_JSON. Each
   definition pins code version, source digest, NOTICE digest, license,
   permissions, network domains, isolation evidence and dual approvals.
3. Register an external scanner inventory identity through
   POST /api/security-scan-assets. Model assets require a sha256 digest.
4. Submit only the returned asset UUID through POST /api/security-scans.
5. Run pnpm security-scan:worker or enable the Helm security-scan workload.
6. Read attempts, findings and reviews through GET /api/security-scans/{id}.
7. Submit reviews through POST /api/security-scan-findings/{id}/reviews.
   Submitters cannot review their own findings. Arbitration requires two prior,
   distinct reviewers.

Scanner services receive registered external inventory identifiers, never a
caller-supplied URL. Returned scanner version, digest, target identity, time
range and result limits are verified before evidence is persisted.

## TONE outbound activation

Configure AUDIT_EXPORT_TONE_BASE_URL, AUDIT_EXPORT_TONE_PATH,
AUDIT_EXPORT_TONE_KEY_ID and AUDIT_EXPORT_TONE_HMAC_KEY. The URL must use HTTPS,
the HMAC key must contain at least 32 bytes and the host must pass the outbound
allowlist.

Run pnpm audit:export-worker or enable the Helm audit-export workload. Every
event uses its audit event ID as the idempotency key, includes chain-integrity
metadata and carries an HMAC-SHA256 signature. Delivery is complete only when
TONE returns accepted=true and the same event ID. Terminal failures remain in
the outbox and trigger existing observability alerts.

Inbound TONE disposition or ticket synchronization is not enabled until the
customer supplies its authoritative callback schema, signing method, replay
window and state-transition rules.

## Rollout and rollback

1. Run contract, type, lint, unit, migration and production-build checks.
2. Activate the semantic model in SHADOW and retain model, policy, tokenizer,
   dataset, image and environment digests.
3. Run blind effectiveness, 128K, multi-tenant quota, streaming leakage and
   target latency tests.
4. Move to canary only after signed evidence passes the frozen gates.
5. Roll back by restoring the previous signed policy bundle. This restores the
   previous detector, tokenizer and resource policy atomically.
6. Disable scanner or TONE workers to stop new external calls; do not delete
   tasks, attempts, findings, reviews, audit events or terminal outbox records.

## Required external evidence

Repository checks cannot close these gates: target model/tokenizer artifacts,
customer blind data and independent labels, Java gateway verification, target
PostgreSQL migration execution, real scanner engines, TONE live receipts,
72-hour stability and fault injection, disaster recovery, domestic-platform
POCs, or Version B hardware/network data-plane tests.
