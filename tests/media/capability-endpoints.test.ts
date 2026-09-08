import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../../src/lib/egress',()=>({safeFetchJson:vi.fn(),ProviderEndpointPolicy:class{}}));
import {safeFetchJson} from '../../src/lib/egress';
import {readMediaCapabilities} from '../../src/lib/media/capabilities';
const capabilities={version:'test',checkedAt:'2026-09-09T00:00:00Z',decoding:{ffmpeg:true,office:true,pdf:true,ocr:true},codecAvailability:{},adapters:{asr:true,visual:true,audioClassifier:true},decoders:['png']};
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
describe('independent analyzer endpoint readiness',()=>{
 it('does not infer audio service availability from the document service',async()=>{
  vi.stubEnv('MULTIMODAL_ANALYZER_BASE_URL','http://document.test');vi.stubEnv('MEDIA_ANALYZER_BASE_URL','');vi.stubEnv('ANALYZER_SHARED_TOKEN','x'.repeat(40));vi.mocked(safeFetchJson).mockResolvedValue(capabilities);
  const result=await readMediaCapabilities();expect(result.unavailableReason).toBe('MEDIA_ANALYZER_UNAVAILABLE');expect(result.effectiveFormats.filter(f=>f.pipeline==='audio').every(f=>f.decode==='UNAVAILABLE')).toBe(true);expect(result.effectiveFormats.find(f=>f.id==='png')?.decode).toBe('AVAILABLE');
 });
 it('rejects malformed capability responses instead of marking a service available',async()=>{
  vi.stubEnv('MULTIMODAL_ANALYZER_BASE_URL','http://document.test');vi.stubEnv('MEDIA_ANALYZER_BASE_URL','http://media.test');vi.stubEnv('ANALYZER_SHARED_TOKEN','x'.repeat(40));vi.mocked(safeFetchJson).mockResolvedValue({adapters:{visual:true}});expect((await readMediaCapabilities()).unavailableReason).toBe('ANALYZER_UNAVAILABLE');
 });
 it('keeps text independently available when both analyzers are absent',async()=>{
  vi.stubEnv('MULTIMODAL_ANALYZER_BASE_URL','');vi.stubEnv('MEDIA_ANALYZER_BASE_URL','');const result=await readMediaCapabilities();expect(result.unavailableReason).toBe('ANALYZER_UNAVAILABLE');expect(result.effectiveFormats.filter(f=>f.pipeline==='text').every(f=>f.decode==='AVAILABLE')).toBe(true);
 });
});
