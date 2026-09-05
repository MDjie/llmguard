import { createHash } from 'node:crypto';
import { z } from 'zod';
import { dictionaryEntrySchema, dictionaryManifestSchema, dictionaryLayerSchema } from '@/contracts/http/policy-governance';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import { dictionaryEntryMatches, validateDictionaryManifest } from './validation';
import { riskDefinition } from '@/lib/guard-engine-v2/risk-registry';

const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const approvedTermSchema=z.object({
  termId:z.string().min(1),status:z.literal('reviewed'),sourceIds:z.array(z.string().min(1)).min(1),
  reviewEvidenceRef:z.string().min(1),entry:dictionaryEntrySchema,
}).strict();
const sourceSchema=z.object({sourceId:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),license:z.string().min(1),authorizedUse:z.literal('dictionary_release')}).strict();
export const releaseSetInputSchema=z.object({
  schemaVersion:z.literal('1.0'),policyId:z.string().min(1).max(36),dictionaryId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,89}$/),version:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),layer:dictionaryLayerSchema,
  sources:z.array(sourceSchema).min(1).max(1000),terms:z.array(approvedTermSchema).min(1).max(100000),
}).strict();
export function compileReleaseSet(raw:unknown) {
  const input=releaseSetInputSchema.parse(raw);const ids=new Set<string>();const sources=new Map(input.sources.map(s=>[s.sourceId,s]));
  if(sources.size!==input.sources.length)throw new Error('RELEASE_SOURCE_DUPLICATE');
  const terms=[...input.terms].sort((a,b)=>a.termId.localeCompare(b.termId));
  const selectors=new Set<string>();
  for(const term of terms){
    if(ids.has(term.termId))throw new Error('RELEASE_TERM_DUPLICATE');ids.add(term.termId);
    if(term.sourceIds.some(id=>!sources.has(id)))throw new Error('RELEASE_SOURCE_UNKNOWN');
    if(term.entry.canonicalTermId && term.entry.canonicalTermId!==term.termId)throw new Error('RELEASE_CANONICAL_ID_MISMATCH');
    riskDefinition(term.entry.riskType);
    for(const variant of term.entry.variants){
      const key=JSON.stringify([term.entry.matchType,term.entry.caseSensitive,term.entry.caseSensitive?variant:variant.toLowerCase(),term.entry.locale,term.entry.direction,term.entry.industry,[...term.entry.contexts].sort()]);
      if(selectors.has(key))throw new Error('RELEASE_SELECTOR_CONFLICT');selectors.add(key);
    }
    if(term.entry.positiveExamples.some(text=>!dictionaryEntryMatches(term.entry,text)) || term.entry.negativeExamples.some(text=>dictionaryEntryMatches(term.entry,text)))throw new Error('RELEASE_LEXICAL_TEST_FAILED');
  }
  const shards:Array<{manifest:z.infer<typeof dictionaryManifestSchema>;sha256:string}>=[];
  let entries:z.infer<typeof dictionaryEntrySchema>[]=[];let variants=0;
  function flush(){
    if(!entries.length)return;
    const manifest=dictionaryManifestSchema.parse({schemaVersion:'1.0',policyId:input.policyId,dictionaryId:input.dictionaryId+'.part-'+String(shards.length+1).padStart(4,'0'),version:input.version,layer:input.layer,entries});
    if(!validateDictionaryManifest(manifest).passed)throw new Error('RELEASE_SHARD_INVALID');
    shards.push({manifest,sha256:digest(manifest)});entries=[];variants=0;
  }
  for(const term of terms){
    if(entries.length>=500 || variants+term.entry.variants.length>500)flush();
    entries.push({...term.entry,canonicalTermId:term.termId,sourceIds:[...term.sourceIds].sort()});variants+=term.entry.variants.length;
  }
  flush();
  const payload={schemaVersion:'1.0',kind:'dictionary-release-set',state:'reviewed-artifact',policyId:input.policyId,dictionaryId:input.dictionaryId,version:input.version,sources:[...input.sources].sort((a,b)=>a.sourceId.localeCompare(b.sourceId)),termCount:terms.length,variantCount:shards.reduce((n,s)=>n+s.manifest.entries.reduce((m,e)=>m+e.variants.length,0),0),reviewEvidence:terms.map(t=>({termId:t.termId,evidenceRef:t.reviewEvidenceRef})),shards};
  // One content-addressed file is the atomic transport unit. No DB activation here.
  return {...payload,releaseSetDigest:digest(payload),activationStatus:'NOT_IMPORTED' as const};
}

export const releaseSetArtifactSchema = z.object({
  schemaVersion: z.literal('1.0'), kind: z.literal('dictionary-release-set'),
  state: z.literal('reviewed-artifact'), policyId: releaseSetInputSchema.shape.policyId,
  dictionaryId: releaseSetInputSchema.shape.dictionaryId, version: releaseSetInputSchema.shape.version,
  sources: releaseSetInputSchema.shape.sources, termCount: z.number().int().min(1).max(100000),
  variantCount: z.number().int().min(1).max(10000000),
  reviewEvidence: z.array(z.object({termId:z.string().min(1),evidenceRef:z.string().min(1)}).strict()).min(1).max(100000),
  shards: z.array(z.object({manifest:dictionaryManifestSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(25000),
  releaseSetDigest: z.string().regex(/^[a-f0-9]{64}$/), activationStatus: z.literal('NOT_IMPORTED'),
}).strict();
export type ReleaseSetArtifact = z.infer<typeof releaseSetArtifactSchema>;

/** Rebuild from entries instead of trusting caller-supplied counts, ordering or hashes. */
export function verifyReleaseSetArtifact(raw: unknown): ReleaseSetArtifact {
  const artifact = releaseSetArtifactSchema.parse(raw);
  const evidence = new Map(artifact.reviewEvidence.map(item=>[item.termId,item.evidenceRef]));
  if(evidence.size !== artifact.reviewEvidence.length) throw new Error('RELEASE_REVIEW_DUPLICATE');
  const rebuilt = compileReleaseSet({
    schemaVersion:'1.0',policyId:artifact.policyId,dictionaryId:artifact.dictionaryId,version:artifact.version,
    layer:artifact.shards[0].manifest.layer,sources:artifact.sources,
    terms:artifact.shards.flatMap(shard=>shard.manifest.entries.map(entry=>({
      termId:entry.canonicalTermId,status:'reviewed',sourceIds:entry.sourceIds,
      reviewEvidenceRef:evidence.get(entry.canonicalTermId ?? ''),entry,
    }))),
  });
  if(canonicalJson(rebuilt)!==canonicalJson(artifact)) throw new Error('RELEASE_SET_INTEGRITY_INVALID');
  return artifact;
}
