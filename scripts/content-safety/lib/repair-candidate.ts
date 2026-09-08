import type { RuntimePolicyBundle } from '../../../src/lib/policy-bundle/runtime';
import type { RuleSpec } from '../../../src/lib/guard-engine-v2/types';
import { DEFAULT_DETECTOR_DAG } from '../../../src/lib/guard-engine-v2/default-dag';
import { currentDetectionCapabilities } from '../../../src/lib/policy-bundle/detection-capabilities';
import { dictionaryManifestSchema } from '../../../src/contracts/http/policy-governance';

export function prepareRepairVariant(base:RuntimePolicyBundle,variant:string,pack:unknown) {
  const audit:{ruleId:string;pattern:string;riskType:string;disposition:string;rationale:string}[]=[];
  if(variant==='signed-baseline')return {bundle:base,audit};
  let rules:RuleSpec[]=[...base.payload.rules];
  if(!['dag-upgrade','signed-baseline'].includes(variant)){
    const seen=new Set<string>();
    rules=rules.flatMap(rule=>{
      const {id:_id,ruleVersion:_version,...behavior}=rule;
      const key=JSON.stringify(Object.fromEntries(Object.entries(behavior).sort(([a],[b])=>a.localeCompare(b))));
      let disposition='LOCAL_CONTEXT',rationale='保留风险域，增加局部语境约束';
      let replacement:RuleSpec|undefined={...rule,matchConstraints:{...rule.matchConstraints,contextPolicy:'LOCAL_INTENT_V1'}};
      if(seen.has(key)){disposition='DEDUPLICATE';rationale='同风险域与模式重复；保留首次定义';replacement=undefined;}
      else if(rule.riskType==='pii_leak' && !rule.mandatoryDeny){disposition='TYPED_DLP_REPLACEMENT';rationale='迁移到结构化实体检测和校验；数字与邮箱词法模式不能自行生成脱敏实体';replacement=undefined;}
      else if(rule.pattern==='DAN'){disposition='BOUNDARY_AND_ROLE_RELATION';rationale='完整 Unicode 词元并与角色越权请求同分句；普通人名与子串不确认风险';
        replacement={...rule,matchConstraints:{boundary:'UNICODE_TOKEN',contextPolicy:'LOCAL_INTENT_V1',evidenceClass:'DETERMINISTIC_RISK',relation:{allOf:[],anyOf:[{pattern:'(?:act as|pretend to be|roleplay as|you are now|扮演|变成|你现在是)',matchType:'regex'}],maximumDistance:64,scope:'CLAUSE'}}};
      }else if(['SELECT * FROM','<script>','远程控制','获取文件','api_key','secret_key','access_token','扮演','你现在是','忽略','system prompt','系统提示词'].includes(rule.pattern)&&!rule.mandatoryDeny){
        disposition='SIGNAL_ONLY';rationale='语法、字段名或目标词本身不足以确认攻击；保留召回供行为关系检测';
        replacement={...replacement!,matchConstraints:{...replacement!.matchConstraints,evidenceClass:'SIGNAL'}};
      }else if(['ad_detection','copyright_risk','misinformation','spam_detection'].includes(rule.riskType)&&!rule.mandatoryDeny){
        disposition='SIGNAL_ONLY';rationale='主题或营销词不是已确认的违规行为或事实';
        replacement={...replacement!,matchConstraints:{...replacement!.matchConstraints,evidenceClass:'SIGNAL'}};
      }
      seen.add(key);audit.push({ruleId:rule.id,pattern:rule.pattern,riskType:rule.riskType,disposition,rationale});
      return replacement?[replacement]:[];
    });
  }
  if(['candidate','no-relations'].includes(variant)){
    const manifest=dictionaryManifestSchema.parse(pack);
    for(const entry of manifest.entries)for(const [index,pattern] of entry.variants.entries())rules.push({
      id:entry.canonicalTermId+'-'+index,pattern,ruleVersion:'repair-candidate-1',dictionaryLayer:manifest.layer,
      riskType:entry.riskType,matchType:entry.matchType,caseSensitive:entry.caseSensitive,score:entry.score,severity:entry.severity,mandatoryDeny:entry.mandatoryDeny,
      locale:entry.locale,direction:entry.direction,industry:entry.industry,contexts:entry.contexts,owner:entry.owner,evidenceRequirement:entry.evidenceRequirement,canonicalTermId:entry.canonicalTermId,sourceIds:entry.sourceIds,matchConstraints:entry.matchConstraints,
    });
  }
  const dimensions=[...base.payload.dimensions];
  for(const risk of new Set(rules.map(rule=>rule.riskType)))if(!dimensions.some(d=>d.code===risk))dimensions.push({id:'repair-'+risk,code:risk,name:risk,weight:1});
  const includeRelations=variant==='candidate';
  const detectorDag={...DEFAULT_DETECTOR_DAG,nodes:DEFAULT_DETECTOR_DAG.nodes.filter(node=>includeRelations||node.detectorId!=='source-risk-relations')};
  const bundle:RuntimePolicyBundle={...base,id:base.id+'-'+variant,payload:{...base.payload,rules,dimensions,detectorDag,detectionCapabilities:currentDetectionCapabilities()}};
  return {bundle:{...bundle,payload:JSON.parse(JSON.stringify(bundle.payload)) as RuntimePolicyBundle['payload']},audit};
}
