import { z } from 'zod';

export const dimensionFieldsSchema = z.object({
  name: z.string().trim().min(1, '请输入维度名称').max(100),
  description: z.string().max(2000).default(''),
  category: z.string().trim().min(1).max(50).default('custom'),
  weight: z.number().positive().max(10).default(1),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();
export const createDimensionSchema = dimensionFieldsSchema.extend({
  code: z.string().trim().min(1).max(50).regex(/^[a-z][a-z0-9_]*$/, '编码只能包含小写字母、数字和下划线，且以字母开头'),
});
export const updateDimensionSchema = z.object({
  name: dimensionFieldsSchema.shape.name.optional(),
  description: dimensionFieldsSchema.shape.description.removeDefault().optional(),
  category: dimensionFieldsSchema.shape.category.removeDefault().optional(),
  weight: dimensionFieldsSchema.shape.weight.removeDefault().optional(),
  priority: dimensionFieldsSchema.shape.priority.removeDefault().optional(),
  enabled: dimensionFieldsSchema.shape.enabled.removeDefault().optional(),
  config: dimensionFieldsSchema.shape.config.removeDefault().optional(),
}).strict().refine(value => Object.keys(value).length > 0, '至少修改一个字段');
export const ruleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['keyword', 'regex', 'semantic', 'llm']),
  pattern: z.string().max(4096).default(''),
  matchType: z.enum(['exact', 'contains', 'prefix', 'suffix', 'regex']).default('contains'),
  caseSensitive: z.boolean().default(false),
  score: z.number().min(0).max(100).default(50),
  confidence: z.number().min(0).max(1).default(0.8),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
  description: z.string().max(2000).default(''),
  suggestion: z.string().max(2000).default(''),
  config: z.record(z.string(), z.unknown()).default({}),
  groupId: z.string().min(1).max(36).nullable().optional(),
}).strict();
export const createRuleSchema = ruleFieldsSchema;
export const updateRuleSchema = z.object({
  name: ruleFieldsSchema.shape.name.optional(),
  type: ruleFieldsSchema.shape.type.optional(),
  pattern: ruleFieldsSchema.shape.pattern.removeDefault().optional(),
  matchType: ruleFieldsSchema.shape.matchType.removeDefault().optional(),
  caseSensitive: ruleFieldsSchema.shape.caseSensitive.removeDefault().optional(),
  score: ruleFieldsSchema.shape.score.removeDefault().optional(),
  confidence: ruleFieldsSchema.shape.confidence.removeDefault().optional(),
  priority: ruleFieldsSchema.shape.priority.removeDefault().optional(),
  enabled: ruleFieldsSchema.shape.enabled.removeDefault().optional(),
  description: ruleFieldsSchema.shape.description.removeDefault().optional(),
  suggestion: ruleFieldsSchema.shape.suggestion.removeDefault().optional(),
  config: ruleFieldsSchema.shape.config.removeDefault().optional(),
  groupId: ruleFieldsSchema.shape.groupId,
}).strict().refine(value => Object.keys(value).length > 0, '至少修改一个字段');
export const testDimensionSchema = z.object({ text: z.string().trim().min(1).max(32768) }).strict();
