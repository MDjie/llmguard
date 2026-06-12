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
import { eq, and, sql } from 'drizzle-orm';

// 导入裁判模型模块
import {
  shouldInvokeJudge,
  fuseResults,
  executeJudgeDetection,
  getJudgeConfig,
} from '@/lib/judge';
import type { PolicyJudgeConfig, JudgeModelResult, DecisionTrace } from '@/lib/judge';

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

// 缓存
const policyCache = new Map<string, CachedPolicyConfig>();
const CACHE_TTL = 30 * 1000; // 30秒缓存，更快响应配置变更

// 清除缓存（配置变更时调用）
export function clearPolicyCache(policyId?: string) {
  if (policyId) {
    policyCache.delete(policyId);
  } else {
    policyCache.clear();
  }
  console.log(`[检测引擎] 缓存已清除: ${policyId || '全部'}`);
}

// 规则匹配函数 - 返回是否匹配（用于白名单等场景）
function matchRule(text: string, rule: DetectionRule): boolean {
  if (!rule.pattern) return false;
  
  const searchText = rule.caseSensitive ? text : text.toLowerCase();
  const pattern = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();

  switch (rule.matchType) {
    case 'exact':
      return searchText === pattern;
    case 'contains':
      return searchText.includes(pattern);
    case 'prefix':
      return searchText.startsWith(pattern);
    case 'suffix':
      return searchText.endsWith(pattern);
    case 'regex':
      try {
        const flags = rule.caseSensitive ? 'g' : 'gi';
        return new RegExp(rule.pattern, flags).test(text);
      } catch {
        return false;
      }
    default:
      return false;
  }
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

/**
 * 标准化正则模式
 * 修复历史错误数据（如 \\d 被存成双反斜杠）
 */
function normalizeRegexPattern(pattern: string): string {
  let p = pattern.trim();

  // 兼容 /xxx/gi 格式
  const slashFormat = p.match(/^\/(.+)\/([gimsuy]*)$/);
  if (slashFormat) {
    p = slashFormat[1];
  }

  // 修复历史错误数据：如果数据库里真实存的是 \\d、\\s 等
  // 动态 new RegExp 时会变成匹配字面量，需要修复
  p = p
    .replace(/\\\\d/g, '\\d')
    .replace(/\\\\D/g, '\\D')
    .replace(/\\\\s/g, '\\s')
    .replace(/\\\\S/g, '\\S')
    .replace(/\\\\w/g, '\\w')
    .replace(/\\\\W/g, '\\W')
    .replace(/\\\\b/g, '\\b')
    .replace(/\\\\B/g, '\\B');

  return p;
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
      try {
        // 标准化正则模式
        const source = normalizeRegexPattern(rule.pattern);
        let flags = 'g';
        
        if (!rule.caseSensitive && !flags.includes('i')) flags += 'i';
        
        const regex = new RegExp(source, flags);
        
        for (const match of text.matchAll(regex)) {
          const raw = match[0];
          const index = match.index ?? 0;
          
          if (!raw) continue;
          
          // 检查数字边界（对于手机号、身份证号、银行卡号等规则）
          if (needNumericBoundary && !passNumericBoundary(text, index, raw.length)) {
            continue;
          }
          
          matches.push({
            raw,
            index,
          });
        }
      } catch (error) {
        console.error('[检测引擎] 正则规则编译失败:', {
          ruleId: rule.id,
          ruleName: rule.name,
          pattern: rule.pattern,
          error,
        });
      }
      break;
    }
  }

  return matches;
}

// 白名单匹配
function matchWhitelist(text: string, whitelist: WhitelistRule): boolean {
  const searchText = whitelist.caseSensitive ? text : text.toLowerCase();
  const pattern = whitelist.caseSensitive ? whitelist.pattern : whitelist.pattern.toLowerCase();

  switch (whitelist.matchType) {
    case 'exact':
      return searchText === pattern;
    case 'contains':
      return searchText.includes(pattern);
    case 'prefix':
      return searchText.startsWith(pattern);
    case 'suffix':
      return searchText.endsWith(pattern);
    case 'regex':
      try {
        const flags = whitelist.caseSensitive ? 'g' : 'gi';
        return new RegExp(whitelist.pattern, flags).test(text);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

// 计算维度评分
function calculateDimensionScore(
  matchedRules: DetectionRule[],
  dimensionWeight: number,
  policyWeight: number = 1.0
): number {
  if (matchedRules.length === 0) return 0;

  // 取最高分
  const maxRuleScore = Math.max(...matchedRules.map(r => r.score), 0);

  // 其他规则衰减累加
  const extraScore = matchedRules
    .filter(r => r.score !== maxRuleScore)
    .reduce((sum, r) => sum + r.score * 0.2, 0);

  // 加权计算
  const finalScore = (maxRuleScore + extraScore) * dimensionWeight * policyWeight;

  // 限制在0-100
  return Math.min(Math.max(finalScore, 0), 100);
}

// 获取默认策略ID
export async function getDefaultPolicyId(): Promise<string | null> {
  try {
    const profiles = await db
      .select()
      .from(policyProfiles)
      .where(eq(policyProfiles.isDefault, true))
      .limit(1);

    return profiles.length > 0 ? profiles[0].id : null;
  } catch (error) {
    console.error('获取默认策略失败:', error);
    return null;
  }
}

// 获取策略配置（带缓存）- 支持从policy_dimension_config或policy_profiles.rules获取
export async function getPolicyConfig(policyId: string): Promise<CachedPolicyConfig | null> {
  // 检查缓存
  const cached = policyCache.get(policyId);
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
            eq(policyDimensionConfig.enabled, true)
          )
        );

      // 如果policy_dimension_config表有数据，使用原有逻辑
      if (dimConfigs && dimConfigs.length > 0) {
        return await buildConfigFromDimensionConfig(policyId, dimConfigs);
      }
    } catch {
      // policy_dimension_config表不存在，继续尝试从policy_rules获取
      console.log('policy_dimension_config表不存在，尝试从policy_rules获取配置');
    }

    // 从policy_rules表获取配置
    try {
      const policyRulesData = await db
        .select()
        .from(policyRules)
        .where(eq(policyRules.policyId, policyId));

      if (policyRulesData && policyRulesData.length > 0) {
        // 根据dimension code构建配置
        return await buildConfigFromPolicyRules(policyId, policyRulesData);
      }
    } catch {
      console.log('policy_rules表不存在');
    }

    return null;
  } catch (error) {
    console.error('获取策略配置失败:', error);
    return null;
  }
}

// 从policy_dimension_config表构建配置
async function buildConfigFromDimensionConfig(
  policyId: string,
  dimConfigs: typeof policyDimensionConfig.$inferSelect[]
): Promise<CachedPolicyConfig | null> {
  const dimensionIds = dimConfigs.map(dc => dc.dimensionId);
  const dimensions: DetectionDimension[] = [];
  const rules = new Map<string, DetectionRule[]>();
  const ruleGroupsMap = new Map<string, RuleGroup[]>();

  for (const dimId of dimensionIds) {
    const dimData = await db
      .select()
      .from(detectionDimensions)
      .where(eq(detectionDimensions.id, dimId))
      .limit(1);

    if (dimData && dimData.length > 0) {
      const dim = dimData[0];
      
      // 检查维度本身是否启用
      if (!dim.enabled) {
        continue; // 跳过禁用的维度
      }
      
      dimensions.push({
        id: dim.id,
        code: dim.code,
        name: dim.name,
        description: dim.description || undefined,
        category: dim.category || undefined,
        weight: parseFloat(dim.weight) || 1.0,
        priority: dim.priority,
        enabled: dim.enabled,
        isSystem: dim.isSystem,
        config: (dim.config as Record<string, unknown>) || {},
      });

      // 获取该维度的规则
      const ruleData = await db
        .select()
        .from(detectionRules)
        .where(
          and(
            eq(detectionRules.dimensionId, dimId),
            eq(detectionRules.enabled, true)
          )
        );

      rules.set(dimId, ruleData.map(r => ({
        id: r.id,
        dimensionId: r.dimensionId,
        groupId: r.groupId || undefined,
        name: r.name,
        type: r.type as 'keyword' | 'regex' | 'semantic' | 'llm',
        pattern: r.pattern || undefined,
        matchType: r.matchType as 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex',
        caseSensitive: r.caseSensitive,
        score: parseFloat(r.score) || 50,
        confidence: parseFloat(r.confidence) || 0.8,
        priority: r.priority,
        enabled: r.enabled,
        description: r.description || undefined,
        config: (r.config as Record<string, unknown>) || {},
      })));

      // 获取规则组
      const groupData = await db
        .select()
        .from(ruleGroups)
        .where(
          and(
            eq(ruleGroups.dimensionId, dimId),
            eq(ruleGroups.enabled, true)
          )
        );

      ruleGroupsMap.set(dimId, groupData.map(g => ({
        id: g.id,
        dimensionId: g.dimensionId,
        name: g.name,
        description: g.description || undefined,
        logic: g.logic as 'OR' | 'AND',
        score: parseFloat(g.score) || 50,
        priority: g.priority,
        enabled: g.enabled,
      })));
    }
  }

  // 获取白名单
  const whitelistData = await getWhitelistRules(policyId);

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

  policyCache.set(policyId, config);
  return config;
}

// 从policy_rules表构建配置
async function buildConfigFromPolicyRules(
  policyId: string,
  policyRulesData: typeof policyRules.$inferSelect[]
): Promise<CachedPolicyConfig | null> {
  const dimensions: DetectionDimension[] = [];
  const rulesMap = new Map<string, DetectionRule[]>();
  const ruleGroupsMap = new Map<string, RuleGroup[]>();
  const dimensionConfigs: PolicyDimensionConfigItem[] = [];

  // 只处理启用的维度
  const enabledRules = policyRulesData.filter(r => r.enabled);

  for (const rule of enabledRules) {
    // 根据dimension code查找维度
    const dimData = await db
      .select()
      .from(detectionDimensions)
      .where(eq(detectionDimensions.code, rule.dimension))
      .limit(1);

    if (dimData && dimData.length > 0) {
      const dim = dimData[0];

      // 检查维度本身是否启用
      if (!dim.enabled) {
        continue; // 跳过已禁用的维度
      }

      dimensions.push({
        id: dim.id,
        code: dim.code,
        name: dim.name,
        description: dim.description || undefined,
        category: dim.category || undefined,
        weight: parseFloat(dim.weight) || 1.0,
        priority: dim.priority,
        enabled: dim.enabled,
        isSystem: dim.isSystem,
        config: (dim.config as Record<string, unknown>) || {},
      });

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

      // 获取该维度的规则
      const ruleData = await db
        .select()
        .from(detectionRules)
        .where(
          and(
            eq(detectionRules.dimensionId, dim.id),
            eq(detectionRules.enabled, true)
          )
        );

      rulesMap.set(dim.id, ruleData.map(r => ({
        id: r.id,
        dimensionId: r.dimensionId,
        groupId: r.groupId || undefined,
        name: r.name,
        type: r.type as 'keyword' | 'regex' | 'semantic' | 'llm',
        pattern: r.pattern || undefined,
        matchType: r.matchType as 'exact' | 'contains' | 'prefix' | 'suffix' | 'regex',
        caseSensitive: r.caseSensitive,
        score: parseFloat(r.score) || 50,
        confidence: parseFloat(r.confidence) || 0.8,
        priority: r.priority,
        enabled: r.enabled,
        description: r.description || undefined,
        config: (r.config as Record<string, unknown>) || {},
      })));

      // 获取规则组
      const groupData = await db
        .select()
        .from(ruleGroups)
        .where(
          and(
            eq(ruleGroups.dimensionId, dim.id),
            eq(ruleGroups.enabled, true)
          )
        );

      ruleGroupsMap.set(dim.id, groupData.map(g => ({
        id: g.id,
        dimensionId: g.dimensionId,
        name: g.name,
        description: g.description || undefined,
        logic: g.logic as 'OR' | 'AND',
        score: parseFloat(g.score) || 50,
        priority: g.priority,
        enabled: g.enabled,
      })));
    }
  }

  // 获取白名单
  const whitelistData = await getWhitelistRules(policyId);

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

  policyCache.set(policyId, config);
  return config;
}

// 获取白名单规则（新版：支持策略范围和维度范围）
async function getWhitelistRules(policyId: string): Promise<WhitelistRule[]> {
  try {
    // 获取所有启用的白名单规则
    const allWhitelists = await db
      .select()
      .from(whitelistRules)
      .where(eq(whitelistRules.enabled, true));

    // 获取策略绑定
    const policyBindings = await db.select().from(whitelistRulePolicies);

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
    console.error('获取白名单规则失败:', error);
    // whitelist_rules表可能不存在
    return [];
  }
}

// 执行动态检测
export async function detectWithDynamicRules(
  text: string,
  policyId: string,
  direction: 'input' | 'output' = 'input'
): Promise<DetectionResult> {
  const startTime = Date.now();
  
  // 获取策略配置
  const config = await getPolicyConfig(policyId);
  if (!config) {
    return {
      overallScore: 0,
      action: 'allow',
      findings: [],
      summary: '未找到策略配置，请检查数据库是否已初始化',
    };
  }

  // 获取所有维度信息，用于返回跳过的维度名称
  const allDimensions = await getAllDimensions();
  const dimensionNameMap = new Map(allDimensions.map(d => [d.code, d.name]));

  // 按 priority 从高到低排序白名单
  const sortedWhitelists = [...config.whitelists].sort((a, b) => 
    (b.priority || 100) - (a.priority || 100)
  );

  // 先检查 dimensionScope = 'all' 的全局白名单
  for (const whitelist of sortedWhitelists.filter(w => w.dimensionScope === 'all')) {
    if (matchWhitelist(text, whitelist)) {
      // 命中全局白名单，跳过所有检测
      return {
        overallScore: 0,
        action: 'allow',
        findings: [],
        summary: `命中全局白名单「${whitelist.name || '未命名'}」，已跳过所有风险检测`,
        latencyMs: Date.now() - startTime,
        whitelistMatched: {
          id: whitelist.id,
          name: whitelist.name || '未命名白名单',
          policyScope: whitelist.policyScope,
          dimensionScope: whitelist.dimensionScope,
          dimensionCodes: [],
          pattern: whitelist.pattern,
          matchType: whitelist.matchType,
          effect: 'skip_all_detection',
        },
        skippedDimensions: allDimensions.map(d => ({
          dimensionCode: d.code,
          dimensionName: d.name,
          whitelistId: whitelist.id,
          whitelistName: whitelist.name || '未命名白名单',
          effect: 'skip_dimension_detection' as const,
        })),
      };
    }
  }

  // 记录被跳过的维度
  const skippedDimensions: SkippedDimension[] = [];
  const skippedDimensionCodes = new Set<string>();

  // 检查维度白名单
  for (const whitelist of sortedWhitelists.filter(w => w.dimensionScope === 'specific')) {
    if (matchWhitelist(text, whitelist)) {
      // 命中维度白名单，记录要跳过的维度
      for (const dimCode of whitelist.dimensionCodes) {
        if (!skippedDimensionCodes.has(dimCode)) {
          skippedDimensionCodes.add(dimCode);
          skippedDimensions.push({
            dimensionCode: dimCode,
            dimensionName: dimensionNameMap.get(dimCode) || dimCode,
            whitelistId: whitelist.id,
            whitelistName: whitelist.name || '未命名白名单',
            effect: 'skip_dimension_detection',
          });
        }
      }
    }
  }

  const findings: DetectionFinding[] = [];
  let maxScore = 0;
  let finalAction: 'allow' | 'warn' | 'block' | 'mask' | 'rewrite' = 'allow';

  // 遍历每个维度进行检测
  for (const dimension of config.dimensions) {
    const dimConfig = config.dimensionConfigs.find(dc => dc.dimensionId === dimension.id);
    if (!dimConfig || !dimConfig.enabled) continue;

    // 检查该维度是否被白名单跳过
    if (skippedDimensionCodes.has(dimension.code)) {
      continue; // 跳过该维度检测
    }

    // 获取该维度的规则
    const dimRules = config.rules.get(dimension.id) || [];

    // 执行规则匹配 - 每个规则的每个匹配生成独立的 finding
    for (const rule of dimRules) {
      // 只处理关键词和正则类型规则
      if (rule.type !== 'keyword' && rule.type !== 'regex') continue;
      if (!rule.pattern) continue;

      // 获取所有匹配
      const allMatches = matchRuleAll(text, rule);
      if (allMatches.length === 0) continue;

      // 为每个匹配生成独立的 finding
      for (const match of allMatches) {
        const evidence = match.raw;
        
        // 计算该规则的风险分数
        const policyWeight = dimConfig.customWeight || 1.0;
        const ruleScore = rule.score * dimension.weight * policyWeight;
        const score = Math.min(Math.max(ruleScore, 0), 100);

        // 确定动作
        let ruleAction: 'allow' | 'warn' | 'block' = 'allow';
        if (score >= dimConfig.blockThreshold && dimConfig.blockEnabled) {
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

        if (score > maxScore) {
          maxScore = score;
          if (ruleAction === 'block') {
            finalAction = 'block';
          } else if (ruleAction === 'warn' && finalAction !== 'block') {
            finalAction = 'warn';
          }
        }
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

  try {
    // 获取裁判模型配置
    const judgeConfig = await getJudgeConfig(policyId);

    // 判断是否需要调用裁判模型
    if (judgeConfig && shouldInvokeJudge(judgeConfig, direction, maxScore, findings, text)) {
      // 执行裁判模型检测
      judgeModelResult = await executeJudgeDetection(
        text,
        direction,
        findings,
        maxScore,
        judgeConfig
      );

      // 获取第一个维度的阈值配置（用于融合决策）
      const firstDimConfig = config.dimensionConfigs[0];
      const warnThreshold = firstDimConfig?.warnThreshold || 50;
      const blockThreshold = firstDimConfig?.blockThreshold || 80;

      // 融合规则检测和裁判模型结果
      decisionTrace = fuseResults(
        maxScore,
        finalAction,
        judgeModelResult,
        judgeConfig,
        warnThreshold,
        blockThreshold
      );

      // 更新最终结果
      finalOverallScore = decisionTrace.finalScore;
      finalFinalAction = decisionTrace.finalAction;
    }
  } catch (error) {
    console.error('裁判模型检测失败:', error);
    // 记录更多错误信息
    if (error instanceof Error) {
      console.error('裁判模型错误详情:', error.message, error.stack?.substring(0, 200));
    }
    // 裁判模型失败时继续使用规则检测结果
  }

  // 生成摘要（考虑裁判模型结果）
  let summary = generateSummary(findings, finalFinalAction, processingAction, skippedDimensions);
  if (decisionTrace) {
    summary = `${summary}；${decisionTrace.reasoning}`;
  }

  // 计算 effectiveAction：组合 action 和 processingAction
  // 当 processingAction 有值且不为 none 时，effectiveAction = processingAction
  // 否则 effectiveAction = action
  const effectiveAction = processingAction && processingAction !== 'none'
    ? processingAction
    : finalFinalAction;

  return {
    overallScore: finalOverallScore,
    action: finalFinalAction,
    processingAction, // 新增：处理动作（mask/rewrite/none）
    effectiveAction, // 新增：有效动作（便于前端判断）
    findings,
    summary,
    latencyMs: Date.now() - startTime,
    skippedDimensions: skippedDimensions.length > 0 ? skippedDimensions : undefined,
    judgeModelResult: judgeModelResult ? {
      used: judgeModelResult.used,
      score: judgeModelResult.score,
      confidence: judgeModelResult.confidence,
      suggestedAction: judgeModelResult.suggestedAction,
      reason: judgeModelResult.reason,
      latencyMs: judgeModelResult.latencyMs,
      error: judgeModelResult.error,
    } : undefined,
    decisionTrace,
  };
}

// 生成摘要
function generateSummary(
  findings: DetectionFinding[],
  action: string,
  processingAction?: 'none' | 'mask' | 'rewrite',
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

  // 显示决策动作和处理动作
  let actionDesc = actionText[action] || action;
  if (processingAction && processingAction !== 'none' && action !== 'block') {
    const processingText = processingAction === 'mask' ? '已脱敏' : '已改写';
    actionDesc = `${actionText[action]}（${processingText}）`;
  }
  
  parts.push(`最终动作: ${actionDesc}`);

  return parts.join('；');
}

// 获取所有启用的维度
export async function getAllDimensions(): Promise<DetectionDimension[]> {
  const dimensions = await db
    .select()
    .from(detectionDimensions)
    .where(eq(detectionDimensions.enabled, true));

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
