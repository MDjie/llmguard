import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { buildToxicCnPack, compileToxicCnShadowRules, toxicCnConversionJsonl, type ToxicCnInput } from '../../src/lib/content-safety/toxiccn-lexicon';
import { convertLexiconSources } from '../../src/lib/policy-governance/lexicon-conversion';
import { parseCompiledPolicyBundlePayload } from '../../src/lib/policy-bundle/runtime';
import { canonicalJson } from '../../src/lib/policy-bundle/canonical';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const sourceSchema = z.object({ sourceId: z.literal('toxiccn-v1'), license: z.string(), revision: z.string(), allowedUse: z.literal('candidate_import_only'),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int(), sha256: z.string() })).length(5) });
export async function loadToxicCnInputs(root: string): Promise<{ inputs: ToxicCnInput[]; curation: unknown; license: string; revision: string }> {
  const lock = z.object({ sources: z.array(z.unknown()) }).parse(JSON.parse(await readFile(path.join(root, 'data/content-safety/sources/sources.lock.json'), 'utf8')));
  const matches = lock.sources.filter(s => typeof s === 'object' && s !== null && 'sourceId' in s && s.sourceId === 'toxiccn-v1');
  if (matches.length !== 1) throw new Error('TOXICCN_SOURCE_LOCK_REQUIRED');
  const source = sourceSchema.parse(matches[0]);
  const inputs: ToxicCnInput[] = [];
  for (const file of source.files) {
    const resolved = path.resolve(root, file.path), relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SOURCE_OUTSIDE_PROJECT');
    const bytes = await readFile(resolved);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('TOXICCN_SOURCE_HASH_MISMATCH');
    const category = z.enum(['general', 'racism', 'sexism', 'region', 'LGBT']).parse(path.basename(file.path, '.json'));
    inputs.push({ category, sourcePath: file.path, content: bytes.toString('utf8'), sha256: file.sha256 });
  }
  const curation: unknown = JSON.parse(await readFile(path.join(root, 'data/content-safety/lexicon/toxiccn-curation.v1.json'), 'utf8'));
  return { inputs, curation, license: source.license, revision: source.revision };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, snapshot: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('pnpm exec tsx scripts/content-safety/toxiccn-import.ts --out NEW_DIRECTORY [--snapshot BASELINE_SNAPSHOT]\nCreates candidate review and shadow engine artifacts; never edits the master lexicon or activates a deployed policy.'); return; }
  if (!values.out) throw new Error('NEW_OUTPUT_DIRECTORY_REQUIRED');
  const root = process.cwd(), out = path.resolve(values.out);
  const { inputs, curation, license, revision } = await loadToxicCnInputs(root);
  const pack = buildToxicCnPack(inputs, curation), compiled = compileToxicCnShadowRules(pack), content = toxicCnConversionJsonl(pack);
  const conversion = convertLexiconSources([{ source: { sourceId: pack.sourceId, path: 'candidates.jsonl', format: 'candidate-jsonl', sha256: hash(content), license, authorizedUse: 'candidate_only', riskMapping: {} }, content }]);
  if (conversion.counts.rejectedRows || conversion.counts.quarantinedRows) throw new Error('TOXICCN_CONVERSION_REJECTED');
  let snapshot: unknown;
  let baselineHash: string | null = null;
  if (values.snapshot) {
    const base = z.object({ bundle: z.object({ id: z.string(), tenantId: z.string(), applicationId: z.string(), generation: z.number(), payload: z.unknown() }), payloadHash: z.string() }).parse(JSON.parse(await readFile(values.snapshot, 'utf8')));
    const payload = parseCompiledPolicyBundlePayload(base.bundle.payload);
    baselineHash = hash(canonicalJson(payload));
    if (baselineHash !== base.payloadHash) throw new Error('BASELINE_PAYLOAD_HASH_INVALID');
    if (payload.rules.some(r => r.id.startsWith('toxiccn:'))) throw new Error('BASELINE_ALREADY_CONTAINS_TOXICCN');
    if (payload.detectorDag && !payload.detectorDag.nodes.some(n => n.detectorId === 'rules')) throw new Error('BASELINE_RULE_DETECTOR_REQUIRED');
    const candidate = parseCompiledPolicyBundlePayload({ ...payload, rules: [...payload.rules, ...compiled.rules] });
    snapshot = { bundle: { ...base.bundle, id: base.bundle.id + '-toxiccn-shadow', payload: candidate }, payloadHash: hash(canonicalJson(candidate)) };
  }
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out); // EEXIST is deliberate: preserve reproducible prior runs.
  const json = async (name: string, value: unknown): Promise<void> => writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await json('pack.json', pack);
  await json('shadow-rules.json', compiled);
  await writeFile(path.join(out, 'candidates.jsonl'), content, { flag: 'wx' });
  await json('review-conversion.json', conversion);
  if (snapshot) await json('candidate-snapshot.json', snapshot);
  const manifest = { kind: 'TOXICCN_P0_1_SHADOW_INTEGRATION', productionEligible: false, onlineServiceChanged: false,
    sourceRevision: revision, sourceLicense: license, sourceDigest: pack.digest, curationHash: pack.curationHash,
    counts: pack.counts, ruleCount: compiled.rules.length, baselineHash,
    evidenceClass: 'SIGNAL', requiresSemanticConfirmation: true, automaticMasterPromotion: false,
    releasePath: 'review-conversion.json -> workbench annotation/adjudication -> compileReviewedConversion -> evaluated, approved and signed policy bundle' };
  await json('manifest.json', manifest);
  console.log(JSON.stringify(manifest, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/content-safety/toxiccn-import.ts')) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'IMPORT_FAILED'); process.exitCode = 1; });
}
