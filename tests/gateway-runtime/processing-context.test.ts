import { expect,it,vi } from 'vitest';
import { readProcessingContext } from '@/lib/gateway-runtime/processing-context';
const receipt=vi.hoisted(()=>({value:{} as unknown}));
vi.mock('@/lib/gateway-runtime/security',()=>({openReceipt:()=>receipt.value}));
it('accepts an archived prepared request without treating it as guard segments',()=>{
 receipt.value={inputSegments:[],preparedRequest:{model:'test',messages:[{role:'user',content:'archived original'}]}};
 expect(readProcessingContext({id:'test',sessionSnapshot:[]} as unknown as Parameters<typeof readProcessingContext>[0])).toEqual({inputSegments:[],nativeExecution:false});
});
it('continues rejecting unrecognized processing context fields',()=>{
 receipt.value={inputSegments:[],untrustedFutureField:true};
 expect(()=>readProcessingContext({id:'test',sessionSnapshot:[]} as unknown as Parameters<typeof readProcessingContext>[0])).toThrow();
});
