import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { projectionFailureCode } from '../../src/lib/security-alerts/projection-errors';
describe('alert projection failure isolation',()=>{
 it('isolates schema, digest and wrapped data errors without saving exception content',()=>{
  const invalid=z.object({version:z.literal('1.0')}).safeParse({version:'private'});
  expect(projectionFailureCode(invalid.error)).toBe('DECISION_RECORD_SCHEMA_INVALID');
  expect(projectionFailureCode(new Error('DECISION_RECORD_INTEGRITY_FAILED'))).toBe('DECISION_RECORD_INTEGRITY_FAILED');
  expect(projectionFailureCode(new Error('sensitive query',{cause:{code:'23503',detail:'sensitive value'}}))).toBe('PROJECTION_DATA_23503');
 });
 it('retries database availability and transaction faults instead of discarding records',()=>{
  for(const code of ['08006','40001','40P01','53100','57014','P0001'])expect(projectionFailureCode({code})).toBeNull();
  expect(projectionFailureCode(new Error('secret'))).toBeNull();
 });
 it('bounds exception traversal and tolerates cycles',()=>{
  const error:{cause?:unknown}={};error.cause=error;expect(projectionFailureCode(error)).toBeNull();
 });
});
