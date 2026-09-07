import { z } from 'zod';
import { gatewaySetting } from './settings';
import { canonicalJson, GatewayError, sha256 } from './protocol';

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
