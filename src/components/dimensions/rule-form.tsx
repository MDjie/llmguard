import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface RuleFormValue { name:string;type:string;pattern:string;matchType:string;caseSensitive:boolean;score:string;confidence:string;priority:string;description:string;suggestion:string }
export function RuleForm({value,onChange}:{value:RuleFormValue;onChange:(value:RuleFormValue)=>void}) {
  return <div className="space-y-4 py-4">
    <div className="space-y-2"><Label>规则名称</Label><Input aria-label="规则名称" maxLength={100} value={value.name} onChange={event=>onChange({...value,name:event.target.value})}/></div>
    <div className="space-y-2"><Label>规则类型</Label><Select value={value.type} onValueChange={type=>onChange({...value,type,matchType:type==='regex'?'regex':'contains'})}><SelectTrigger aria-label="规则类型"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="keyword">关键词</SelectItem><SelectItem value="regex">正则表达式</SelectItem><SelectItem value="semantic">语义分析</SelectItem><SelectItem value="llm">LLM 判断</SelectItem></SelectContent></Select></div>
    <div className="space-y-2"><Label>匹配内容</Label><Textarea aria-label="匹配内容" maxLength={4096} value={value.pattern} onChange={event=>onChange({...value,pattern:event.target.value})}/></div>
    <div className="space-y-2"><Label>匹配方式</Label><Select disabled={value.type==='regex'} value={value.type==='regex'?'regex':value.matchType} onValueChange={matchType=>onChange({...value,matchType})}><SelectTrigger aria-label="匹配方式"><SelectValue/></SelectTrigger><SelectContent>{Object.entries({contains:'包含',exact:'精确匹配',prefix:'前缀匹配',suffix:'后缀匹配',regex:'正则表达式'}).map(([key,label])=><SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select></div>
    <div className="grid grid-cols-3 gap-3">{([{key:'score',label:'风险分数',max:100,step:0.1},{key:'confidence',label:'置信度',max:1,step:0.01},{key:'priority',label:'优先级',max:10000,step:1}] as const).map(field=><div key={field.key} className="space-y-2"><Label>{field.label}</Label><Input aria-label={field.label} type="number" min={0} max={field.max} step={field.step} value={value[field.key]} onChange={event=>onChange({...value,[field.key]:event.target.value})}/></div>)}</div>
    <div className="flex items-center gap-2"><Switch aria-label="区分大小写" checked={value.caseSensitive} onCheckedChange={caseSensitive=>onChange({...value,caseSensitive})}/><Label>区分大小写</Label></div>
    <div className="space-y-2"><Label>描述</Label><Textarea aria-label="规则描述" maxLength={2000} value={value.description} onChange={event=>onChange({...value,description:event.target.value})}/></div>
    <div className="space-y-2"><Label>修复建议</Label><Textarea aria-label="修复建议" maxLength={2000} value={value.suggestion} onChange={event=>onChange({...value,suggestion:event.target.value})}/></div>
    {['semantic','llm'].includes(value.type)&&<p className="text-sm text-muted-foreground">语义规则需配置相应检测后端，通过策略验证执行；维度快速测试仅执行关键词和正则。</p>}
  </div>;
}
