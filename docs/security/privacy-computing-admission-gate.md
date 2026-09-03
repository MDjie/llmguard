# Privacy Computing Production Admission Gate

Status: `NOT_ENABLED`

This repository does not currently claim that differential privacy, trusted execution,
multi-party computation, or homomorphic encryption protects the production Guard path.
Encryption at rest or in transit must not be marketed as privacy computing.

## Differential Privacy

Production admission requires all of the following:

- a named protected population, released statistic and adversary;
- approved epsilon and delta limits for every release and cumulative lifetime;
- a tested privacy accountant that fails closed when the budget is exhausted;
- utility thresholds on a frozen representative dataset;
- composition, deletion, incident and rollback procedures;
- signed evidence binding code, configuration, dataset and accountant state.

Until those inputs exist, differential privacy remains `BLOCKED_EXTERNAL` and outside
the online decision path.

## Confidential Computing

KMS/HSM-backed key custody and a TEE proof of concept are the preferred evaluation
order. Production admission requires measured boot, remote attestation, approved
platform and firmware identities, workload/image digest binding, key release policy,
revocation, patch response, rollback and an explicit side-channel threat assessment.

An unattested workload must never receive protected keys. Failure to attest is a
blocking result, not a transparent fallback.

## MPC And Homomorphic Encryption

MPC and homomorphic encryption remain `NOT_IMPLEMENTED`. Admission requires a narrow
business computation, protocol and parameter review, collusion assumptions, key and
party lifecycle, correctness tests, target-hardware performance evidence, failure
recovery and independent cryptographic review.

Product material must use the exact admitted mechanism and scope. The generic claim
"encrypted computing" is prohibited while these gates remain open.
