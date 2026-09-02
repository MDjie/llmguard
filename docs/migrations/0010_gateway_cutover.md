# Migration 0010: application gateway cutover

Adds a generation-based application routing pointer. The database constraints only allow the
approved rollout percentages `0/1/5/25/100`; the service state machine additionally requires
shadow first, monotonic canary growth and healthy release gates. Rollback restores the immediate
previous configuration atomically.
