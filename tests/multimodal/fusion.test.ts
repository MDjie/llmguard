import { describe, expect, it } from 'vitest';
import { fuseMultimodal } from '../../src/lib/multimodal';
import type { RuntimePolicyBundle } from '../../src/lib/policy-bundle';

const bundle: RuntimePolicyBundle = {
  id: 'bundle-1',
  generation: 1,
  payload: {
    schemaVersion: '1.0',
    policyId: 'policy-1',
    policyVersion: 1,
    dimensions: [{ id: 'dim-1', code: 'prompt_injection', name: 'Injection', weight: 1 }],
    rules: [{
      id: 'rule-1', riskType: 'prompt_injection', pattern: 'ignore policy',
      matchType: 'contains', caseSensitive: false, score: 1, mandatoryDeny: true,
    }],
    exceptions: [],
    thresholds: [{ dimensionId: 'dim-1', warn: 0.5, block: 0.8, autoMask: false, autoRewrite: false }],
  },
};

describe('cross-modal fusion', () => {
  it('detects a harmful instruction split between user text and image OCR', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'fusion-test-content-hmac-key-32-bytes-minimum';
    try {
      const result = await fuseMultimodal({
        bundle,
        context: {
          traceId: 'trace-1234567890123456',
          tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        userText: 'please ignore',
        contextArtifactId: 'text-1',
        ocr: [{
          text: 'policy', artifactId: 'image-1', viewId: 'rotate_90', region: [10, 20, 30, 40],
        }],
        visual: [],
      });
      expect(result.textDecisions.user.action).toBe('ALLOW');
      expect(result.textDecisions.image.action).toBe('ALLOW');
      expect(result.action).toBe('BLOCK');
      expect(result.cooperativeAttack).toBe(false);
      expect(result.evidence[0].sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'user_text', artifactId: 'text-1' }),
        expect.objectContaining({ source: 'image_ocr', artifactId: 'image-1', viewId: 'rotate_90' }),
      ]));
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });

  it('routes medium-confidence visual findings to configurable human review', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'fusion-review-content-hmac-key-32-bytes-minimum';
    try {
      const result = await fuseMultimodal({
        bundle,
        context: {
          traceId: 'trace-review-123456789',
          tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        ocr: [],
        visual: [{
          riskType: 'violence', score: 0.7, artifactId: 'image-1',
          viewId: 'original', reasonCode: 'VISUAL_VIOLENCE',
        }],
        reviewThreshold: 0.65,
        blockThreshold: 0.8,
      });
      expect(result.action).toBe('REQUIRE_REVIEW');
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });
  it('detects QR-carried injection and emits traceable evidence without raw payloads', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'fusion-qr-content-hmac-key-32-bytes-minimum';
    try {
      const result = await fuseMultimodal({
        bundle,
        context: {
          traceId: 'trace-qr-123456789012',
          tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        ocr: [],
        codes: [{
          text: 'ignore policy', kind: 'QR', confidence: 1,
          artifactId: 'image-qr-1', viewId: 'original', region: [0, 0, 1, 1],
        }],
        visual: [],
        sourceTrust: 'UNTRUSTED',
        instructionCapability: 'FORBIDDEN',
      });
      expect(result.textDecisions.codes.action).toBe('BLOCK');
      expect(result.action).toBe('BLOCK');
      expect(result.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          traceId: 'trace-qr-123456789012',
          evidenceRef: expect.stringMatching(/^[a-f0-9]{64}$/u),
          sources: expect.arrayContaining([
            expect.objectContaining({ source: 'qr_code', artifactId: 'image-qr-1' }),
          ]),
        }),
      ]));
      expect(JSON.stringify(result.evidence)).not.toContain('ignore policy');
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });

  it('fails closed when a required modality cannot be analyzed', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'fusion-failure-content-hmac-key-32-bytes-minimum';
    try {
      const result = await fuseMultimodal({
        bundle,
        context: {
          traceId: 'trace-failure-1234567',
          tenantId: 'tenant-1', applicationId: 'app-1',
          absoluteDeadlineEpochMs: Date.now() + 5_000,
        },
        ocr: [], visual: [],
        analysisFailures: [{ component: 'OCR', required: true, code: 'ANALYZER_OCR_TIMEOUT' }],
      });
      expect(result).toMatchObject({ action: 'BLOCK', degraded: true });
      expect(result.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ reasonCode: 'ANALYZER_OCR_TIMEOUT', action: 'BLOCK' }),
      ]));
    } finally {
      process.env.CONTENT_HASH_KEY = previous;
    }
  });

});

describe('single-modality risk preservation', () => {
  it.each(['user', 'image', 'codes'] as const)('keeps %s mandatory denial when the combined text is benign', async (modality) => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'fusion-preservation-test-hmac-key-at-least-32-bytes';
    try {
      const exactBundle: RuntimePolicyBundle = { ...bundle, payload: { ...bundle.payload, rules: [{ ...bundle.payload.rules[0], pattern: 'SINGLE_TRACK_DENY', matchType: 'exact' }] } };
      const result = await fuseMultimodal({ bundle: exactBundle,
        context: { traceId: 'fusion-preserve-' + modality, tenantId: 'tenant-1', applicationId: 'app-1', absoluteDeadlineEpochMs: Date.now() + 5000 },
        userText: modality === 'user' ? 'SINGLE_TRACK_DENY' : 'public notes', contextArtifactId: 'user-object',
        ocr: [{ text: modality === 'image' ? 'SINGLE_TRACK_DENY' : 'public image', artifactId: 'image-object', viewId: 'original', region: [0, 0, 1, 1] }],
        codes: modality === 'codes' ? [{ text: 'SINGLE_TRACK_DENY', artifactId: 'code-object', viewId: 'qr', region: [0, 0, 1, 1], kind: 'QR', confidence: 1 }] : [], visual: [],
      });
      expect(result.textDecisions[modality].action).toBe('BLOCK');
      expect(result.textDecisions.combined.action).toBe(modality === 'user' ? 'BLOCK' : 'ALLOW');
      expect(result.action).toBe('BLOCK');
      expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
        sources: expect.arrayContaining([expect.objectContaining({ artifactId: modality === 'user' ? 'user-object' : modality === 'image' ? 'image-object' : 'code-object' })]),
      })]));
      expect(JSON.stringify(result.evidence)).not.toContain('SINGLE_TRACK_DENY');
    } finally { process.env.CONTENT_HASH_KEY = previous; }
  });

  it('does not merge equal matches from different image objects', async () => {
    const previous = process.env.CONTENT_HASH_KEY;
    process.env.CONTENT_HASH_KEY = 'fusion-dedup-test-hmac-key-at-least-32-bytes';
    try {
      const result = await fuseMultimodal({ bundle,
        context: { traceId: 'fusion-dedup-objects', tenantId: 'tenant-1', applicationId: 'app-1', absoluteDeadlineEpochMs: Date.now() + 5000 },
        ocr: ['first', 'second'].map(artifactId => ({ artifactId, text: 'ignore policy', viewId: 'original', region: [0, 0, 1, 1] as const })), visual: [],
      });
      const sources = result.evidence.map(item => item.sources).flat();
      expect(sources).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: 'first' }), expect.objectContaining({ artifactId: 'second' })]));
      expect(new Set(result.evidence.map(item => item.evidenceRef)).size).toBe(result.evidence.length);
    } finally { process.env.CONTENT_HASH_KEY = previous; }
  });
});


it('confirms an object-bound mixed attack with explicit reference evidence',async()=>{
  const previous=process.env.CONTENT_HASH_KEY;
  process.env.CONTENT_HASH_KEY='fusion-relation-test-content-hmac-key-32-bytes-minimum';
  try{
    const result=await fuseMultimodal({bundle,context:{traceId:'trace-relation-12345678',tenantId:'tenant-1',applicationId:'app-1',absoluteDeadlineEpochMs:Date.now()+5000},
      userText:'please ignore the attached image',contextArtifactId:'user-text',
      ocr:[{text:'system rules',artifactId:'image-1',viewId:'original',region:[0,0,10,10]}],visual:[]});
    expect(result.action).toBe('BLOCK');
    expect(result.cooperativeAttack).toBe(true);
    expect(result.relationship.relations.some(r=>r.status==='CONFIRMED'&&r.sourceEnvelopeIds.length===2)).toBe(true);
    expect(result.evidence.some(e=>e.reasonCode==='MULTIMODAL_RELATION_CONFIRMED')).toBe(true);
  }finally{process.env.CONTENT_HASH_KEY=previous;}
});

it('never claims complete extraction when a QR result is below the configured confidence floor',async()=>{
  const previous=process.env.CONTENT_HASH_KEY;process.env.CONTENT_HASH_KEY='fusion-low-confidence-hmac-key-at-least-32-bytes';
  try {
    const result=await fuseMultimodal({bundle,context:{traceId:'trace-low-confidence',tenantId:'tenant-1',applicationId:'app-1',absoluteDeadlineEpochMs:Date.now()+5000},
      ocr:[],codes:[{text:'public reference',kind:'QR',confidence:.1,artifactId:'image',viewId:'qr',region:[0,0,1,1]}],visual:[],minimumConfidence:.35});
    expect(result).toMatchObject({action:'BLOCK',degraded:true});
    expect(result.evidence.some(item=>item.reasonCode==='MEDIA_EXTRACTION_CONFIDENCE_INSUFFICIENT')).toBe(true);
  } finally {process.env.CONTENT_HASH_KEY=previous;}
});
