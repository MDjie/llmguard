import { describe, expect, it } from 'vitest';
import { mediaManifestSchema, parseMediaManifest, summarizeMediaManifest } from '@/lib/evaluation/media-manifest';
const ref = { artifactId: '00000000-0000-4000-8000-000000000001', sha256: 'a'.repeat(64), kind: 'IMAGE' };
const item = { caseId: 'png', semanticGroup: 'same-image', lineageId: 'reviewed-source-1', expectedLabel: 'BENIGN', artifacts: [ref], inputText: '' };
describe('media manifests preserve semantic identity', () => {
  it('loads JSON media refs from CSV and TSV without accepting arbitrary URLs', () => {
    for (const delimiter of [',','\t']) {
      const cell = '"' + JSON.stringify([ref]).replaceAll('"','""') + '"';
      const manifest = parseMediaManifest(delimiter === ',' ? 'test.csv' : 'test.tsv', ['caseId','semanticGroup','lineageId','expectedLabel','artifacts'].join(delimiter) + '\n' + ['one','group','lineage','UNKNOWN',cell].join(delimiter));
      expect(manifest.cases[0].artifacts[0]).toEqual(ref);
    }
    expect(mediaManifestSchema.safeParse({ version: 'media-evaluation-1', cases: [{ ...item, artifacts: [{ url: 'https://example.com' }] }] }).success).toBe(false);
  });
  it('counts equivalent containers once and separates FPR from FDR', () => {
    const manifest = mediaManifestSchema.parse({ version: 'media-evaluation-1', cases: [item, { ...item, caseId: 'jpg' }, { ...item, caseId: 'risk', semanticGroup: 'risk', expectedLabel: 'ATTACK' }] });
    const summary = summarizeMediaManifest(manifest, manifest.cases.map(c => ({ caseId: c.caseId, status: 'COMPLETE', action: 'BLOCK', qualified: true })));
    expect(summary.evaluatedGroups).toBe(2); expect(summary.fpr).toBe(1); expect(summary.fdr).toBe(0.5); expect(summary.qualityAccepted).toBe(false);
  });
  it('excludes the whole group for technical failure, unqualified models, unknown labels or inconsistent variants', () => {
    const manifest = mediaManifestSchema.parse({ version: 'media-evaluation-1', cases: [item, { ...item, caseId: 'jpg' }] });
    const base = { caseId: 'png', status: 'COMPLETE' as const, action: 'ALLOW', qualified: true };
    for (const variant of [{ ...base, caseId: 'jpg', status: 'FAILED' as const }, { ...base, caseId: 'jpg', qualified: false }, { ...base, caseId: 'jpg', action: 'BLOCK' }]) {
      const summary = summarizeMediaManifest(manifest, [base, variant]); expect(summary.evaluatedGroups).toBe(0); expect(summary.accuracy).toBeNull();
    }
  });
  it('rejects conflicting labels in a semantic group', () => {
    expect(mediaManifestSchema.safeParse({ version: 'media-evaluation-1', cases: [item, { ...item, caseId: 'other', expectedLabel: 'ATTACK' }] }).success).toBe(false);
  });
});
