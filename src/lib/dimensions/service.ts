import { and, eq, or, desc } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiProblem } from '@/lib/api-security';
import { db } from '@/storage/database/shared/db';
import { detectionDimensions, detectionRules, policyRules, ruleGroups } from '@/storage/database/shared/schema';
import { scopePredicate, type TenantContext } from '@/lib/tenancy';
import { clearPolicyCache } from '@/lib/detection/dynamic-engine';
import { createDimensionSchema, updateDimensionSchema, createRuleSchema, updateRuleSchema, ruleFieldsSchema } from '@/contracts/http/dimensions';
import { normalizeRule, testLocalRules } from './rule-validation';

function problem(status: 400 | 404 | 409, code: string, detail: string) { return new ApiProblem({ status, code, title: '检测配置操作失败', detail }); }
export async function findDimension(scope: TenantContext, id: string) {
  const [row] = await db.select().from(detectionDimensions).where(and(scopePredicate(detectionDimensions,scope),or(eq(detectionDimensions.id,id),eq(detectionDimensions.code,id)))).limit(1);
  if (!row) throw problem(404,'DIMENSION_NOT_FOUND','当前应用中不存在该检测维度');
  return row;
}
export async function listDimensions(scope: TenantContext) {
  const [dimensions,rules] = await Promise.all([
    db.select().from(detectionDimensions).where(scopePredicate(detectionDimensions,scope)).orderBy(desc(detectionDimensions.priority)),
    db.select({dimensionId:detectionRules.dimensionId}).from(detectionRules).where(scopePredicate(detectionRules,scope)),
  ]);
  const counts = new Map<string,number>();
  for (const rule of rules) counts.set(rule.dimensionId,(counts.get(rule.dimensionId)??0)+1);
  return dimensions.map(row=>({...row,ruleCount:counts.get(row.id)??0,groupCount:0}));
}
export async function dimensionDetail(scope: TenantContext,id:string) {
  const dimension=await findDimension(scope,id);
  const [rules,groups]=await Promise.all([
    db.select().from(detectionRules).where(and(scopePredicate(detectionRules,scope),eq(detectionRules.dimensionId,dimension.id))).orderBy(desc(detectionRules.priority)),
    db.select().from(ruleGroups).where(and(scopePredicate(ruleGroups,scope),eq(ruleGroups.dimensionId,dimension.id))),
  ]);
  return {...dimension,rules:rules.map(row=>({...row,groupName:groups.find(group=>group.id===row.groupId)?.name??null})),ruleGroups:groups,ruleCount:rules.length};
}
function postgresCode(error:unknown):string|undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return 'cause' in error ? postgresCode(error.cause) : undefined;
}
export async function createDimension(scope:TenantContext,input:z.infer<typeof createDimensionSchema>) {
  try {
    const [row]=await db.insert(detectionDimensions).values({...input,tenantId:scope.tenantId,applicationId:scope.applicationId,weight:String(input.weight),isSystem:false}).returning();
    if(!row) throw new Error('Dimension insert returned no row');
    clearPolicyCache();return {...row,ruleCount:0,groupCount:0};
  } catch(error) { if(postgresCode(error)==='23505') throw problem(409,'DIMENSION_CODE_EXISTS','当前应用已存在此维度编码，请使用其他编码');throw error; }
}
export async function updateDimension(scope:TenantContext,id:string,input:z.infer<typeof updateDimensionSchema>) {
  const dimension=await findDimension(scope,id);
  const [row]=await db.update(detectionDimensions).set({...input,weight:input.weight===undefined?undefined:String(input.weight),updatedAt:new Date()}).where(and(scopePredicate(detectionDimensions,scope),eq(detectionDimensions.id,dimension.id))).returning();
  if(!row)throw problem(404,'DIMENSION_NOT_FOUND','维度已被删除，请刷新后重试');clearPolicyCache();return row;
}
export async function deleteDimension(scope:TenantContext,id:string) {
  await db.transaction(async tx=>{
    const [dimension]=await tx.select().from(detectionDimensions).where(and(scopePredicate(detectionDimensions,scope),or(eq(detectionDimensions.id,id),eq(detectionDimensions.code,id)))).limit(1).for('update');
    if(!dimension)throw problem(404,'DIMENSION_NOT_FOUND','维度不存在');
    if(dimension.isSystem)throw problem(409,'SYSTEM_DIMENSION_PROTECTED','系统内置维度不能删除，可停用');
    await tx.delete(policyRules).where(and(scopePredicate(policyRules,scope),eq(policyRules.dimension,dimension.code)));
    await tx.delete(detectionDimensions).where(and(scopePredicate(detectionDimensions,scope),eq(detectionDimensions.id,dimension.id)));
  });clearPolicyCache();
}
async function validateGroup(scope:TenantContext,dimensionId:string,groupId:string|null|undefined) {
  if(!groupId)return;
  const [group]=await db.select({id:ruleGroups.id}).from(ruleGroups).where(and(scopePredicate(ruleGroups,scope),eq(ruleGroups.dimensionId,dimensionId),eq(ruleGroups.id,groupId))).limit(1);
  if(!group)throw problem(400,'RULE_GROUP_INVALID','规则组不属于当前维度');
}
function validatedRule(input:z.infer<typeof ruleFieldsSchema>) {
  try{return normalizeRule(input);}catch(error){throw problem(400,'RULE_PATTERN_INVALID',error instanceof Error?error.message:'规则配置无效');}
}
export async function createRule(scope:TenantContext,id:string,input:z.infer<typeof createRuleSchema>) {
  const dimension=await findDimension(scope,id),body=validatedRule(input);
  await validateGroup(scope,dimension.id,body.groupId);
  const [row]=await db.insert(detectionRules).values({...body,tenantId:scope.tenantId,applicationId:scope.applicationId,dimensionId:dimension.id,score:String(body.score),confidence:String(body.confidence)}).returning();
  if(!row)throw new Error('Rule insert returned no row');clearPolicyCache();return row;
}
export async function findRule(scope:TenantContext,id:string,ruleId:string) {
  const dimension=await findDimension(scope,id);
  const [row]=await db.select().from(detectionRules).where(and(scopePredicate(detectionRules,scope),eq(detectionRules.dimensionId,dimension.id),eq(detectionRules.id,ruleId))).limit(1);
  if(!row)throw problem(404,'RULE_NOT_FOUND','当前维度中不存在该规则');return row;
}
export async function updateRule(scope:TenantContext,id:string,ruleId:string,input:z.infer<typeof updateRuleSchema>) {
  const current=await findRule(scope,id,ruleId);
  // Older seeded rules use confidence percentages. Present and persist normalized [0,1] values.
  const confidence=Number(current.confidence);
  const merged=ruleFieldsSchema.parse({name:current.name,type:current.type,pattern:current.pattern??'',matchType:current.matchType,caseSensitive:current.caseSensitive,score:Number(current.score),confidence:confidence>1?confidence/100:confidence,priority:current.priority,enabled:current.enabled,description:current.description??'',suggestion:current.suggestion??'',config:current.config??{},groupId:current.groupId,...input});
  const body=validatedRule(merged);await validateGroup(scope,current.dimensionId,body.groupId);
  const [row]=await db.update(detectionRules).set({...input,score:input.score===undefined?undefined:String(body.score),confidence:input.confidence===undefined?undefined:String(body.confidence),matchType:input.type!==undefined||input.matchType!==undefined?body.matchType:undefined}).where(and(scopePredicate(detectionRules,scope),eq(detectionRules.dimensionId,current.dimensionId),eq(detectionRules.id,ruleId))).returning();
  if(!row)throw problem(404,'RULE_NOT_FOUND','规则已被删除，请刷新后重试');clearPolicyCache();return row;
}
export async function deleteRule(scope:TenantContext,id:string,ruleId:string) {
  const current=await findRule(scope,id,ruleId);
  const rows=await db.delete(detectionRules).where(and(scopePredicate(detectionRules,scope),eq(detectionRules.dimensionId,current.dimensionId),eq(detectionRules.id,ruleId))).returning({id:detectionRules.id});
  if(!rows.length)throw problem(404,'RULE_NOT_FOUND','规则已被删除');clearPolicyCache();
}
export async function testDimension(scope:TenantContext,id:string,text:string) {
  const dimension=await dimensionDetail(scope,id);
  return {...testLocalRules(text,dimension.rules,Number(dimension.weight)),dimension:{id:dimension.id,code:dimension.code,name:dimension.name,enabled:dimension.enabled},text};
}
