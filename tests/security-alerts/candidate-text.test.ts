import {describe,it,expect} from 'vitest';
import {selectCandidateText} from '../../src/lib/security-alerts/candidate-text';
describe('approved candidate text selection',()=>{
 const views=[{parts:[{text:'first source'}]},{parts:[{text:'second source'}]}];
 it('requires an explicit selection when multiple views match',()=>{expect(()=>selectCandidateText('{}','MATCHED_EVIDENCE',views)).toThrow('EXPLICIT_SOURCE');expect(selectCandidateText('{}','MATCHED_EVIDENCE/1',views)).toBe('second source');expect(()=>selectCandidateText('{}','MATCHED_EVIDENCE/7',views)).toThrow('SELECTOR_INVALID');});
 it('resolves escaped own JSON pointers but rejects prototype traversal and nontext',()=>{expect(selectCandidateText('{"a/b":{"~name":"allowed"}}','/a~1b/~0name',[])).toBe('allowed');for(const pointer of ['/constructor','/__proto__','/a~2b','/x'])expect(()=>selectCandidateText('{"x":{}}',pointer,[])).toThrow();});
 it('enforces text budgets and refuses empty candidate material',()=>{expect(()=>selectCandidateText('','MATCHED_EVIDENCE',[{parts:[{text:'x'.repeat(16001)}]}])).toThrow('BUDGET');expect(()=>selectCandidateText('','MATCHED_EVIDENCE',[{parts:[{text:' '}]}])).toThrow('BUDGET');});
});
