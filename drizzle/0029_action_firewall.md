# 0029 Action firewall

Adds normalized side effects, required permissions, approved data destinations,
full action-intent evidence, version-bound permit state, and per-Agent-run risk
budgets. Existing tools default to `READ` and must be reviewed before activation.

Deploy the migration before the new authorization service. Rollback requires
stopping tool authorization traffic, resolving pending approvals, dropping
`agent_lifecycle_budgets`, and removing the additive registry/invocation columns.
