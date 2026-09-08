import {afterEach,describe,expect,it,vi} from 'vitest';
import {readMediaCapabilities} from '@/lib/media/capabilities';
import {MEDIA_FORMATS,MEDIA_LIMITS} from '@/lib/media/formats/registry';
const fetchJson=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/egress',()=>({safeFetchJson:fetchJson,ProviderEndpointPolicy:class {}}));
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
describe('shared legacy/new capability projection',()=>{
 it('keeps the catalog while clearly reporting a missing analyzer',async()=>{
  vi.stubEnv('MULTIMODAL_ANALYZER_BASE_URL','');vi.stubEnv('MEDIA_ANALYZER_BASE_URL','');
  const result=await readMediaCapabilities();
  expect(result.formats).toEqual(MEDIA_FORMATS);expect(result.limits).toEqual(MEDIA_LIMITS);
  expect(result.unavailableReason).toBe('ANALYZER_UNAVAILABLE');expect(fetchJson).not.toHaveBeenCalled();
 });
 it('does not equate configured adapters with semantic qualification',async()=>{
  vi.stubEnv('MULTIMODAL_ANALYZER_BASE_URL','https://analyzer.test');vi.stubEnv('ANALYZER_SHARED_TOKEN','t'.repeat(32));
  vi.stubEnv('MEDIA_ANALYZER_BASE_URL','https://analyzer.test');
  fetchJson.mockResolvedValue({version:'test',checkedAt:'2026-09-09T00:00:00Z',decoding:{ffmpeg:true},codecAvailability:{},adapters:{asr:true,visual:true}});
  const result=await readMediaCapabilities();expect(result.unavailableReason).toBeNull();
  expect(result.qualification).toBe('POLICY_AND_MODEL_APPROVAL_REQUIRED');
 });
 it('preserves cancellation rather than converting it to unavailable',async()=>{
  vi.stubEnv('MULTIMODAL_ANALYZER_BASE_URL','https://analyzer.test');vi.stubEnv('ANALYZER_SHARED_TOKEN','t'.repeat(32));
  const controller=new AbortController();controller.abort(new Error('cancelled'));
  fetchJson.mockRejectedValue(new Error('transport failed'));
  await expect(readMediaCapabilities(controller.signal)).rejects.toThrow('cancelled');
 });
});
