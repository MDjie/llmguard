export type GatewayOnboardingState='DRAFT'|'CONFIGURED'|'CONNECTED'|'VERIFIED'|'ENFORCING'|'DEGRADED';
export interface GatewayOnboardingEvidence {
  configured:boolean;
  connected:boolean;
  verified:boolean;
  active:boolean;
  production:boolean;
  previouslyUsed:boolean;
}
/** Deployment labels describe observed gateway behavior, not model quality certification. */
export function gatewayOnboardingState(evidence:GatewayOnboardingEvidence):GatewayOnboardingState {
  if(!evidence.active||!evidence.configured)return evidence.previouslyUsed?'DEGRADED':'DRAFT';
  if(!evidence.connected)return evidence.previouslyUsed?'DEGRADED':'CONFIGURED';
  if(!evidence.verified)return 'CONNECTED';
  return evidence.production?'ENFORCING':'VERIFIED';
}
