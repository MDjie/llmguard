import { describe, expect, it } from 'vitest';
import { gatewayOnboardingState } from '@/lib/gateway-runtime/onboarding-state';

describe('application onboarding evidence',()=>{
  const base={configured:true,connected:true,verified:true,active:true,production:false,previouslyUsed:true};
  it('requires configuration, a current node and both positive and negative evidence',()=>{
    expect(gatewayOnboardingState({...base,configured:false,previouslyUsed:false})).toBe('DRAFT');
    expect(gatewayOnboardingState({...base,connected:false,previouslyUsed:false})).toBe('CONFIGURED');
    expect(gatewayOnboardingState({...base,verified:false})).toBe('CONNECTED');
    expect(gatewayOnboardingState(base)).toBe('VERIFIED');
    expect(gatewayOnboardingState({...base,production:true})).toBe('ENFORCING');
  });
  it('does not leave an unhealthy or disabled live application green',()=>{
    for(const failure of [{active:false},{connected:false},{configured:false}])expect(gatewayOnboardingState({...base,...failure})).toBe('DEGRADED');
  });
});
