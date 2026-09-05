import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import { privateEndpointApproved } from '@/lib/judge/profile-registry';
import { judgeDirectionSchema } from '@/lib/judge/profile';
import type { GuardDetectorContext, SemanticClassifierSpec } from './types';

export const classifierCoverageSchema=z.object({
  tenantId:z.string().min(1),applicationId:z.string().min(1),
  directions:z.array(judgeDirectionSchema).min(1).max(7),locales:z.array(z.string().min(1)).max(50),
  contextScope:z.enum(['full','window']),deploymentMode:z.enum(['private','cloud']),dataBoundaryPolicyId:z.string().min(1),
  qualityEvidenceId:z.string().min(1),qualityValidUntil:z.iso.datetime(),
}).strict();
export function classifierBindingDigest(spec:SemanticClassifierSpec):string{
  const bound={...spec,coverage:spec.coverage?{...spec.coverage}:undefined};
  const value:Record<string,unknown>={...bound};delete value.mode;
  if(!bound.coverage)delete value.coverage;
  else {const coverage:Record<string,unknown>={...bound.coverage};delete coverage.qualityEvidenceId;delete coverage.qualityValidUntil;value.coverage=coverage;}
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
const approvalsSchema=z.array(z.object({
  evidenceId:z.string().min(1),bindingDigest:z.string().regex(/^[a-f0-9]{64}$/u),validUntil:z.iso.datetime(),
  gateStatus:z.literal('PASS'),datasetSha256:z.string().regex(/^[a-f0-9]{64}$/u),reviewApprovalRef:z.string().min(1),
}).strict());
export function assertClassifierQualification(spec:SemanticClassifierSpec,now=Date.now(),raw=process.env.SEMANTIC_CLASSIFIER_QUALITY_APPROVALS_JSON){
  if(!spec.coverage||spec.mode!=='ENFORCE')throw new Error('SEMANTIC_CLASSIFIER_QUALITY_REQUIRED');
  let approvals:z.infer<typeof approvalsSchema>;
  try{approvals=approvalsSchema.parse(JSON.parse(raw??'[]'));}catch{throw new Error('SEMANTIC_CLASSIFIER_QUALITY_REQUIRED');}
  const approved=approvals.find(a=>a.evidenceId===spec.coverage?.qualityEvidenceId&&a.bindingDigest===classifierBindingDigest(spec));
  if(!approved||Date.parse(approved.validUntil)<=now||Date.parse(spec.coverage.qualityValidUntil)<=now||
    Date.parse(spec.coverage.qualityValidUntil)>Date.parse(approved.validUntil))throw new Error('SEMANTIC_CLASSIFIER_QUALITY_REQUIRED');
}
export function assertClassifierScope(spec:SemanticClassifierSpec,context:GuardDetectorContext){
  const c=spec.coverage;if(!c)return;
  if(c.tenantId!==context.request.context.tenantId||c.applicationId!==context.request.context.applicationId||
    !c.directions.includes(context.request.context.direction)||(c.locales.length&&!c.locales.includes(context.request.context.locale??''))||
    (context.request.content.artifacts?.length??0)>0)throw new Error('SEMANTIC_CLASSIFIER_SCOPE_UNSUPPORTED');
  if(c.deploymentMode==='private'&&!privateEndpointApproved({...c,baseUrl:spec.baseUrl}))throw new Error('SEMANTIC_CLASSIFIER_PRIVATE_BOUNDARY_NOT_APPROVED');
  if(c.deploymentMode==='cloud'&&context.envelopes.some(e=>e.sensitivityLabels.some(l=>/secret|credential|pii|confidential|personal|health|classification:[1-9]/iu.test(l))))throw new Error('SEMANTIC_CLASSIFIER_DATA_BOUNDARY_REJECTED');
}
