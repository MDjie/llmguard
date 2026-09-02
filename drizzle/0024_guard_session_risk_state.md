# 0024 Guard session risk state

Adds a bounded, encrypted and expiring per-session tail used only for multi-turn
risk detection. The table never stores plaintext prompts. Rollback requires
stopping Guard v1 traffic with `sessionId` and then dropping
`guard_session_risk_states`.
