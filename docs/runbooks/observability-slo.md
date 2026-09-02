# Observability and SLO standard

## Signals

Every inbound request accepts W3C traceparent and returns x-trace-id and x-request-id. The gateway,
application, guard engine and downstream analyzer spans must retain the same trace identifier.
Logs are JSON and redact authorization, credentials, prompts, input/output and evidence. Metrics
must not use tenant IDs, user IDs, request IDs, artifact IDs or raw paths as labels.

The platform exports:

- HTTP request counts, status class and duration;
- guard decisions by direction/action, decision duration and mandatory detector failures;
- job depth, oldest-job age, retry/dead-letter counts and callback delivery state;
- policy bundle version/verification/rollback state;
- JVM/Node runtime, database pool, object access, Kubernetes and GPU/NPU metrics.

## Service-level objectives

| SLI | Objective | Window | Release gate |
| --- | ---: | ---: | --- |
| Online availability | at least 99.99% | rolling 30 days | no unresolved critical burn alert |
| Main guard P99 | at most 300 ms | 30-minute target-environment load test | mandatory |
| Fast classifier response | at most 200 ms and at least 98% accuracy | frozen test set | mandatory |
| Single-node throughput | at least 20 QPS | 30 minutes | mandatory |
| Cluster throughput | at least 200 QPS | 30 minutes | mandatory |
| Concurrent sessions | at least 3000; console users at least 300 | target environment | mandatory |

Business-model generation time is excluded only from the 300 ms guard SLI and must be reported
separately. Timeouts, fail-closed blocks and retries remain in error and latency denominators.

## Evidence

Export the Prometheus query, raw time series, dashboard snapshot, load-test summary, deployment
digests and active policy bundle into a new acceptance run directory. A dashboard screenshot
alone is not acceptance evidence. Alert routing and on-call acknowledgement are tested quarterly.
