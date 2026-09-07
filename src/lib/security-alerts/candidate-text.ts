export function selectCandidateText(raw:string,selector:string,highlights:readonly {parts:readonly {text:string}[]}[]):string{
 let value:unknown;
 if(/^MATCHED_EVIDENCE\/[0-7]$/.test(selector)){const selected=highlights[Number(selector.split('/')[1])];if(!selected)throw new Error('CANDIDATE_SELECTOR_INVALID');value=selected.parts.map(part=>part.text).join('');}
 else if(selector==='MATCHED_EVIDENCE'){if(highlights.length!==1)throw new Error('CANDIDATE_EXPLICIT_SOURCE_SELECTION_REQUIRED');value=highlights[0].parts.map(part=>part.text).join('');}
 else {if(!selector.startsWith('/')||/~(?![01])/.test(selector))throw new Error('CANDIDATE_SELECTOR_INVALID');value=JSON.parse(raw) as unknown;
  for(const token of selector.slice(1).split('/').map(part=>part.replaceAll('~1','/').replaceAll('~0','~'))){if(['__proto__','constructor','prototype'].includes(token)||!value||typeof value!=='object'||!Object.hasOwn(value,token))throw new Error('CANDIDATE_SELECTOR_INVALID');value=Reflect.get(value,token);}
 }
 if(typeof value!=='string'||!value.trim()||Array.from(value).length>16000)throw new Error('CANDIDATE_TEXT_BUDGET_OR_TYPE_INVALID');return value;
}
