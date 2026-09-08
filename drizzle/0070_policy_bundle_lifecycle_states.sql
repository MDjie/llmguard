-- 0009 predates the draft/testing/archived lifecycle introduced in 0023.
-- Preserve legacy revoked rows while admitting current lifecycle states.
BEGIN;
ALTER TABLE policy_bundles DROP CONSTRAINT IF EXISTS policy_bundles_state_ck;
ALTER TABLE policy_bundles ADD CONSTRAINT policy_bundles_state_ck CHECK (
  state IN ('draft', 'testing', 'pending_approval', 'approved', 'shadow',
            'canary', 'active', 'retired', 'archived', 'revoked')
) NOT VALID;
ALTER TABLE policy_bundles VALIDATE CONSTRAINT policy_bundles_state_ck;
COMMIT;
