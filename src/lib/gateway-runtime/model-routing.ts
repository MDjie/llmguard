import { z } from 'zod';
import { gatewaySetting } from './settings';
import { canonicalJson, GatewayError, sha256, type JsonValue } from './protocol';

const identifier = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.:/-]+$/);
const mapping = z.object({ from:z.string().startsWith('/').max(1024), to:z.string().startsWith('/').max(1024), move:z.boolean().optional() }).strict();
const route = z.object({
  id:identifier, baseUrl:z.string().min(1).max(256), modelPattern:z.union([identifier,z.literal('*')]).optional(),
  targetModel:identifier.optional(), weight:z.number().int().min(1).max(10000), bearerTokenEnv:z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(128).optional(),
  requestMappings:z.array(mapping).max(32).optional(), responseMappings:z.array(mapping).max(32).optional(),
}).strict();
const boundariesSchema=z.record(identifier,z.array(z.string().min(1).max(128)).min(1).max(64));
function validateDestination(value:string):void {
  const url=new URL(value);
  const local=process.env.NODE_ENV!=='production'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username||url.password||url.hash||url.search||!url.hostname||(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))) throw new Error('invalid destination');
}
/** Snapshot contains only nonsecret configuration and credential references, never token values. */
export function captureModelRouting(aliases:readonly string[],dataBoundary:string) {
  try {
    const configured=gatewaySetting('GUARD_MODEL_ROUTES_JSON','GUARD_MODEL_ROUTES_FILE');
    const parsed:unknown=configured?JSON.parse(configured):null;
    const defaultBaseUrl=process.env.MODEL_BASE_URL;
    if (!defaultBaseUrl) throw new Error('missing default model endpoint');
    validateDestination(defaultBaseUrl);
    const routes=parsed===null?[{id:'default',baseUrl:defaultBaseUrl,modelPattern:'*',weight:100}]:z.array(route).min(1).max(32).parse(parsed);
    const boundaries=boundariesSchema.parse(JSON.parse(gatewaySetting('GATEWAY_MODEL_ROUTE_BOUNDARIES_JSON','GATEWAY_MODEL_ROUTE_BOUNDARIES_FILE')??'{}'));
    if (new Set(routes.map(item=>item.id)).size!==routes.length) throw new Error('duplicate route');
    for(const item of routes)validateDestination(item.baseUrl);
    for(const alias of aliases){
      const exact=routes.filter(item=>item.id===alias);
      const candidates=exact.length?exact:routes.filter(item=>(item.modelPattern??'*')==='*'||item.modelPattern===alias);
      if (!candidates.length||candidates.some(item=>!boundaries[item.id]?.includes(dataBoundary))) throw new Error('unapproved model boundary');
    }
    const configurationJson=canonicalJson({routes:parsed,defaultBaseUrl,defaultBearerTokenRef:'MODEL_BEARER_TOKEN',boundaries});
    if(configurationJson.length>262144)throw new Error('route configuration too large');
    return {configurationJson,configurationDigest:sha256(configurationJson)};
  } catch { throw new GatewayError('MODEL_ROUTING_CONFIGURATION_UNAVAILABLE',503); }
}

/** Reproduce the frozen Java route selection so MODEL_INPUT archives contain the transmitted provider body. */
export function mappedModelRequest(request:JsonValue,configurationJson:string,identity:{tenantId:string;applicationId:string;sessionId?:string;businessRequestId:string}):JsonValue {
  if(!request||typeof request!=='object'||Array.isArray(request)||typeof request.model!=='string')throw new GatewayError('MODEL_REQUEST_INVALID',400);
  const config=z.object({routes:z.array(route).nullable(),defaultBaseUrl:z.string(),defaultBearerTokenRef:z.string(),boundaries:boundariesSchema}).strict().parse(JSON.parse(configurationJson));
  const all:z.infer<typeof route>[]=config.routes??[{id:'default',baseUrl:config.defaultBaseUrl,modelPattern:'*',weight:100}];
  const exact=all.filter(item=>item.id===request.model),candidates=exact.length?exact:all.filter(item=>(item.modelPattern??'*')==='*'||item.modelPattern===request.model);
  if(!candidates.length)throw new GatewayError('MODEL_ROUTE_NOT_AUTHORIZED',403);
  const key=canonicalJson([identity.tenantId,identity.applicationId,identity.sessionId??identity.businessRequestId]);
  const unsigned=parseInt(sha256(key+'\n'+request.model).slice(0,8),16), signed=unsigned>0x7fffffff?unsigned-0x100000000:unsigned;
  const total=candidates.reduce((sum,item)=>sum+item.weight,0),bucket=((signed%total)+total)%total;
  let selected=candidates[candidates.length-1],cursor=0;for(const item of candidates){cursor+=item.weight;if(bucket<cursor){selected=item;break;}}
  const result:Record<string,JsonValue>=JSON.parse(canonicalJson(request));if(selected.targetModel)result.model=selected.targetModel;
  const tokens=(pointer:string)=>pointer.slice(1).split('/').map(token=>token.replaceAll('~1','/').replaceAll('~0','~'));
  const get=(path:readonly string[]):JsonValue|undefined=>{let value:JsonValue|undefined=result;for(const token of path){if(!value||typeof value!=='object')return undefined;value=Array.isArray(value)?value[Number(token)]:Object.hasOwn(value,token)?value[token]:undefined;}return value;};
  function apply(from:string,to:string,move:boolean){
    const source=tokens(from),destination=tokens(to),value=get(source);if(value===undefined)return;
    if([...source,...destination].some(token=>['__proto__','prototype','constructor'].includes(token)))throw new GatewayError('MODEL_MAPPING_PATH_INVALID',403);
    let parent:JsonValue=result;
    for(const token of destination.slice(0,-1)){
      if(!parent||typeof parent!=='object')throw new GatewayError('MODEL_MAPPING_PARENT_INVALID',403);
      if(Array.isArray(parent)){const index=Number(token);if(!Number.isInteger(index)||index<0||index>=parent.length)throw new GatewayError('MODEL_MAPPING_INDEX_INVALID',403);parent=parent[index];}
      else{if(parent[token]===undefined||parent[token]===null)parent[token]={};parent=parent[token];}
    }
    const leaf=destination.at(-1)!;
    if(!parent||typeof parent!=='object')throw new GatewayError('MODEL_MAPPING_PARENT_INVALID',403);
    if(Array.isArray(parent)){const index=Number(leaf);if(!Number.isInteger(index)||index<0||index>=parent.length)throw new GatewayError('MODEL_MAPPING_INDEX_INVALID',403);parent[index]=JSON.parse(canonicalJson(value));}else parent[leaf]=JSON.parse(canonicalJson(value));
    if(move&&from!==to){const old=get(source.slice(0,-1)),last=source.at(-1)!;if(Array.isArray(old))old.splice(Number(last),1);else if(old&&typeof old==='object')delete old[last];}
  }
  for(const rule of selected.requestMappings??[]){
    if(!rule.from.includes('/*/')){apply(rule.from,rule.to,rule.move??true);continue;}
    const prefix=rule.from.slice(0,rule.from.indexOf('/*/')),items=get(tokens(prefix));if(!Array.isArray(items))continue;
    for(let index=0;index<items.length;index++)apply(rule.from.replace('/*/','/'+index+'/'),rule.to.replace('/*/','/'+index+'/'),rule.move??true);
  }
  return result;
}
