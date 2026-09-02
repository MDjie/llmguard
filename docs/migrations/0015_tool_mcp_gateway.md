# Migration 0015: Tool/MCP policy enforcement point

Adds the governed tool/MCP registry, parameter-bound invocation records and two-person approvals.
Permit tokens are short-lived and one invocation can consume a result exactly once. No raw tool
parameters are retained; the audit record stores their canonical SHA-256 hash.
