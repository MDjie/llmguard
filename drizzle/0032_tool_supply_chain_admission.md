# 0032 Tool and MCP supply-chain admission

Adds immutable source, signature, license, scanner-definition, capability and approval
metadata to every Tool/MCP version. Existing rows are moved to `pending_admission`; the
Action Firewall also rejects legacy rows so migration order cannot create a bypass.

Re-admit an old tool only by registering a new exact version after isolated analysis and
dual approval. Do not backfill invented digests or approvals.
