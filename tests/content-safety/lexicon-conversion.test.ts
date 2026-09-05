import { describe,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { convertLexiconSources,extractLegacySql,type ConversionSource } from '../../src/lib/policy-governance/lexicon-conversion';
const source:ConversionSource={sourceId:'s',path:'fixture',format:'master-jsonl',sha256:'a'.repeat(64),license:'test',authorizedUse:'candidate_only',riskMapping:{}};
function input(content:string){return {source:{...source,sha256:createHash('sha256').update(content).digest('hex')},content};}
describe('controlled lexicon conversion',()=>{
  it('reconciles metadata, duplicates, invalid records and unclassified candidates',()=>{
    const rows=[{_type:'manifest'},...['MARKER','ＭＡＲＫＥＲ'].map(canonical=>({_type:'term',canonical,risk_ids:['self_harm']})),{canonical:'unmapped'},null];
    const result=convertLexiconSources([input(rows.map(r=>JSON.stringify(r)).join('\n'))]);
    expect(result.counts).toMatchObject({inputRows:4,metadataRows:1,acceptedRows:1,duplicateRows:1,quarantinedRows:1,rejectedRows:1});
    expect(result.candidates[0].sourceRefs).toHaveLength(2);expect(result.productionEligible).toBe(false);
  });
  it('extracts data and escaped quotes without executing arbitrary SQL',()=>{
    const sql="-- harmless fixture\nINSERT INTO x VALUES ('Sensitive-lexicon测试', '{\"keywords\":[\"marker\",\"it''s\"],\"total_count\":9}'::jsonb); DROP TABLE imaginary;";
    const result=extractLegacySql(sql);
    expect(result.records).toHaveLength(2);expect(result.truncations[0]).toMatchObject({declared:9,available:2});
    expect(result.records[1].value).toMatchObject({canonical:"it's"});
  });
  it('retains distinct risks instead of dropping cross-risk entries',()=>{
    const result=convertLexiconSources([input([{canonical:'marker',risk_ids:['self_harm']},{canonical:'marker',risk_ids:['prompt_injection']}].map(r=>JSON.stringify(r)).join('\n'))]);
    expect(result.candidates).toHaveLength(2);expect(result.counts.duplicateRows).toBe(0);
  });
  it('quarantines unsafe regex and rejects unterminated SQL',()=>{
    const result=convertLexiconSources([input(JSON.stringify({canonical:'(?=unsafe)',match_mode:'regex',risk_ids:['self_harm']}))]);
    expect(result.candidates[0].issues).toContain('UNSAFE_PATTERN');
    expect(()=>extractLegacySql("select 'unfinished")).toThrow('UNTERMINATED');
  });
  it('rejects modified source bytes before conversion',()=>{
    expect(()=>convertLexiconSources([{source,content:'modified'}])).toThrow('CONVERSION_SOURCE_HASH_INVALID');
  });
});
