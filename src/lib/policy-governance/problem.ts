import { ApiProblem } from '@/lib/api-security';
import { PolicyGovernanceOperationError } from './errors';

export function policyGovernanceProblem(error: PolicyGovernanceOperationError): ApiProblem {
  return new ApiProblem({
    status: error.status,
    code: error.code,
    title: 'Policy governance operation rejected',
    detail: error.message,
  });
}
