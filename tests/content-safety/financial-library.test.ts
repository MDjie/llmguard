import { describe,it,expect } from 'vitest';
import data from '../../data/content-safety/financial/financial-contexts.v1.1.json';
import { buildFinancialCandidates,financialBusinessSchema } from '@/lib/policy-governance/financial-library';
import { validateDictionaryManifest } from '@/lib/policy-governance/validation';
import { validateDataset } from '@/lib/evaluation/optimization-dataset';
describe('financial context candidate package',()=>{
 it('covers eight business lines with risky and normal examples of the same term',()=>{
  const result=buildFinancialCandidates(data);expect(result.manifest.entries).toHaveLength(24);
  for(const line of financialBusinessSchema.options)expect(result.businessCoverage[line]).toBeGreaterThanOrEqual(3);
  expect(result.manifest.entries.every(entry=>entry.contextCases?.length===2)).toBe(true);
  expect(validateDictionaryManifest(result.manifest).passed).toBe(true);
 });
 it('keeps normal examples out of a global whitelist and never invents review approval',()=>{
  const result=buildFinancialCandidates(data);expect(result.normalContextPolicy).toMatchObject({globalAllowRules:0,platformRedlineOverrides:0});
  expect(result.manifest.entries.every(entry=>!entry.mandatoryDeny)).toBe(true);
  expect(result.workbench.records.every(record=>record.reviews.length===0&&record.origin==='synthetic'&&record.case.annotationStatus==='needs_review')).toBe(true);
  expect(result.qualityState).toBe('INDEPENDENT_REVIEW_REQUIRED');
 });
 it('keeps context pairs and their lineage in one split before any model tuning',()=>{
  const records=buildFinancialCandidates(data).workbench.records;expect(records).toHaveLength(48);
  const report=validateDataset(records.map(record=>record.case));expect(report.valid).toBe(true);
  for(const term of data.terms){const pair=records.filter(record=>record.case.caseId.startsWith(term.termId+'.'));expect(new Set(pair.map(record=>record.case.split)).size).toBe(1);expect(new Set(pair.map(record=>record.case.groupId)).size).toBe(1);}
 });
 it('rejects unknown risks, missing context pairs and duplicate identities',()=>{
  expect(()=>buildFinancialCandidates({...data,terms:[{...data.terms[0],normalExample:'查询公开的营业网点工作时间'}]})).toThrow('MINIMAL_CONTEXT_PAIR');
  expect(()=>buildFinancialCandidates({...data,terms:[{...data.terms[0],riskId:'made_up_finance_law'}]})).toThrow('RISK_DEFINITION_UNKNOWN');
  expect(()=>buildFinancialCandidates({...data,terms:[data.terms[0],data.terms[0]]})).toThrow('TERM_DUPLICATE');
 });
});
