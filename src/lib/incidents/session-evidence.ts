export interface SessionEvidenceSource { userPrompt:string|null;mockModelOutput:string|null;finalResponse:string|null;inputAction:string|null }
export function sessionEvidence(source:SessionEvidenceSource,canRead:boolean){
  const text=(value:string|null,empty:string)=>!canRead?{text:null,reason:'当前角色没有原文查看权限'}:value!==null?{text:value,reason:null}:{text:null,reason:empty};
  return {
    input:text(source.userPrompt,'原文未留存或已按保留策略清理'),
    output:text(source.mockModelOutput,source.inputAction==='block'?'输入已拦截，未产生模型回答':'模型回答未留存或未提供'),
    delivered:text(source.finalResponse,'最终回复未留存或未提供'),
  };
}
