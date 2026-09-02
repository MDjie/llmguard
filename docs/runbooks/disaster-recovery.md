# Disaster recovery orchestration

## Activation

The incident commander activates DR after confirming the primary failure cannot recover inside
the 30-minute RTO. Security administration, system administration and audit approval remain
separate roles. DNS or traffic-manager changes require two-person approval.

## Ordered recovery

1. Establish PKI, secrets controller, time synchronization and observability.
2. Restore PostgreSQL to the selected point and validate the signed policy-bundle chain.
3. Restore object storage and verify database-to-object hashes.
4. Start Redis, Kafka and search, then control workers with callbacks disabled.
5. Start inference services and verify model/AI BOM digests.
6. Start the online application. Start the gateway last in shadow mode.
7. Run POC smoke and tenancy isolation. Move 1%, 10%, 50% and 100% traffic only after explicit
   approval and error-budget checks.
8. Re-enable callbacks after reconciliation and record any skipped or duplicate delivery.

If policy verification, tenant isolation, audit persistence or required detectors are unavailable,
remain fail closed for protected traffic. A business-approved bypass is time-bound, scoped and
audited; it must not route directly to model services.
