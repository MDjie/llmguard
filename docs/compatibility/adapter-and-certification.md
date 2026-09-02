# Platform adapter and certification plan

GuardLLM application images are multi-architecture OCI artifacts. The application protocol does
not depend on an accelerator vendor: OpenAI-compatible, vLLM, LMDeploy and MindIE runtimes map to
the same guarded inference contract, and model plus tokenizer digests are mandatory.

The portability workflow compiles the app, worker, Java gateway and media analyzer for
`linux/amd64` and `linux/arm64` on every change. The Helm workload contract exposes
`runtimeClassName`, `nodeSelector`, `tolerations` and `affinity` without embedding a hardware
brand in application code. `values-ascend-example.yaml` is an environment overlay template, not
proof of Ascend certification: the target cluster owns its labels, device plugin resource names,
drivers and RuntimeClass.

Database portability is not asserted by changing a JDBC/Drizzle connection string. The current
authoritative implementation uses PostgreSQL semantics including advisory locks, skip-locked job
claims, JSONB and row-level scoping. Dameng, KingbaseES, ShenTong and GaussDB each require a
dialect implementation, migration replay, transaction/isolation tests, query plan review,
backup/restore test and 30-minute load test. Until that evidence exists their matrix status
remains PENDING_TARGET_POC.

Each target combination records OS/build version, CPU/accelerator firmware, container runtime,
Kubernetes, database/middleware versions, model/runtime digests, policy bundle, test-data hash,
functional results, P50/P95/P99, throughput, resource use, failover and approver. Mutual
certification or vendor letters are attached as evidence but never replace the target POC.

Run the schema gate with:

    node scripts/compatibility/validate-matrix.mjs

The release gate uses the additional release argument and fails while any required target is
pending or lacks evidence.
