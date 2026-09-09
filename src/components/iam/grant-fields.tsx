'use client';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { classifications,environments,grantPurposes,type GrantAttributes } from '@/lib/iam/policy';
const purposeLabels:Record<string,string>={operate:'日常操作','raw-evidence':'原文证据',export:'审计导出',catalog:'数据目录','provider-config':'模型配置','application-admin':'应用与凭据管理'};
export function GrantFields({id,name,value,onChange}:{id:string;name:string;value:GrantAttributes;onChange:(value:GrantAttributes)=>void}){
  return <details className="rounded-md border p-3 text-sm"><summary className="cursor-pointer font-medium">{name}：授权属性</summary><div className="mt-3 space-y-3">
    <fieldset><legend className="mb-2 text-muted-foreground">允许环境</legend><div className="flex flex-wrap gap-3">{environments.map(environment=><label className="flex items-center gap-1" key={environment}><input type="checkbox" checked={value.allowedEnvironments.includes(environment)} onChange={event=>onChange({...value,allowedEnvironments:event.target.checked?[...value.allowedEnvironments,environment]:value.allowedEnvironments.filter(item=>item!==environment)})}/>{environment}</label>)}</div></fieldset>
    <div><Label htmlFor={id+'-class'}>最高数据分级</Label><select id={id+'-class'} className="h-9 w-full rounded border bg-background px-2" value={value.maxDataClass} onChange={event=>{const level=classifications.find(item=>item===event.target.value);if(level)onChange({...value,maxDataClass:level});}}>{classifications.map(level=><option value={level} key={level}>{level}</option>)}</select></div>
    <fieldset><legend className="mb-2 text-muted-foreground">允许用途（还需角色具备对应操作权限）</legend><div className="grid grid-cols-2 gap-2">{grantPurposes.map(purpose=><label className="flex items-center gap-1" key={purpose}><input type="checkbox" checked={(value.allowedPurposes??grantPurposes).includes(purpose)} onChange={event=>onChange({...value,allowedPurposes:event.target.checked?[...(value.allowedPurposes??grantPurposes),purpose]:(value.allowedPurposes??grantPurposes).filter(item=>item!==purpose)})}/>{purposeLabels[purpose]}</label>)}</div></fieldset>
    <div><Label htmlFor={id+'-departments'}>应用所属部门（逗号分隔；留空不额外限定）</Label><Input id={id+'-departments'} value={value.allowedDepartments?.join(',')??''} onChange={event=>onChange({...value,allowedDepartments:event.target.value.split(',').map(item=>item.trim()).filter(Boolean)})}/></div>
    <div><Label htmlFor={id+'-groups'}>用户组（逗号分隔）</Label><Input id={id+'-groups'} value={value.userGroupIds.join(',')} onChange={event=>onChange({...value,userGroupIds:event.target.value.split(',').map(item=>item.trim()).filter(Boolean)})}/></div>
  </div></details>;
}
