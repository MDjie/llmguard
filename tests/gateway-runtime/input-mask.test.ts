import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import type {Observation} from '@guardllm/contracts';
import {transformGatewayInput} from '../../src/lib/gateway-runtime/input-mask';
const text='Contact 13800138000';
const base:Observation={detectorId:'structured-dlp',detectorVersion:'1',riskType:'pii.mobile',category:'pii.mobile',status:'MATCH',score:.9,severity:'HIGH',decisionRole:'CONFIRMED_RISK',evidence:[{viewId:'original',start:8,end:19,contentHmac:'a'.repeat(64)}]};
beforeEach(()=>vi.stubEnv('CONTENT_HASH_KEY','input-mask-test-hmac-key-at-least-32-bytes'));
afterEach(()=>vi.unstubAllEnvs());
describe('gateway typed input masking',()=>{
 it('masks a real registered entity',()=>{expect(transformGatewayInput(text,[base]).transformedText).not.toContain('13800138000');});
 it.each(['CANDIDATE','CLEARED','UNKNOWN'] as const)('rejects %s as a transformation producer',decisionRole=>{expect(()=>transformGatewayInput(text,[{...base,decisionRole}])).toThrow('INPUT_TRANSFORM_EVIDENCE_MISSING');});
 it('rejects an arbitrary detector named dlp',()=>{expect(()=>transformGatewayInput(text,[{...base,detectorId:'custom-dlp'}])).toThrow('INPUT_TRANSFORM_EVIDENCE_MISSING');});
 it('rejects corrupt ranges before constructing patches',()=>{expect(()=>transformGatewayInput(text,[{...base,evidence:[{...base.evidence[0],end:200}]}])).toThrow('INPUT_TRANSFORM_ENTITY_INVALID');});
});
