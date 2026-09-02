# Acceptance evidence

Generate the canonical 101-item map with:

    node scripts/acceptance/generate-traceability.mjs

Run code-level POC checks with:

    node scripts/acceptance/run-pocs.mjs

The code run intentionally ends as PENDING_EXTERNAL_EVIDENCE. It cannot prove blind-dataset
effectiveness, target hardware performance, high availability, disaster recovery, certification
or customer integrations.

The independent acceptance team keeps raw black/white samples outside this repository. Only a
content-free index with 2000 ATTACK and 2000 BENIGN records is placed at the path in the dataset
manifest, then frozen by sha256. Every result must record attempt 1; duplicate/retried rows are
rejected. Target-environment reports use evidence-report.schema.json, contain at least two
approvers and immutable artifact hashes, and are signed outside the application.

A release run uses the --release option and ACCEPTANCE_COSIGN_KEY. It fails unless all 15 POCs
have executable success plus external PASS evidence. Evidence runs use unique directories and
never overwrite earlier failures.
