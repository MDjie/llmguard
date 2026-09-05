import { z } from 'zod';
import { judgeProfileListSchema } from '@/lib/judge/profile';
import { semanticCoveragePolicySchema } from '@/lib/guard-engine-v2/semantic-coverage';

const boundedId = z.string().min(1).max(128);
const dimensionCode = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);
const tags = z.array(z.string().trim().min(1).max(64)).max(50);
const policyThreshold = z.union([
  z.number(),
  z.string().trim().regex(/^\d+(?:\.\d+)?$/).transform(Number),
]).pipe(z.number().int().min(0).max(100));

export const policyParamsSchema = z.object({ id: boundedId });

export const createPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(4_000).default(''),
    tags: tags.default([]),
    cloneFrom: boundedId.optional(),
  })
  .strict();

// GET /api/policies/[id] 合并返回的规则行会附带 policy_id / created_at /
// tenant_id / application_id / dimension_name 等额外字段, 前端"保存更改"会原样
// 回传给 PUT /api/policies。因此这里(1)不做 .strict(), 让额外字段被剥离,
// 而不是 400 拒绝(否则前端会看到"保存失败: undefined"); (2) DB 层 NUMERIC(5,2)
// 阈值(如 warn_threshold)会以 "50.00" 字符串返回并随 GET 回传。
// 仅接受数字与十进制数字字符串，避免 null、布尔值、数组或空字符串被转换成阈值。
export const policyDimensionRuleSchema = z
  .object({
    id: boundedId.nullable().optional(),
    is_new: z.boolean().optional(),
    dimension: dimensionCode,
    enabled: z.boolean().default(true),
    warn_enabled: z.boolean().default(true),
    block_enabled: z.boolean().default(true),
    warn_threshold: policyThreshold.default(50),
    block_threshold: policyThreshold.default(80),
    auto_mask: z.boolean().default(false),
    auto_rewrite: z.boolean().default(false),
  })
  .refine((value) => value.warn_threshold <= value.block_threshold, {
    message: 'warn_threshold must not exceed block_threshold',
    path: ['warn_threshold'],
  });

export const updatePolicySchema = z
  .object({
    policyId: boundedId,
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(4_000).optional(),
    tags: tags.optional(),
    isActive: z.boolean().optional(),
    rules: z.array(policyDimensionRuleSchema).max(200).optional(),
  })
  .strict();

export const updatePolicyMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(4_000).optional(),
    tags: tags.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required',
  });

export const policyDeleteQuerySchema = z.object({ id: boundedId }).strict();
export const clonePolicySchema = z
  .object({ name: z.string().trim().min(1).max(128) })
  .strict();
export const togglePolicySchema = z.object({ isActive: z.boolean() }).strict();

export const escalationConfigSchema = z
  .object({
    escalationEnabled: z.boolean().default(false),
    escalationThreshold: z.number().int().min(1).max(20).default(5),
    escalationTargetPolicyId: boundedId.nullable().optional(),
    deescalationThreshold: z.number().int().min(1).max(10).default(1),
    escalationCooldownMinutes: z.number().int().min(0).max(1_440).default(30),
  })
  .strict();

export const judgeConfigSchema = z
  .object({
    profilesV2: judgeProfileListSchema.optional(),
    expectedProfileRevision: z.number().int().nonnegative().optional(),
    decisionPolicyVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    semanticDecisionMode:z.literal('coverage-v1').optional(),
    semanticCoverage:semanticCoveragePolicySchema.optional(),
    enabled: z.boolean().default(false),
    providerId: boundedId.nullable().optional(),
    mode: z.enum(['conservative', 'balanced', 'review_only']).default('conservative'),
    triggerMode: z.enum(['risk_only', 'risk_or_semantic', 'always']).default('risk_or_semantic'),
    triggerThreshold: z.number().int().min(0).max(100).default(40),
    judgeThreshold: z.number().int().min(0).max(100).default(70),
    weight: z.number().min(0).max(1).default(0.5),
    applyToInput: z.boolean().default(true),
    applyToOutput: z.boolean().default(true),
    enabledDimensions: z.array(dimensionCode).max(100).default([]),
    semanticDimensions: z.array(dimensionCode).max(100).default([]),
    timeoutMs: z.number().int().min(100).max(60_000).default(8_000),
    fallbackAction: z.enum(['rule', 'allow', 'block']).default('rule'),
    failClosedForHighRisk: z.boolean().default(true),
    maxTextLength: z.number().int().min(1).max(32_768).default(6_000),
    maskPiiBeforeJudge: z.boolean().default(true),
    blockExternalForSecrets: z.boolean().default(true),
  })
  .strict()
  .refine((value) => !value.enabled || Boolean(value.providerId), {
    message: 'providerId is required when Judge is enabled',
    path: ['providerId'],
  });

const keywordMatchType = z.enum(['exact', 'contains', 'prefix', 'suffix']);
export const keywordQuerySchema = z
  .object({
    categoryId: boundedId.optional(),
    dimension: dimensionCode.optional(),
    search: z.string().max(256).optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const keywordFields = {
  keyword: z.string().trim().min(1).max(512),
  dimension: dimensionCode,
  categoryId: boundedId.nullable().optional(),
  score: z.number().int().min(0).max(100).default(90),
  matchType: keywordMatchType.default('exact'),
  caseSensitive: z.boolean().default(false),
  description: z.string().max(2_000).default(''),
  tags: tags.default([]),
};
export const createKeywordSchema = z.object(keywordFields).strict();
export const updateKeywordSchema = z
  .object({
    keywordId: boundedId,
    ...keywordFields,
    enabled: z.boolean().default(true),
  })
  .strict();
export const keywordDeleteQuerySchema = z.object({ keywordId: boundedId }).strict();

const batchKeywordObjectSchema = z
  .object({
    keyword: z.string().trim().min(1).max(512),
    score: z.number().int().min(0).max(100).optional(),
    matchType: keywordMatchType.optional(),
    caseSensitive: z.boolean().optional(),
    description: z.string().max(2_000).optional(),
    tags: tags.optional(),
  })
  .strict();
export const batchKeywordSchema = z
  .object({
    keywords: z
      .array(z.union([z.string().trim().min(1).max(512), batchKeywordObjectSchema]))
      .min(1)
      .max(5_000),
    categoryId: boundedId.nullable().optional(),
    dimension: dimensionCode,
  })
  .strict();

const importedKeywordSchema = z
  .object({
    keyword: z.string().trim().min(1).max(512),
    categoryId: boundedId.nullable().optional(),
    dimension: dimensionCode.optional(),
    score: z.number().int().min(0).max(100).optional(),
    matchType: keywordMatchType.optional(),
    match_type: keywordMatchType.optional(),
    caseSensitive: z.boolean().optional(),
    case_sensitive: z.boolean().optional(),
    description: z.string().max(2_000).optional(),
    tags: tags.optional(),
  })
  .strict();
export const importKeywordSchema = z
  .object({
    keywords: z.array(importedKeywordSchema).max(10_000),
    categoryId: boundedId.nullable().optional(),
    dimension: dimensionCode.optional(),
    mode: z.enum(['merge', 'replace']).default('merge'),
  })
  .strict();
export const keywordExportQuerySchema = z
  .object({ format: z.enum(['json', 'csv']).default('json') })
  .strict();

const keywordCategoryFields = {
  name: z.string().trim().min(1).max(128),
  dimension: dimensionCode,
  description: z.string().max(2_000).default(''),
  priority: z.number().int().min(0).max(10_000).default(100),
};
export const createKeywordCategorySchema = z.object(keywordCategoryFields).strict();
export const updateKeywordCategorySchema = z
  .object({
    categoryId: boundedId,
    name: keywordCategoryFields.name.optional(),
    dimension: keywordCategoryFields.dimension.optional(),
    description: keywordCategoryFields.description.optional(),
    priority: keywordCategoryFields.priority.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const keywordCategoryDeleteQuerySchema = z.object({ categoryId: boundedId }).strict();
