# 0028 Secure memory layers

Adds the immutable encrypted event log, structured risk ledger, evidence graph,
and version metadata for the existing encrypted hot window. Event updates are
rejected by a database trigger; retention and tenant deletion continue to use
explicit deletes.

Apply only after `0024_guard_session_risk_state.sql`. Deploy code after this
migration completes. Rollback requires stopping Guard traffic with `sessionId`,
exporting required audit evidence, dropping the immutable-event trigger and its
function, dropping the three `guard_memory_*` tables, and then removing the
three additive columns from `guard_session_risk_states`.
