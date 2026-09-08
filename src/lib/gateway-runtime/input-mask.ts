import type { Observation } from '@guardllm/contracts';
import { collectTransformEntities } from '@/lib/dlp/entity-contract';
import { transformDlpText } from '@/lib/dlp';
import { GatewayError } from './protocol';

export function transformGatewayInput(text: string, observations: readonly Observation[]) {
  const entities = (() => {
    try { return collectTransformEntities(observations, text.length); }
    catch { throw new GatewayError('INPUT_TRANSFORM_ENTITY_INVALID', 503); }
  })();
  if (!entities.length) throw new GatewayError('INPUT_TRANSFORM_EVIDENCE_MISSING', 503);
  const result = transformDlpText(text, entities, {
    evidenceHmacKey: process.env.CONTENT_HASH_KEY ?? '',
    tokenizationHmacKey: process.env.DLP_TOKENIZATION_HMAC_KEY,
  });
  if (result.blocked) throw new GatewayError('INPUT_TRANSFORM_BLOCKED', 403);
  return result;
}
