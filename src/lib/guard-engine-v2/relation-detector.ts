import { inspectRiskRelations, RISK_RELATION_VERSION } from './risk-relations';
import { textEvidence } from './evidence';
import type { GuardDetector,GuardDetectorContext,Observation } from './types';

export class SourceRelationDetector implements GuardDetector {
  readonly id='source-risk-relations';
  readonly version=RISK_RELATION_VERSION;
  readonly required=true;
  async detect(context:GuardDetectorContext):Promise<readonly Observation[]> {
    context.signal.throwIfAborted();
    const original=context.views.filter(view=>(view.depth??0)===0);
    const sourceFor=(view:GuardDetectorContext['views'][number])=>{
      const envelope=context.envelopes.find(e=>e.envelopeId===view.sourceEnvelopeId);
      return {id:view.id,text:view.text,sourceType:envelope?.sourceType??'USER',
        instructionCapability:envelope?.instructionCapability??'UNKNOWN',objectRef:envelope?.sourceId};
    };
    // Cross-source links use original provenance. Decode variants may establish only
    // within-source relations, never borrow actions or targets from sibling views.
    const assessments=[inspectRiskRelations(original.map(sourceFor)),
      ...context.views.filter(view=>(view.depth??0)>0).map(view=>inspectRiskRelations([sourceFor(view)]))];
    const assessment={relations:assessments.flatMap(item=>item.relations),evidence:assessments.flatMap(item=>item.evidence),
      reasonCodes:[...new Set(assessments.flatMap(item=>item.reasonCodes))]};
    const evidenceById=new Map(assessment.evidence.map(item=>[item.id,item]));
    const viewsById=new Map(context.views.map(view=>[view.id,view]));
    const observations:Observation[]=assessment.relations.map(relation=>({
      detectorId:this.id,detectorVersion:this.version,riskType:'prompt_injection.relation',
      ruleId:relation.relationId,ruleVersion:relation.relationRuleVersion,
      decisionRole:relation.status==='CONFIRMED'?'CONFIRMED_RISK':'CANDIDATE',
      score:relation.status==='CONFIRMED'?0.96:0.5,scoreMeaning:'POLICY',
      severity:relation.status==='CONFIRMED'?'CRITICAL':'MEDIUM',status:'MATCH',
      reasonCode:'RELATION_'+relation.kind+'_'+relation.status,
      evidence:relation.evidenceIds.flatMap(id=>{
        const item=evidenceById.get(id);const view=item?viewsById.get(item.sourceId):undefined;
        return item&&view?[textEvidence(context,view,item.start,item.end,view.text.slice(item.start,item.end),'[关系 '+item.role+']')]:[];
      }),
    }));
    for(const reasonCode of assessment.reasonCodes)observations.push({
      detectorId:this.id,detectorVersion:this.version,riskType:'detector_availability',score:0,severity:'NONE',
      status:'SKIPPED',evidence:[],failMode:'DEGRADED',semanticCoverage:'INCOMPLETE',reasonCode,
    });
    return observations;
  }
}
