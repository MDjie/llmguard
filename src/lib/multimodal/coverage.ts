import { z } from 'zod';
export const analysisCoverageSchema=z.object({
  artifactSha256:z.string().regex(/^[a-f0-9]{64}$/u),modality:z.enum(['IMAGE','DOCUMENT','AUDIO','VIDEO']),
  state:z.enum(['COMPLETE','SAMPLED','INCOMPLETE']),expectedUnits:z.number().int().positive(),processedUnits:z.number().int().nonnegative(),
  analyzerVersion:z.string().min(1).max(512),reasonCodes:z.array(z.string().min(1)).max(100),
}).strict();
export type AnalysisCoverage=z.infer<typeof analysisCoverageSchema>;
const approvals=z.array(z.object({tenantId:z.string(),applicationId:z.string(),analyzerVersion:z.string(),
  modality:z.enum(['IMAGE','DOCUMENT','AUDIO','VIDEO']),riskIds:z.array(z.string()).min(1),validUntil:z.iso.datetime(),
  datasetSha256:z.string().regex(/^[a-f0-9]{64}$/u),approvalRef:z.string().min(1),gateStatus:z.literal('PASS')}).strict());
export function assessAnalysisCoverage(input:{coverage?:AnalysisCoverage;artifactSha256?:string;tenantId:string;applicationId:string;requiredRiskIds:readonly string[]},
  raw=process.env.MULTIMODAL_QUALITY_APPROVALS_JSON){
  const coverage=analysisCoverageSchema.safeParse(input.coverage);
  if(!coverage.success||!input.artifactSha256||coverage.data.artifactSha256!==input.artifactSha256)return{complete:false,reasonCode:'MODALITY_COVERAGE_UNVERIFIED'};
  const c=coverage.data;
  if(c.state!=='COMPLETE'||c.processedUnits!==c.expectedUnits||c.reasonCodes.length)return{complete:false,reasonCode:'MODALITY_ANALYSIS_INCOMPLETE'};
  let registry:z.infer<typeof approvals>;try{registry=approvals.parse(JSON.parse(raw??'[]'));}catch{return{complete:false,reasonCode:'MODALITY_QUALITY_UNVERIFIED'};}
  const approved=registry.some(a=>a.tenantId===input.tenantId&&a.applicationId===input.applicationId&&a.analyzerVersion===c.analyzerVersion&&a.modality===c.modality&&Date.parse(a.validUntil)>Date.now()&&input.requiredRiskIds.length>0&&input.requiredRiskIds.every(r=>a.riskIds.includes(r)));
  return{complete:approved,reasonCode:approved?'MODALITY_QUALIFIED_COMPLETE':'MODALITY_QUALITY_UNVERIFIED'};
}
