import type { Observation } from '@guardllm/contracts';
import { isConfirmedObservation } from '@/lib/guard-engine-v2/observation-role';
import type { DlpTransformEntity } from './transformation';

export const DLP_ENTITY_CONTRACT_VERSION = 'guard-dlp-entity-1';
const TYPES = new Set([
  'pii.name','person.name','pii.mobile','pii.email','pii.identity.prc','pii.passport','pii.address',
  'customer.number','insurance.policy_number','insurance.claim_number','insurance.beneficiary',
  'sensitive.health','sensitive.medical','sensitive.financial','insurance.underwriting',
  'financial.bank_card','financial.account_balance','financial.income','financial.credit','financial.payment',
  'credential.secret','internal.system_prompt','internal.pricing','internal.unreleased_product',
  'internal.rule','internal.architecture','internal.staff','business.secret',
  'organization.unified_social_credit_code','vehicle.identification_number',
]);
const PRODUCERS = new Set(['structured-dlp','output-privacy-dlp','output-internal-data','output-credential-leak']);

/** Only registered typed producers may create transformation entities. A lexical hit is not a typed entity. */
export function collectTransformEntities(observations: readonly Observation[], textLength: number): readonly DlpTransformEntity[] {
  const entities = new Map<string,DlpTransformEntity>();
  for (const observation of observations) {
    if (!isConfirmedObservation(observation) || !PRODUCERS.has(observation.detectorId) || !observation.category) continue;
    if (!TYPES.has(observation.category)) throw new Error('DLP_ENTITY_TYPE_UNSUPPORTED');
    for (const evidence of observation.evidence) {
      if (evidence.start === undefined || evidence.end === undefined) continue;
      const confidence = observation.confidence ?? observation.score;
      if (!Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 0 ||
          evidence.end <= evidence.start || evidence.end > textLength || !Number.isFinite(confidence) ||
          confidence < 0 || confidence > 1) throw new Error('DLP_ENTITY_EVIDENCE_INVALID');
      const key = observation.category + ':' + evidence.start + ':' + evidence.end;
      entities.set(key,{entityType:observation.category,start:evidence.start,end:evidence.end,confidence,contentHmac:evidence.contentHmac});
      if (entities.size > 4096) throw new Error('DLP_ENTITY_BUDGET_EXCEEDED');
    }
  }
  return [...entities.values()];
}
