/**
 * 动态检测引擎
 * 从数据库动态加载维度和规则进行检测
 * 所有检测规则和白名单规则必须在数据库中维护
 */

import { db } from '@/lib/db';
import {
  detectionDimensions,
  detectionRules,
  ruleGroups,
  whitelistRules,
  whitelistRulePolicies,
  policyDimensionConfig,
  policyProfiles,
  policyRules,
} from '@/lib/db';
import { eq, and, gt, inArray, isNotNull, lte } from 'drizzle-orm';

// 导入裁判模型模块
import {
  shouldInvokeJudge,
  fuseResults,
  executeJudgeDetection,
  getJudgeConfig,
} from '@/lib/judge';
import type { JudgeModelResult, DecisionTrace } from '@/lib/judge';

// 从类型文件导入
export type {
  DetectionDimension,
  DetectionRule,
  RuleGroup,
  PolicyDimensionConfigItem,
  WhitelistRule,
  WhitelistMatched,
  SkippedDimension,
  CachedPolicyConfig,
  DetectionFinding,
  DetectionResult,
} from './types';

import type {
  DetectionDimension,
  DetectionRule,
  RuleGroup,
  PolicyDimensionConfigItem,
  WhitelistRule,
  WhitelistMatched,
  SkippedDimension,
  CachedPolicyConfig,
  DetectionFinding,
  DetectionResult,
} from './types';
import { DetectionPolicyError } from './errors';
import {
  isMandatoryDenyRule,
  strictestRiskAction,
  terminalAction,
  type RiskAction,
} from './decision';
import {
  validateSafeRegexPattern,
  safeRegexMatches,
  UnsafeRegexError,
} from './safe-regex';
import { scopePredicate, type TenantScope } from '@/lib/tenancy';

// 缓存
const policyCache = new Map<string, CachedPolicyConfig>();
const CACHE_TTL = 30 * 1000; // 30秒缓存，更快响应配置变更

// 清除缓存（配置变更时调用）
export function clearPolicyCache(policyId?: string) {
  if (policyId) {
    for (const key of policyCache.keys()) {
      if (key.endsWith(`:${policyId}`)) {
        policyCache.delete(key);
      }
    }
  } else {
    policyCache.clear();
  }
  console.log(`[检测引擎] 缓存已清除: ${policyId || '全部'}`);
}

function policyCacheKey(scope: TenantScope, policyId: string): string {
  return `${scope.tenantId}:${scope.applicationId}:${policyId}`;
}

// ============ 数字边界判断辅助函数 ============

/**
 * 判断字符是否为数字
 */
function isDigitChar(ch: string | undefined): boolean {
  return !!ch && /\d/.test(ch);
}

/**
 * 判断规则是否需要应用数字边界判断
 * 手机号、身份证号、银行卡号等数字类规则需要确保前后不是数字
 */
function shouldApplyNumericBoundary(rule: DetectionRule): boolean {
  const name = `${rule.name || ''}`;
  const pattern = `${rule.pattern || ''}`;

  return (
    name.includes('手机号') ||
    name.includes('身份证') ||
    name.includes('银行卡') ||
    name.includes('电话') ||
    // 根据模式特征判断（手机号、身份证、银行卡等常见数字模式）
    /\\d\{9\}/.test(pattern) ||
    /\\d\{16,19\}/.test(pattern) ||
    /\\d\{17\}/.test(pattern) ||
    /1\[3-9\]\\d\{9\}/.test(pattern)
  );
}

/**
 * 检查数字边界的有效性
 * 确保匹配的内容前后不是数字（避免在身份证号内部误匹配手机号）
 */
function passNumericBoundary(text: string, index: number, length: number): boolean {
  const before = text[index - 1];
  const after = text[index + length];

  return !isDigitChar(before) && !isDigitChar(after);
}

// 全量匹配函数 - 返回所有匹配结果
function matchRuleAll(text: string, rule: DetectionRule): Array<{ raw: string; index: number }> {
  if (!rule.pattern) return [];

  const matches: Array<{ raw: string; index: number }> = [];
  const needNumericBoundary = shouldApplyNumericBoundary(rule);

  switch (rule.matchType) {
    case 'exact': {
      const searchText = rule.caseSensitive ? text : text.toLowerCase();
      const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
      if (searchText === pattern) {
        // 精确匹配时，检查数字边界
        if (needNumericBoundary && !passNumericBoundary(text, 0, rule.pattern.length)) {
          break;
        }
        matches.push({ raw: rule.pattern, index: 0 });
      }
      break;
    }
    case 'contains': {
      const searchText = rule.caseSensitive ? text : text.toLowerCase();
      const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
      let start = 0;
      while (start < searchText.length) {
        const index = searchText.indexOf(pattern, start);
        if (index < 0) break;
        
        // 检查数字边界
        if (needNumericBoundary && !passNumericBoundary(text, index, rule.pattern!.length)) {
          start = index + 1;
          continue;
        }
        
        matches.push({ raw: text.slice(index, index + rule.pattern!.length), index });
        start = index + 1;
      }
      break;
    }
    case 'prefix': {
      const searchText = rule.caseSensitive ? text : text.toLowerCase();
      const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
      if (searchText.startsWith(pattern)) {
        // 检查数字边界
        if (needNumericBoundary && !passNumericBoundary(text, 0, rule.pattern!.length)) {
          break;
        }
        matches.push({ raw: text.slice(0, rule.pattern!.length), index: 0 });
      }
      break;
    }
    case 'suffix': {
      const searchText = rule.caseSensitive ? text : text.toLowerCase();
      const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
      if (searchText.endsWith(pattern)) {
        const index = text.length - rule.pattern!.length;
        // 检查数字边界
        if (needNumericBoundary && !passNumericBoundary(text, index, rule.pattern!.length)) {
          break;
        }
        matches.push({ raw: text.slice(index), index });
      }
      break;
    }
    case 'regex': {
      for (const match of safeRegexMatches(text, rule.pattern, rule.caseSensitive)) {
        if (needNumericBoundary && !passNumericBoundary(text, match.index, match.raw.length)) {
          continue;
        }
        matches.push(match);
      }
      break;
    }
  }

  return matches;
}

function whitelistOccurrences(
  text: string,
  whitelist: WhitelistRule,
): Array<{ raw: string; index: number }> {
  const searchText = whitelist.caseSensitive ? text : text.toLowerCase();
  const pattern = whitelist.caseSensitive ? whitelist.pattern : whitelist.pattern.toLowerCase();

  switch (whitelist.matchType) {
    case 'exact':
      return searchText === pattern ? [{ raw: text, index: 0 }] : [];
    case 'prefix':
      return searchText.startsWith(pattern)
        ? [{ raw: text.slice(0, whitelist.pattern.length), index: 0 }]
        : [];
    case 'suffix': {
      const index = text.length - whitelist.pattern.length;
      return searchText.endsWith(pattern)
        ? [{ raw: text.slice(index), index }]
        : [];
    }
    case 'regex':
      return safeRegexMatches(text, whitelist.pattern, whitelist.caseSensitive);
    case 'contains': {
      const result: Array<{ raw: string; index: number }> = [];
      let cursor = 0;
      while (result.length < 100) {
        const index = searchText.indexOf(pattern, cursor);
        if (index < 0) break;
        result.push({ raw: text.slice(index, index + whitelist.pattern.length), index });
        cursor = index + Math.max(1, whitelist.pattern.length);
      }
      return result;
    }
  }
}

function whitelistSuppressesMatch(input: {
  readonly whitelist: WhitelistRule;
  readonly text: string;
  readonly match: { readonly raw: string; readonly index: number };
  readonly ruleId: string;
  readonly dimensionCode: string;
  readonly direction: 'INPUT' | 'OUTPUT_COMPLETE';
  readonly now: number;
}): boolean {
  const { whitelist, text, match, ruleId, dimensionCode, direction, now } = input;
  if (
    whitelist.approvalStatus !== 'approved' ||
    !whitelist.approvedBy?.trim() ||
    whitelist.dimensionScope !== 'specific' ||
    !whitelist.dimensionCodes.includes(dimensionCode) ||
    !whitelist.targetRuleIds?.includes(ruleId) ||
    !whitelist.directions?.includes(direction) ||
    whitelist.validFromEpochMs === undefined ||
    whitelist.validFromEpochMs > now ||
    whitelist.expiresAtEpochMs === undefined ||
    whitelist.expiresAtEpochMs <= now
  ) return false;
  const end = match.index + match.raw.length;
  return whitelistOccurrences(text, whitelist).some((occurrence) =>
    occurrence.index <= match.index && occurrence.index + occurrence.raw.length >= end,
  );
}

// 获取默认策略ID
export async function getDefaultPolicyId(scope: TenantScope): Promise<string | null> {
  const profiles = await db
    .select()
    .from(policyProfiles)
    .where(and(
      eq(policyProfiles.isDefault, true),
      scopePredicate(policyProfiles, scope),
    ))
    .limit(1);
  return profiles.length > 0 ? profiles[0].id : null;
}

// 获取策略配置（带缓存）- 支持从policy_dimension_config或policy_profiles.rules获取
export async function getPolicyConfig(
  policyId: string,
  scope: TenantScope,
): Promise<CachedPolicyConfig | null> {
  const cacheKey = policyCacheKey(scope, policyId);
  // 检查缓存
  const cached = policyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    return cached;
  }

  try {
    // 首先尝试从policy_dimension_config表获取配置
    try {
      const dimConfigs = await db
        .select()
        .from(policyDimensionConfig)
        .where(
          and(
            eq(policyDimensionConfig.policyId, policyId),
            eq(policyDimensionConfig.enabled, true),
            scopePredicate(policyDimensionConfig, scope),
          )
        );

      // 如果policy_dimension_config表有数据，使用原有逻辑
      if (dimConfigs && dimConfigs.length > 0) {
        return await buildConfigFromDimensionConfig(policyId, dimConfigs, scope);
      }
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
    }

    // 从policy_rules表获取配置
    try {
      const policyRulesData = await db
        .select()
        .from(policyRules)
        .where(and(
          eq(policyRules.policyId, policyId),
          scopePredicate(policyRules, scope),
        ));

      if (policyRulesData && policyRulesData.length > 0) {
        return await buildConfigFromPolicyRules(policyId, policyRulesData, scope);
      }
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
    }

    return null;
  } catch (error) {
    if (error instanceof DetectionPolicyError) throw error;
    if (error instanceof UnsafeRegexError) {
      throw new DetectionPolicyError(
        'POLICY_PATTERN_INVALID',
        'Policy contains a regular expression that cannot be compiled safely',
        { cause: error },
      );
    }
    throw new DetectionPolicyError('POLICY_LOAD_FAILED', 'Policy configuration could not be loaded', {
      cause: error,
    });
  }
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '42P01'
  );
}

function validatePolicyPatterns(config: CachedPolicyConfig): void {
  for (const rules of config.rules.values()) {
    for (const rule of rules) {
      if (rule.matchType === 'regex' && rule.pattern) {
        validateSafeRegexPattern(rule.pattern, rule.caseSensitive ? '' : 'i');
      }
    }
  }
  for (const exception of config.whitelists) {
    if (exception.matchType === 'regex') {
      validateSafeRegexPattern(exception.pattern, exception.caseSensitive ? '' : 'i');
    }
  }
}

function mapDimension(dim: typeof detectionDimensions.$inferSelect): DetectionDimension {
  return {
    id: dim.id,
    code: dim.code,
    name: dim.name,
    description: dim.description || undefined,
    category: dim.category || undefined,
    weight: parseFloat(dim.weight) || 1,
    priority: dim.priority,
    enabled: dim.enabled,
    isSystem: dim.isSystem,
    config: (dim.config as Record<string, unknown>) || {},
  };
}

function mapRule(rule: typeof detectionRules.$inferSelect): DetectionRule {
  return {
    id: rule.id,
    dimensionId: rule.dimensionId,
    groupId: rule.groupId || undefined,
    name: rule.name,
    type: rule.type as DetectionRule['type'],
    pattern: rule.pattern || undefined,
    matchType: rule.matchType as DetectionRule['matchType'],
    caseSensitive: rule.caseSensitive,
    score: parseFloat(rule.score) || 50,
    confidence: parseFloat(rule.confidence) || 0.8,
    priority: rule.priority,
    enabled: rule.enabled,
    description: rule.description || undefined,
    config: (rule.config as Record<string, unknown>) || {},
    suggestion: rule.suggestion || undefined,
  };
}

function mapRuleGroup(group: typeof ruleGroups.$inferSelect): RuleGroup {
  return {
    id: group.id,
    dimensionId: group.dimensionId,
    name: group.name,
    description: group.description || undefined,
    logic: group.logic as RuleGroup['logic'],
    score: parseFloat(group.score) || 50,
    priority: group.priority,
    enabled: group.enabled,
  };
}

// 从policy_dimension_config表构建配置
async function buildConfigFromDimensionConfig(
  policyId: string,
  dimConfigs: typeof policyDimensionConfig.$inferSelect[],
  scope: TenantScope,
): Promise<CachedPolicyConfig | null> {
  const dimensionIds = dimConfigs.map(dc => dc.dimensionId);
  const [dimensionRows, ruleRows, groupRows] = await Promise.all([
    db.select().from(detectionDimensions).where(and(
      inArray(detectionDimensions.id, dimensionIds),
      eq(detectionDimensions.enabled, true),
      scopePredicate(detectionDimensions, scope),
    )),
    db.select().from(detectionRules).where(and(
      inArray(detectionRules.dimensionId, dimensionIds),
      eq(detectionRules.enabled, true),
      scopePredicate(detectionRules, scope),
    )),
    db.select().from(ruleGroups).where(and(
      inArray(ruleGroups.dimensionId, dimensionIds),
      eq(ruleGroups.enabled, true),
      scopePredicate(ruleGroups, scope),
    )),
  ]);
  const dimensions = dimensionRows.map(mapDimension);
  const rules = new Map<string, DetectionRule[]>();
  const ruleGroupsMap = new Map<string, RuleGroup[]>();
  for (const dimId of dimensionIds) {
    rules.set(dimId, ruleRows.filter((row) => row.dimensionId === dimId).map(mapRule));
    ruleGroupsMap.set(
      dimId,
      groupRows.filter((row) => row.dimensionId === dimId).map(mapRuleGroup),
    );
  }

  // 获取白名单
  const whitelistData = await getWhitelistRules(policyId, scope);

  const config: CachedPolicyConfig = {
    policyId,
    version: 1,
    dimensions,
    rules,
    ruleGroups: ruleGroupsMap,
    whitelists: whitelistData,
    dimensionConfigs: dimConfigs.map(dc => ({
      id: dc.id,
      policyId: dc.policyId,
      dimensionId: dc.dimensionId,
      enabled: dc.enabled,
      warnEnabled: dc.warnEnabled ?? true,
      blockEnabled: dc.blockEnabled ?? true,
      warnThreshold: dc.warnThreshold,
      blockThreshold: dc.blockThreshold,
      autoMask: dc.autoMask,
      autoRewrite: dc.autoRewrite,
      customWeight: dc.customWeight ? parseFloat(dc.customWeight) : undefined,
      actionConfig: (dc.actionConfig as Record<string, unknown>) || {},
    })),
    cachedAt: Date.now(),
  };

  validatePolicyPatterns(config);
  policyCache.set(policyCacheKey(scope, policyId), config);
  return config;
}

// 从policy_rules表构建配置
async function buildConfigFromPolicyRules(
  policyId: string,
  policyRulesData: typeof policyRules.$inferSelect[],
  scope: TenantScope,
): Promise<CachedPolicyConfig | null> {
  const dimensions: DetectionDimension[] = [];
  const rulesMap = new Map<string, DetectionRule[]>();
  const ruleGroupsMap = new Map<string, RuleGroup[]>();
  const dimensionConfigs: PolicyDimensionConfigItem[] = [];

  // 只处理启用的维度
  const enabledRules = policyRulesData.filter(r => r.enabled);
  const dimensionCodes = [...new Set(enabledRules.map((rule) => rule.dimension))];
  const dimensionRows = dimensionCodes.length > 0
    ? await db.select().from(detectionDimensions).where(and(
        inArray(detectionDimensions.code, dimensionCodes),
        eq(detectionDimensions.enabled, true),
        scopePredicate(detectionDimensions, scope),
      ))
    : [];
  const dimensionIds = dimensionRows.map((dimension) => dimension.id);
  const [ruleRows, groupRows] = dimensionIds.length > 0
    ? await Promise.all([
        db.select().from(detectionRules).where(and(
          inArray(detectionRules.dimensionId, dimensionIds),
          eq(detectionRules.enabled, true),
          scopePredicate(detectionRules, scope),
        )),
        db.select().from(ruleGroups).where(and(
          inArray(ruleGroups.dimensionId, dimensionIds),
          eq(ruleGroups.enabled, true),
          scopePredicate(ruleGroups, scope),
        )),
      ])
    : [[], []];
  const addedDimensionIds = new Set<string>();

  for (const rule of enabledRules) {
    const dim = dimensionRows.find((dimension) => dimension.code === rule.dimension);
    if (dim && !addedDimensionIds.has(dim.id)) {
      addedDimensionIds.add(dim.id);
      dimensions.push(mapDimension(dim));

      // 构建维度配置
      dimensionConfigs.push({
        id: `${policyId}-${dim.id}`,
        policyId,
        dimensionId: dim.id,
        enabled: true,
        warnEnabled: rule.warnEnabled ?? true,
        blockEnabled: rule.blockEnabled ?? true,
        warnThreshold: parseFloat(rule.warnThreshold) || 50,
        blockThreshold: parseFloat(rule.blockThreshold) || 80,
        autoMask: rule.autoMask || false,
        autoRewrite: rule.autoRewrite || false,
        customWeight: 1.0,
        actionConfig: {},
      });

      rulesMap.set(
        dim.id,
        ruleRows.filter((row) => row.dimensionId === dim.id).map(mapRule),
      );
      ruleGroupsMap.set(
        dim.id,
        groupRows.filter((row) => row.dimensionId === dim.id).map(mapRuleGroup),
      );
    }
  }

  // 获取白名单
  const whitelistData = await getWhitelistRules(policyId, scope);

  const config: CachedPolicyConfig = {
    policyId,
    version: 1,
    dimensions,
    rules: rulesMap,
    ruleGroups: ruleGroupsMap,
    whitelists: whitelistData,
    dimensionConfigs,
    cachedAt: Date.now(),
  };

  validatePolicyPatterns(config);
  policyCache.set(policyCacheKey(scope, policyId), config);
  return config;
}

// 获取白名单规则（新版：支持策略范围和维度范围）
async function getWhitelistRules(
  policyId: string,
  scope: TenantScope,
): Promise<WhitelistRule[]> {
  try {
    const now = new Date();
    // 仅加载审批通过、处于有效期且有具名审批人的白名单。
    const allWhitelists = await db
      .select()
      .from(whitelistRules)
      .where(and(
        eq(whitelistRules.enabled, true),
        eq(whitelistRules.approvalStatus, 'approved'),
        isNotNull(whitelistRules.approvedBy),
        lte(whitelistRules.validFrom, now),
        gt(whitelistRules.expiresAt, now),
        scopePredicate(whitelistRules, scope),
      ));

    // 获取策略绑定
    const policyBindings = await db
      .select()
      .from(whitelistRulePolicies)
      .where(scopePredicate(whitelistRulePolicies, scope));

    // 过滤出对当前策略生效的白名单
    const applicableWhitelists = allWhitelists.filter(w => {
      // policyScope 为 'all' 时对所有策略生效
      if (w.policyScope === 'all') {
        return true;
      }
      // policyScope 为 'specific' 时检查是否绑定了当前策略
      const bindings = policyBindings.filter(b => b.whitelistRuleId === w.id);
      return bindings.some(b => b.policyId === policyId);
    });

    return applicableWhitelists.map(w => ({
      id: w.id,
      name: w.name || undefined,
      description: w.description || undefined,
      policyScope: (w.policyScope || 'specific') as 'all' | 'specific',
      dimensionScope: (w.dimensionScope || 'specific') as 'all' | 'specific',
      dimensionCodes: (w.dimensionCodes as string[]) || [],
      targetRuleIds: (w.targetRuleIds as string[]) || [],
      directions: w.directions || [],
      validFromEpochMs: w.validFrom.getTime(),
      expiresAtEpochMs: w.expiresAt?.getTime(),
      approvalStatus: w.approvalStatus as WhitelistRule['approvalStatus'],
      approvedBy: w.approvedBy || undefined,
      approvedAtEpochMs: w.approvedAt?.getTime(),
      priority: w.priority || 100,
      pattern: w.pattern,
      matchType: w.matchType as 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex',
      caseSensitive: w.caseSensitive,
      enabled: w.enabled,
      // 兼容旧字段
      policyId: w.policyId || undefined,
      dimensionId: w.dimensionId || undefined,
    }));
  } catch (error) {
    if (isUndefinedTableError(error)) return [];
    throw error;
  }
}

// 执行动态检测
export async function detectWithDynamicRules(
  text: string,
  policyId: string,
  scope: TenantScope,
  direction: 'input' | 'output' = 'input',
  signal?: AbortSignal,
): Promise<DetectionResult> {
  const startTime = Date.now();
  
  // 获取策略配置
  const config = await getPolicyConfig(policyId, scope);
  if (!config) {
    throw new DetectionPolicyError(
      'POLICY_NOT_AVAILABLE',
      'The requested policy is missing or has no enabled detection configuration',
    );
  }

  // 按 priority 从高到低排序白名单
  const sortedWhitelists = [...config.whitelists].sort((a, b) =>
    (b.priority || 100) - (a.priority || 100)
  );

  const skippedDimensions: SkippedDimension[] = [];
  let whitelistMatched: WhitelistMatched | undefined;
  const evaluationTime = Date.now();
  const guardDirection = direction === 'input' ? 'INPUT' : 'OUTPUT_COMPLETE';

  const findings: DetectionFinding[] = [];
  let maxScore = 0;
  let finalAction: RiskAction = 'allow';

  // 遍历每个维度进行检测
  for (const dimension of config.dimensions) {
    const dimConfig = config.dimensionConfigs.find(dc => dc.dimensionId === dimension.id);
    if (!dimConfig || !dimConfig.enabled) continue;

    // 获取该维度的规则
    const dimRules = config.rules.get(dimension.id) || [];

    // 执行规则匹配 - 每个规则的每个匹配生成独立的 finding
    for (const rule of dimRules) {
      // 只处理关键词和正则类型规则
      if (rule.type !== 'keyword' && rule.type !== 'regex') continue;
      if (!rule.pattern) continue;
      const mandatoryDeny = isMandatoryDenyRule(rule);

      // 获取所有匹配
      const allMatches = matchRuleAll(text, rule);
      if (allMatches.length === 0) continue;

      // 为每个匹配生成独立的 finding
      for (const match of allMatches) {
        const suppressingWhitelist = mandatoryDeny ? undefined : sortedWhitelists.find(
          (whitelist) => whitelistSuppressesMatch({
            whitelist,
            text,
            match,
            ruleId: rule.id,
            dimensionCode: dimension.code,
            direction: guardDirection,
            now: evaluationTime,
          }),
        );
        if (suppressingWhitelist) {
          whitelistMatched ??= {
            id: suppressingWhitelist.id,
            name: suppressingWhitelist.name || '未命名白名单',
            policyScope: suppressingWhitelist.policyScope,
            dimensionScope: suppressingWhitelist.dimensionScope,
            dimensionCodes: suppressingWhitelist.dimensionCodes,
            pattern: suppressingWhitelist.pattern,
            matchType: suppressingWhitelist.matchType,
            effect: 'suppress_target_rule_match',
          };
          continue;
        }
        const evidence = match.raw;
        
        // 计算该规则的风险分数
        const policyWeight = dimConfig.customWeight || 1.0;
        const ruleScore = rule.score * dimension.weight * policyWeight;
        const score = Math.min(Math.max(ruleScore, 0), 100);

        // 确定动作
        let ruleAction: RiskAction = 'allow';
        if (mandatoryDeny) {
          ruleAction = 'block';
        } else if (score >= dimConfig.blockThreshold && dimConfig.blockEnabled) {
          ruleAction = 'block';
        } else if (score >= dimConfig.warnThreshold && dimConfig.warnEnabled) {
          ruleAction = 'warn';
        }

        findings.push({
          dimension: dimension.code,
          dimensionName: dimension.name,
          dimensionId: dimension.id,
          ruleId: rule.id,
          ruleName: rule.name,
          ruleType: rule.type,
          score: Math.round(score),
          confidence: rule.confidence,
          severity: score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low',
          action: ruleAction,
          matchedRules: [rule.name],
          evidence: [evidence],
          maskedEvidence: [evidence], // 文档检测不脱敏
          reason: `命中规则「${rule.name}」，检测到: ${evidence}`,
          suggestion: rule.suggestion || '', // 从规则中获取建议
        });

        maxScore = Math.max(maxScore, score);
        finalAction = strictestRiskAction(finalAction, ruleAction);
      }
    }
  }

  // 确定最终决策动作（不受 auto_mask/auto_rewrite 影响）
  // 只有在达到 block 阈值且 block_enabled 时才 block
  // 否则如果达到 warn 阈值且 warn_enabled 则 warn
  // 否则 allow
  
  // 检查是否需要进行脱敏或改写处理
  let processingAction: 'none' | 'mask' | 'rewrite' = 'none';
  
  // 遍历 findings 找到是否需要脱敏或改写
  // 优先级：rewrite > mask（rewrite 更彻底）
  let needMask = false;
  let needRewrite = false;
  
  for (const finding of findings) {
    // 先根据 dimension code 找到对应的 dimension
    const dimension = config.dimensions.find(d => d.code === finding.dimension);
    if (!dimension) continue;
    
    // 再根据 dimension id 找到对应的维度配置
    const dimConfig = config.dimensionConfigs.find(dc => dc.dimensionId === dimension.id);
    if (dimConfig && finalAction !== 'block') {
      // 检查是否需要改写（优先级更高）
      if (dimConfig.autoRewrite && finding.score >= dimConfig.warnThreshold) {
        needRewrite = true;
      }
      // 检查是否需要脱敏
      if (dimConfig.autoMask && finding.score >= dimConfig.warnThreshold) {
        needMask = true;
      }
    }
  }
  
  // 根据优先级设置 processingAction
  if (needRewrite) {
    processingAction = 'rewrite';
  } else if (needMask) {
    processingAction = 'mask';
  }

  // ========== 裁判模型检测 ==========
  let judgeModelResult: JudgeModelResult | undefined;
  let decisionTrace: DecisionTrace | undefined;
  let finalOverallScore = Math.round(maxScore);
  let finalFinalAction = finalAction;

  const judgeConfig = await getJudgeConfig(policyId, scope);
  if (judgeConfig && shouldInvokeJudge(judgeConfig, direction, maxScore, findings, text)) {
    try {
      judgeModelResult = await executeJudgeDetection(
        text,
        direction,
        findings,
        maxScore,
        judgeConfig,
        scope,
        undefined,
        signal,
      );

    } catch {
      judgeModelResult = {
        used: true,
        error: 'JUDGE_EXECUTION_FAILED',
        fallbackUsed: true,
      };
    }
    const dominantFinding = findings.reduce<DetectionFinding | undefined>(
      (current, finding) => (!current || finding.score > current.score ? finding : current),
      undefined,
    );
    const dominantDimension = dominantFinding
      ? config.dimensions.find((dimension) => dimension.code === dominantFinding.dimension)
      : undefined;
    const dominantConfig = dominantDimension
      ? config.dimensionConfigs.find((item) => item.dimensionId === dominantDimension.id)
      : undefined;
    decisionTrace = fuseResults(
      maxScore,
      finalAction,
      judgeModelResult,
      judgeConfig,
      dominantConfig?.warnThreshold ?? 50,
      dominantConfig?.blockThreshold ?? 80,
    );
    finalOverallScore = decisionTrace.finalScore;
    finalFinalAction = strictestRiskAction(finalAction, decisionTrace.finalAction);
  }

  const action = terminalAction(finalFinalAction, processingAction);
  let summary = generateSummary(findings, action, skippedDimensions);
  if (decisionTrace) {
    summary = `${summary}；${decisionTrace.reasoning}`;
  }

  return {
    overallScore: finalOverallScore,
    confidence: calculateResultConfidence(config, findings, judgeModelResult),
    action,
    findings,
    summary,
    latencyMs: Date.now() - startTime,
    policyVersion: config.version,
    degradationReasons: judgeModelResult?.error ? [judgeModelResult.error] : undefined,
    whitelistMatched,
    skippedDimensions: skippedDimensions.length > 0 ? skippedDimensions : undefined,
    judgeModelResult: judgeModelResult ? {
      used: judgeModelResult.used,
      score: judgeModelResult.score,
      confidence: judgeModelResult.confidence,
      suggestedAction: judgeModelResult.suggestedAction,
      reason: judgeModelResult.reason,
      latencyMs: judgeModelResult.latencyMs,
      error: judgeModelResult.error,
      parseError: judgeModelResult.parseError,
      fallbackUsed: judgeModelResult.fallbackUsed,
    } : undefined,
    decisionTrace,
  };
}

// 生成摘要
function generateSummary(
  findings: DetectionFinding[],
  action: string,
  skippedDimensions?: SkippedDimension[]
): string {
  const parts: string[] = [];

  // 如果有跳过的维度，先显示
  if (skippedDimensions && skippedDimensions.length > 0) {
    const skippedNames = skippedDimensions.map(d => d.dimensionName).join('、');
    parts.push(`因命中白名单已跳过检测: ${skippedNames}`);
  }

  if (findings.length === 0) {
    if (parts.length === 0) {
      return '未检测到安全风险';
    }
    return parts.join('；');
  }

  const highRisks = findings.filter(f => f.score >= 80);
  const mediumRisks = findings.filter(f => f.score >= 50 && f.score < 80);

  if (highRisks.length > 0) {
    parts.push(`高风险维度: ${highRisks.map(f => f.dimensionName).join(', ')}`);
  }

  if (mediumRisks.length > 0) {
    parts.push(`中风险维度: ${mediumRisks.map(f => f.dimensionName).join(', ')}`);
  }

  const actionText: Record<string, string> = {
    allow: '已放行',
    warn: '已警告',
    block: '已拦截',
    mask: '已脱敏',
    rewrite: '已改写',
  };

  parts.push(`最终动作: ${actionText[action] || action}`);

  return parts.join('；');
}

function calculateResultConfidence(
  config: CachedPolicyConfig,
  findings: DetectionFinding[],
  judgeResult: JudgeModelResult | undefined,
): number {
  const ruleCount = [...config.rules.values()].reduce((total, rules) => total + rules.length, 0);
  const coverageConfidence = Math.min(0.9, 0.5 + Math.log10(ruleCount + 1) * 0.1);
  const findingConfidence = findings.reduce((maximum, finding) => {
    const raw = finding.confidence ?? 0;
    const normalized = raw > 1 ? raw / 100 : raw;
    return Math.max(maximum, Math.min(1, Math.max(0, normalized)));
  }, 0);
  const ruleConfidence = findingConfidence || coverageConfidence;
  if (judgeResult?.used && !judgeResult.error && judgeResult.confidence !== undefined) {
    return Number(((ruleConfidence + judgeResult.confidence) / 2).toFixed(3));
  }
  if (judgeResult?.error) return Number(Math.min(ruleConfidence, 0.5).toFixed(3));
  return Number(ruleConfidence.toFixed(3));
}

// 获取所有启用的维度
export async function getAllDimensions(scope: TenantScope): Promise<DetectionDimension[]> {
  const dimensions = await db
    .select()
    .from(detectionDimensions)
    .where(and(
      eq(detectionDimensions.enabled, true),
      scopePredicate(detectionDimensions, scope),
    ));

  return dimensions.map(d => ({
    id: d.id,
    code: d.code,
    name: d.name,
    description: d.description || '',
    category: d.category || '',
    weight: parseFloat(d.weight) || 1.0,
    priority: d.priority || 100,
    enabled: d.enabled,
    isSystem: d.isSystem,
    config: (d.config as Record<string, unknown>) || {},
  }));
}
