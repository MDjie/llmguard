import type { JudgeProfile } from './profile';
import { JUDGE_SYSTEM_PROMPT,judgeWireSchema } from './response-schema';
import { riskDefinition } from '@/lib/guard-engine-v2/risk-registry';

/** Conservative byte-based admission budget, not vendor billing or a calibrated tokenizer. */
export function reserveJudgeTokens(profile:JudgeProfile,text:string):number{
  const envelope={schemaVersion:'2.0',assessmentId:'x'.repeat(128),direction:'OUTPUT_COMPLETE',text,trust:'UNTRUSTED',
    riskDefinitions:Object.fromEntries(profile.riskIds.map(id=>[id,riskDefinition(id,profile.riskDefinitions)]))};
  const schema=profile.structuredOutputMode==='json_schema'?JSON.stringify(judgeWireSchema(envelope.assessmentId,profile.riskIds,text.length)):'';
  return Buffer.byteLength(JUDGE_SYSTEM_PROMPT+JSON.stringify(envelope)+schema,'utf8')+profile.maxOutputTokens+1024;
}
