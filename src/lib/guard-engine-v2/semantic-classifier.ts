import { createHash } from 'node:crypto';
import { z } from 'zod';
import { safeFetchJson, type SafeFetchDependencies } from '@/lib/egress/safe-fetch';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import { textEvidence } from './evidence';
import { classifierCoverageSchema, assertClassifierQualification, assertClassifierScope } from './classifier-qualification';
import type { Observation } from './types';
import type {
  GuardDetector,
  GuardDetectorContext,
  SemanticClassifierSpec,
} from './types';

const responseSchema = z.object({
  modelId: z.string().min(1).max(256),
  modelVersion: z.string().min(1).max(256),
  modelSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  items: z.array(z.object({
    id: z.string().min(1).max(256),
    labels: z.array(z.object({
      label: z.string().min(1).max(128),
      confidence: z.number().finite().min(0).max(1),
    }).strict()).max(128),
  }).strict()).max(32),
}).strict();

type ClassifierResponse = z.infer<typeof responseSchema>;

export type SemanticClassifierInvoker = (
  spec: SemanticClassifierSpec,
  items: readonly { readonly id: string; readonly text: string }[],
  signal: AbortSignal,
) => Promise<ClassifierResponse>;

function calibratedConfidence(confidence: number, temperature: number): number {
  const bounded = Math.min(1 - 1e-7, Math.max(1e-7, confidence));
  const logit = Math.log(bounded / (1 - bounded));
  return 1 / (1 + Math.exp(-logit / temperature));
}

function configurationDigest(spec: SemanticClassifierSpec): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

async function defaultInvoker(
  spec: SemanticClassifierSpec,
  items: readonly { readonly id: string; readonly text: string }[],
  signal: AbortSignal,
  dependencies: SafeFetchDependencies = {},
): Promise<ClassifierResponse> {
  const response = await safeFetchJson({
    baseUrl: spec.baseUrl,
    path: spec.path,
    providerType: spec.providerType,
    timeoutMs: spec.timeoutMs,
    maxRequestBytes: spec.maximumRequestBytes,
    maxResponseBytes: spec.maximumResponseBytes,
    signal,
    body: {
      schemaVersion: '1.0',
      operation: 'classify',
      model: {
        id: spec.modelId,
        version: spec.modelVersion,
        sha256: spec.modelSha256,
        quantization: spec.quantization,
      },
      items,
    },
  }, dependencies);
  return responseSchema.parse(response);
}

function assertResponseIdentity(
  spec: SemanticClassifierSpec,
  requestedIds: readonly string[],
  response: ClassifierResponse,
): void {
  if (
    response.modelId !== spec.modelId ||
    response.modelVersion !== spec.modelVersion ||
    response.modelSha256 !== spec.modelSha256
  ) {
    throw new Error('SEMANTIC_CLASSIFIER_MODEL_IDENTITY_MISMATCH');
  }
  const responseIds = response.items.map((item) => item.id);
  if (
    new Set(responseIds).size !== responseIds.length ||
    responseIds.length !== requestedIds.length ||
    requestedIds.some((id) => !responseIds.includes(id))
  ) {
    throw new Error('SEMANTIC_CLASSIFIER_RESPONSE_COVERAGE_INVALID');
  }
}

export class SemanticClassifierDetector implements GuardDetector {
  readonly id: string;
  readonly version: string;
  readonly required: boolean;
  private readonly invoke: SemanticClassifierInvoker;
  private readonly digest: string;

  constructor(
    private readonly spec: SemanticClassifierSpec,
    dependencies: {
      readonly invoke?: SemanticClassifierInvoker;
      readonly safeFetch?: SafeFetchDependencies;
    } = {},
  ) {
    this.id = spec.detectorId;
    this.version = spec.detectorVersion;
    this.required = spec.mode === 'ENFORCE' && spec.failurePolicy === 'FAIL_CLOSED';
    this.digest = configurationDigest(spec);
    this.invoke = dependencies.invoke ?? ((configured, items, signal) =>
      defaultInvoker(configured, items, signal, dependencies.safeFetch));
  }

  async detect(context: GuardDetectorContext) {
    if(this.spec.coverage){
      assertClassifierScope(this.spec,context);
      if(this.spec.mode==='ENFORCE')assertClassifierQualification(this.spec);
    }
    const labelSpecs = new Map(this.spec.labels.map((label) => [label.label, label]));
    const viewsById = new Map(context.views.map((view) => [view.id, view]));
    const observations:Observation[] = [];
    const covered=new Map<string,number>();
    for (let offset = 0; offset < context.views.length; offset += this.spec.batchSize) {
      const batch = context.views.slice(offset, offset + this.spec.batchSize)
        .map((view) => ({ id: view.id, text: view.text }));
      const response = await this.invoke(this.spec, batch, context.signal);
      assertResponseIdentity(this.spec, batch.map((item) => item.id), response);
      for (const item of response.items) {
        const view = viewsById.get(item.id);
        if (!view) throw new Error('SEMANTIC_CLASSIFIER_VIEW_UNKNOWN');
        if(this.spec.coverage && (new Set(item.labels.map(l=>l.label)).size!==item.labels.length ||
          item.labels.length!==this.spec.labels.length || this.spec.labels.some(l=>!item.labels.some(p=>p.label===l.label))))throw new Error('SEMANTIC_CLASSIFIER_LABEL_COVERAGE_INCOMPLETE');
        for (const prediction of item.labels) {
          const label = labelSpecs.get(prediction.label);
          if (!label) throw new Error('SEMANTIC_CLASSIFIER_LABEL_UNKNOWN');
          const score = calibratedConfidence(prediction.confidence, this.spec.temperature);
          covered.set(label.riskType,(covered.get(label.riskType)??0)+1);
          if (score < label.threshold) continue;
          observations.push({
            detectorId: this.id,
            detectorVersion: this.version,
            riskType: label.riskType,
            score,
            severity: label.severity,
            evidence: [textEvidence(context, view, 0, view.text.length, view.text)],
            status: this.spec.mode === 'ENFORCE' ? 'MATCH' as const : 'NO_MATCH' as const,
            reasonCode: this.spec.mode === 'ENFORCE'
              ? 'SEMANTIC_CLASSIFIER_MATCH'
              : 'SEMANTIC_CLASSIFIER_SHADOW_MATCH',
            modelVersion: this.spec.modelId + '@' + this.spec.modelVersion,
            configurationDigest: this.digest,
            ...(this.spec.coverage&&this.spec.mode==='ENFORCE'?{decisionRole:'CONFIRMED_RISK' as const,semanticCoverage:'COMPLETE' as const}:{}),
          });
        }
      }
    }
    if(this.spec.coverage&&this.spec.mode==='ENFORCE'){
      for(const label of this.spec.labels){
        if(observations.some(o=>o.riskType===label.riskType))continue;
        if(!covered.has(label.riskType)||!context.views.length)throw new Error('SEMANTIC_CLASSIFIER_LABEL_COVERAGE_INCOMPLETE');
        observations.push({detectorId:this.id,detectorVersion:this.version,riskType:label.riskType,score:0,severity:'NONE',evidence:[],
          status:'NO_MATCH',decisionRole:'CLEARED',semanticCoverage:'COMPLETE',reasonCode:'SEMANTIC_CLASSIFIER_SAFE',modelVersion:this.spec.modelId+'@'+this.spec.modelVersion,configurationDigest:this.digest});
      }
    }
    return observations;
  }
}

export function semanticClassifierSpecSchema() {
  return z.object({
    coverage: classifierCoverageSchema.optional(),
    detectorId: z.string().min(1).max(128),
    detectorVersion: z.string().min(1).max(64),
    modelId: z.string().min(1).max(256),
    modelVersion: z.string().min(1).max(256),
    modelSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    quantization: z.enum(['FP32', 'FP16', 'BF16', 'INT8', 'INT4']),
    baseUrl: z.url().max(2_048),
    path: z.string().regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,1024}$/),
    providerType: z.enum([
      'openai_compatible', 'deepseek', 'kimi', 'doubao', 'qwen', 'glm', 'ollama', 'custom',
    ]),
    mode: z.enum(['SHADOW', 'ENFORCE']),
    failurePolicy: z.enum(['FAIL_CLOSED', 'DEGRADE']),
    timeoutMs: z.number().int().min(50).max(60_000),
    batchSize: z.number().int().min(1).max(32),
    maximumRequestBytes: z.number().int().min(1_024).max(2 * 1_024 * 1_024),
    maximumResponseBytes: z.number().int().min(1_024).max(2 * 1_024 * 1_024),
    temperature: z.number().finite().min(0.05).max(10),
    labels: z.array(z.object({
      label: z.string().min(1).max(128),
      riskType: z.string().min(1).max(128),
      severity: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
      threshold: z.number().finite().min(0).max(1),
    }).strict()).min(1).max(128),
  }).strict().superRefine((value, context) => {
    if (new Set(value.labels.map((label) => label.label)).size !== value.labels.length) {
      context.addIssue({ code: 'custom', message: 'Semantic classifier labels must be unique' });
    }
    if (value.mode === 'ENFORCE' && value.failurePolicy !== 'FAIL_CLOSED') {
      context.addIssue({ code: 'custom', message: 'Enforced semantic classifiers must fail closed' });
    }
  });
}

export function parseSemanticClassifierBuildConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SemanticClassifierSpec | undefined {
  const raw = environment.SEMANTIC_CLASSIFIER_CONFIG_JSON?.trim();
  if (!raw) return undefined;
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new Error('SEMANTIC_CLASSIFIER_CONFIG_JSON_INVALID');
  }
  return semanticClassifierSpecSchema().parse(candidate);
}
