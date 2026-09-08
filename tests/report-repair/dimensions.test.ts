import { describe,expect,it } from 'vitest';
import { createDimensionSchema,createRuleSchema,updateRuleSchema } from '@/contracts/http/dimensions';
import { normalizeRule,testLocalRules } from '@/lib/dimensions/rule-validation';
import { apiErrorMessage } from '@/lib/api-client-error';
import { permissionsForRole } from '@/lib/auth/authorization';

describe('September report dimension regressions',()=>{
  it('validates database field lengths and supplies a usable default category',()=>{
    expect(createDimensionSchema.parse({code:'custom_test',name:'测试'}).category).toBe('custom');
    expect(createDimensionSchema.safeParse({code:'x',name:'a'.repeat(101)}).success).toBe(false);
    expect(createDimensionSchema.safeParse({code:'a'.repeat(51),name:'测试'}).success).toBe(false);
    expect(createDimensionSchema.safeParse({code:'x',name:'测试',category:''}).success).toBe(false);
  });
  it('accepts the same editable rule type and preserves zero values',()=>{
    const input={name:'测试',type:'keyword',pattern:'hello',score:0,confidence:0,priority:0};
    expect(createRuleSchema.parse(input)).toMatchObject({score:0,confidence:0,priority:0});
    expect(updateRuleSchema.parse(input).type).toBe('keyword');
    expect(updateRuleSchema.parse({enabled:false})).toEqual({enabled:false});
  });
  it('forces regex matching and preserves uppercase escape meaning',()=>{
    const normalized=normalizeRule(createRuleSchema.parse({name:'非数字',type:'regex',pattern:'\\D+',matchType:'contains'}));
    const rule={...normalized,id:'r',enabled:true};
    expect(normalized.matchType).toBe('regex');
    expect(testLocalRules('ABC',[rule],1).matchedCount).toBe(1);
    expect(testLocalRules('123',[rule],1).matchedCount).toBe(0);
    expect(()=>normalizeRule({...normalized,pattern:'('})).toThrow('正则表达式');
  });
  it('skips disabled rules and reports unsupported semantic tests explicitly',()=>{
    const rule={...createRuleSchema.parse({name:'x',type:'keyword',pattern:'hello',score:50}),id:'r'};
    expect(testLocalRules('hello',[{...rule,enabled:false}],1).matchedCount).toBe(0);
    expect(testLocalRules('hello',[rule,{...rule,id:'s',type:'semantic'}],1)).toMatchObject({ruleCount:1,matchedCount:1,skippedRules:[{id:'s'}]});
    expect(testLocalRules('hello',[rule,{...rule,id:'second'}],1).score).toBe(60);
  });
  it('renders standard problem errors and restricts writes to administrators',()=>{
    expect(apiErrorMessage({code:'PERMISSION_DENIED',detail:'forbidden'})).toContain('权限');
    expect(apiErrorMessage({code:'DIMENSION_CODE_EXISTS',detail:'编码重复'})).toBe('编码重复');
    for(const role of ['AUDIT_ADMIN','BUSINESS_OPERATOR','APP_DEVELOPER','READ_ONLY'] as const)expect(permissionsForRole(role)).not.toContain('policy:manage');
    expect(permissionsForRole('SECURITY_ADMIN')).toContain('policy:manage');
    expect(permissionsForRole('SECURITY_ADMIN')).not.toContain('observability:metrics:read');
  });
});
