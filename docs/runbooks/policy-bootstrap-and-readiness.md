# Policy bundle bootstrap, readiness, rotation, and rollback

This runbook covers the signed policy bundle required by GuardLLM's data plane. It deliberately separates local development bootstrap from production release approval.

## Security boundary

- App, gateway, and workers receive only `POLICY_SIGNING_PUBLIC_KEY_FILE` and `POLICY_SIGNING_KEY_ID`.
- The private key is available only to the explicit signer/bootstrap process. It must not be placed in a shared Compose or workload environment block.
- `.guardllm/policy-signing/private/` is local-only, ignored by Git and Docker build context, and must never be copied into a runtime image.
- A local bootstrap release has assurance `operator-attested-development-only` and `externalApproval=false`. It is not production approval or customer acceptance.
- Production signing should use a controlled KMS/HSM or signer job, separation of duties, and the regular draft → testing → approval → canary → active lifecycle.

## Local Compose bootstrap

Prerequisites: PostgreSQL is healthy, `.env.local` points only to a loopback PostgreSQL endpoint, and `GUARDLLM_DEPLOYMENT_PROFILE=local-compose`.

```powershell
pnpm policy:keygen
pnpm policy:bootstrap
docker compose -p guardllm-r0 up -d --build
curl.exe -fsS http://127.0.0.1:58082/api/health/policy
```

`policy:keygen` creates or validates an Ed25519 pair under `.guardllm/policy-signing/`. It prints only the Key ID and public-key fingerprint. `policy:bootstrap` requires an explicit local-development acknowledgement, compiles the default profile, validates all dimensions/rules/thresholds and the detector DAG, signs and self-verifies the payload, activates it transactionally, and binds it to the local tenant/application.

The bootstrap is content-aware and idempotent:

- unchanged canonical payload: reuse the active bundle and generation;
- changed rule, threshold, model configuration, or detector DAG: issue a new immutable version, advance generation, bind it atomically, and retire the replaced bundle with an audit transition;
- compilation, signing, self-test, or transaction failure: do not activate the candidate.

## Readiness interpretation

`GET /api/health/live` proves only that the process is alive. `GET /api/health/policy` is the release/readiness gate and must return HTTP 200 with `ready=true` before traffic is admitted.

The policy response includes no key material. Check:

- active application binding and generation;
- bundle ID, content hash, Ed25519 algorithm, trusted Key ID, and public-key fingerprint;
- schema, dimension, rule, threshold, and detector-DAG summaries;
- deployment profile and assurance level;
- activation timestamp.

The detection path keeps distinct safe reason codes for missing bindings/bundles, illegal state, policy mismatch, untrusted algorithm/Key ID, invalid signature/schema, database outage, and expired last-known-good state. Do not collapse them into a generic availability failure in logs or alerts.

## Production release and key rotation

1. Generate the replacement key in the approved KMS/HSM or signer boundary.
2. Distribute the new public key and Key ID to runtime Secret references; never distribute the private key.
3. Compile, test, independently approve, sign, and verify the candidate bundle.
4. Run it in SHADOW, then CANARY, before ACTIVE.
5. Confirm readiness, error rate, detector latency, and signature alerts for the new generation.
6. Keep the previous public key and last-known-good generation available through the rollback window.
7. Revoke the old signer only after all active/rollback bundles and nodes have moved off it.

A Key ID change without the matching public key, or a signature made by an unknown key, must fail closed.

## Rollback

Use the policy lifecycle rollback operation against the currently active bundle. Rollback switches the application binding to `previousBundleId`, advances generation, restores the previous bundle to active, and appends `rollback_restore` audit evidence. Then:

1. verify `/api/health/policy` reports the expected previous bundle and new generation;
2. execute the policy/detection smoke suite;
3. inspect signature, readiness, and detector-failure metrics;
4. retain the failed bundle and transition evidence for analysis—do not mutate or delete it.

The last-known-good cache is only for a classified, short-lived database outage and is bounded by `POLICY_BUNDLE_LKG_TTL_MS`. It never bypasses signature, schema, key, state, or policy mismatch failures.

## Deployment checks

- Root filesystem remains read-only.
- Only `/app/.next/cache` and `/tmp` are writable tmpfs mounts, with bounded size and non-root ownership.
- Public key mount is read-only in every app/worker workload.
- No runtime environment contains `POLICY_SIGNING_PRIVATE_KEY` or `POLICY_SIGNING_PRIVATE_KEY_FILE`.
- App readiness probes `/api/health/policy`; liveness probes `/api/health/live`.

After restart, confirm all containers are running and search recent logs for policy errors, signature failures, private-key values, `ENOENT`, fatal errors, and unhandled exceptions.

## Common failures

| Symptom | Likely cause | Safe action |
|---|---|---|
| `POLICY_BINDING_MISSING` | Application has no active binding | Run the approved release flow; local-only environments may use `pnpm policy:bootstrap` |
| `POLICY_SIGNING_KEY_UNTRUSTED` | Key ID differs from runtime trust configuration | Correct the public-key/Key-ID Secret pair; do not weaken validation |
| `POLICY_SIGNATURE_INVALID` | Tampering, wrong key, or corrupted payload | Quarantine the bundle and roll back to the last verified generation |
| `POLICY_DATABASE_UNAVAILABLE` | Classified transient database failure | Restore DB; bounded LKG may serve only until its TTL expires |
| readiness 503 after restart | Migration, binding, key mount, or policy state is incomplete | Inspect the precise readiness reason and repair that dependency |
| Next cache `ENOENT` | Cache tmpfs/volume missing or wrong ownership | Restore only the bounded cache mount; do not make the root filesystem writable |

Database schema updates must be applied as additive migrations before deploying code that depends on them. For the local Compose schema, migration `0036_policy_dimension_config_created_at.sql` restores the timestamp expected by the ORM and is safe to reapply.
