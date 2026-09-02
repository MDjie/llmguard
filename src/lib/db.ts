/**
 * 数据库访问适配器
 * 提供类似 Supabase 风格的 API，内部使用 Drizzle ORM
 */

import { db } from '@/storage/database/shared/db';
import {
  detectionDimensions,
  detectionRules,
  ruleGroups,
  detectionSessions,
  detectionRecords,
  riskFindings,
  policyProfiles,
  policyRules,
  whitelistRules,
  whitelistRulePolicies,
  llmProviders,
  policyDimensionConfig,
  agentTraces,
  testCases,
  evaluationRuns,
  evaluationResults,
  keywordCategories,
  keywordRules,
  policyVersions,
  documentScanTasks,
  documentScanFindings,
  users,
  policyJudgeConfigs,
  judgeModelInvocations,
  userPolicyStates,
  securityAuditEvents,
  exportApprovalRequests,
} from '@/storage/database/shared/schema';
import { eq, and, or, desc, asc, sql, inArray, isNotNull, isNull, lt, gt, gte, lte, like, ilike, not, ne } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn, PgTable, TableConfig } from 'drizzle-orm/pg-core';
import { getCurrentTenantScope } from '@/lib/tenancy/runtime';
import { logger } from '@/lib/observability/logger';

// 表名到 schema 的映射
type DynamicTable = PgTable<TableConfig>;
type DynamicColumn = PgColumn;
type CompatibilityRow = Record<string, unknown>;
interface CompatibilityError {
  readonly code: 'DB_OPERATION_FAILED';
  readonly message: 'Database operation failed';
}
type CompatibilityResult<T> = {
  readonly data: T | null;
  readonly error: CompatibilityError | null;
  readonly count?: number;
};

interface QueryOptions {
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly single?: boolean;
  readonly order?: { readonly column: string; readonly ascending?: boolean };
  readonly limit?: number;
  readonly offset?: number;
}

function compatibilityError(): CompatibilityError {
  return { code: 'DB_OPERATION_FAILED', message: 'Database operation failed' };
}

const tableMap: Readonly<Record<string, DynamicTable>> = {
  'detection_dimensions': detectionDimensions,
  'detection_rules': detectionRules,
  'rule_groups': ruleGroups,
  'detection_sessions': detectionSessions,
  'detection_records': detectionRecords,
  'risk_findings': riskFindings,
  'policy_profiles': policyProfiles,
  'policy_rules': policyRules,
  'whitelist_rules': whitelistRules,
  'whitelist_rule_policies': whitelistRulePolicies,
  'llm_providers': llmProviders,
  'policy_dimension_config': policyDimensionConfig,
  'agent_traces': agentTraces,
  'test_cases': testCases,
  'evaluation_runs': evaluationRuns,
  'evaluation_results': evaluationResults,
  'keyword_categories': keywordCategories,
  'keyword_rules': keywordRules,
  'policy_versions': policyVersions,
  'document_scan_tasks': documentScanTasks,
  'document_scan_findings': documentScanFindings,
  'users': users,
  'policy_judge_configs': policyJudgeConfigs,
  'judge_model_invocations': judgeModelInvocations,
  'user_policy_states': userPolicyStates,
  'security_audit_events': securityAuditEvents,
  'export_approval_requests': exportApprovalRequests,
};

// snake_case 转 camelCase
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

// camelCase 转 snake_case
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

export function mapCompatibilityRow(
  row: Readonly<Record<string, unknown>>,
  fields: readonly string[] = ['*'],
): CompatibilityRow {
  const mapped = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [camelToSnake(key), value]),
  );
  if (fields.includes('*')) return mapped;
  return Object.fromEntries(fields.filter((field) => field in mapped).map((field) => [field, mapped[field]]));
}

// 获取 schema 字段（支持 snake_case 和 camelCase 输入）
function getSchemaField(schema: DynamicTable, columnName: string): DynamicColumn | null {
  const fields = schema as unknown as Readonly<Record<string, unknown>>;
  // 直接尝试 camelCase（Drizzle schema 属性名）
  if (fields[columnName]) {
    return fields[columnName] as DynamicColumn;
  }
  // 转换 snake_case 到 camelCase
  const camelName = snakeToCamel(columnName);
  if (fields[camelName]) {
    return fields[camelName] as DynamicColumn;
  }
  return null;
}

// 查询构建器类
class QueryBuilder<T extends object = CompatibilityRow> {
  private tableName: string;
  private schema: DynamicTable;
  private conditions: SQL<unknown>[] = [];
  private orderByClause: { column: string; direction: 'asc' | 'desc' }[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private selectFields: string[] = ['*'];
  private countMode: 'exact' | 'estimated' | null = null;
  private headOnly: boolean = false;
  private operationType: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private insertData: CompatibilityRow[] | null = null;
  private updateData: CompatibilityRow | null = null;

  constructor(tableName: string) {
    this.tableName = tableName;
    this.schema = tableMap[tableName];
    if (!this.schema) {
      throw new Error(`Unknown table: ${tableName}`);
    }
  }

  private scopedConditions(): SQL<unknown>[] {
    const scope = getCurrentTenantScope();
    const tenantId = getSchemaField(this.schema, 'tenantId');
    const applicationId = getSchemaField(this.schema, 'applicationId');
    if (!scope || !tenantId || !applicationId) {
      return this.conditions;
    }
    return [
      ...this.conditions,
      eq(tenantId, scope.tenantId),
      eq(applicationId, scope.applicationId),
    ];
  }

  select(
    fields: string | string[] = '*',
    options?: { count?: 'exact' | 'estimated'; head?: boolean },
  ) {
    if (typeof fields === 'string') {
      this.selectFields = fields === '*'
        ? ['*']
        : fields.split(',').map((field) => field.trim()).filter(Boolean);
    } else {
      this.selectFields = fields;
    }
    if (options?.count) {
      this.countMode = options.count;
    }
    if (options?.head) {
      this.headOnly = true;
    }
    return this;
  }

  eq(column: string, value: unknown) {
    if (value !== undefined && value !== null) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(eq(field, value));
      } else {
        logger.warn('database.compatibility.filter_field_missing', {
          table: this.tableName,
          column,
        });
      }
    }
    return this;
  }

  neq(column: string, value: unknown) {
    if (value !== undefined && value !== null) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(ne(field, value));
      }
    }
    return this;
  }

  gte(column: string, value: unknown) {
    if (value !== undefined && value !== null) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(gte(field, value));
      } else {
        logger.warn('database.compatibility.filter_field_missing', {
          table: this.tableName,
          column,
        });
      }
    }
    return this;
  }

  lte(column: string, value: unknown) {
    if (value !== undefined && value !== null) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(lte(field, value));
      }
    }
    return this;
  }

  gt(column: string, value: unknown) {
    if (value !== undefined && value !== null) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(gt(field, value));
      }
    }
    return this;
  }

  lt(column: string, value: unknown) {
    if (value !== undefined && value !== null) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(lt(field, value));
      }
    }
    return this;
  }

  like(column: string, pattern: string) {
    if (pattern) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(like(field, pattern));
      }
    }
    return this;
  }

  ilike(column: string, pattern: string) {
    if (pattern) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(ilike(field, pattern));
      }
    }
    return this;
  }

  in(column: string, values: readonly unknown[]) {
    if (values && values.length > 0) {
      const field = getSchemaField(this.schema, column);
      if (field) {
        this.conditions.push(inArray(field, values));
      }
    }
    return this;
  }

  isNull(column: string) {
    const field = getSchemaField(this.schema, column);
    if (field) {
      this.conditions.push(isNull(field));
    }
    return this;
  }

  isNotNull(column: string) {
    const field = getSchemaField(this.schema, column);
    if (field) {
      this.conditions.push(isNotNull(field));
    }
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    const orderFn = options?.ascending ? asc : desc;
    this.orderByClause.push({
      column,
      direction: options?.ascending ? 'asc' : 'desc',
    });
    return this;
  }

  limit(count: number) {
    this.limitValue = count;
    return this;
  }

  offset(count: number) {
    this.offsetValue = count;
    return this;
  }

  range(start: number, end: number) {
    this.offsetValue = start;
    this.limitValue = end - start + 1;
    return this;
  }

  async single(): Promise<CompatibilityResult<T>> {
    this.limitValue = 1;
    const result = await this.execute();
    return {
      ...result,
      data: result.data?.[0] ?? null,
    };
  }

  maybeSingle(): Promise<CompatibilityResult<T>> {
    return this.single();
  }

  async execute(): Promise<CompatibilityResult<T[]>> {
    try {
      // 构建查询
      // 过滤掉无效的条件（undefined 或 null）
      const validConditions = this.scopedConditions().filter(c => c !== undefined && c !== null);

      if (this.headOnly) {
        // 只获取计数，不返回数据
        const result = await db
          .select({ count: sql<number>`count(*)` })
          .from(this.schema)
          .where(validConditions.length > 0 ? and(...validConditions) : undefined);

        return {
          data: null,
          error: null,
          count: result[0]?.count || 0,
        };
      }

      // 正常查询
      let query = db.select().from(this.schema).$dynamic();

      if (validConditions.length > 0) {
        query = query.where(and(...validConditions));
      }

      if (this.orderByClause.length > 0) {
        const orderClauses = this.orderByClause.map(o => {
          const orderFn = o.direction === 'asc' ? asc : desc;
          const field = getSchemaField(this.schema, o.column);
          if (!field) {
            logger.warn('database.compatibility.order_field_missing', {
              table: this.tableName,
              column: o.column,
            });
            return null;
          }
          return orderFn(field);
        }).filter((item): item is SQL => item !== null);
        if (orderClauses.length > 0) {
          query = query.orderBy(...orderClauses);
        }
      }

      if (this.limitValue !== null) {
        query = query.limit(this.limitValue);
      }

      if (this.offsetValue !== null) {
        query = query.offset(this.offsetValue);
      }

      const rows = await query as unknown as Readonly<Record<string, unknown>>[];
      const data = rows.map((row) => mapCompatibilityRow(row, this.selectFields)) as T[];

      // 如果请求了 count，额外查询总数
      if (this.countMode) {
        const countResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(this.schema)
          .where(validConditions.length > 0 ? and(...validConditions) : undefined);

        return {
          data,
          error: null,
          count: countResult[0]?.count || 0,
        };
      }

      return {
        data,
        error: null,
        count: data.length,
      };
    } catch (error) {
      logger.error('database.compatibility.query_failed', { table: this.tableName, error });
      return {
        data: null,
        error: compatibilityError(),
        count: 0,
      };
    }
  }

  // 插入 - 返回 this 支持链式调用
  insert(data: CompatibilityRow | readonly CompatibilityRow[]) {
    this.operationType = 'insert';
    this.insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  // 实际执行插入
  async executeInsert(): Promise<CompatibilityResult<T[]>> {
    try {
      if (!this.insertData || this.insertData.length === 0) {
        throw new Error('No data provided for insert');
      }
      // 转换 snake_case 字段名到 camelCase（匹配 Drizzle schema）
      const scope = getCurrentTenantScope();
      const convertedData = this.insertData.map((item: Record<string, unknown>) => {
        const converted: CompatibilityRow = {};
        for (const [key, value] of Object.entries(item)) {
          const camelKey = snakeToCamel(key);
          // 如果是 ISO 字符串格式的日期，转换为 Date 对象
          if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
            converted[camelKey] = new Date(value);
          } else {
            converted[camelKey] = value;
          }
        }
        if (scope && getSchemaField(this.schema, 'tenantId') && getSchemaField(this.schema, 'applicationId')) {
          converted.tenantId = scope.tenantId;
          converted.applicationId = scope.applicationId;
        }
        return converted;
      });
      const inserted = ((await db.insert(this.schema).values(convertedData).returning()) as unknown) as Readonly<Record<string, unknown>>[];
      const result = inserted.map((row) => mapCompatibilityRow(row, this.selectFields)) as T[];
      return {
        data: result,
        error: null,
      };
    } catch (error) {
      logger.error('database.compatibility.insert_failed', { table: this.tableName, error });
      return {
        data: null,
        error: compatibilityError(),
      };
    }
  }

  // 更新 - 返回 this 支持链式调用
  update(data: CompatibilityRow) {
    this.operationType = 'update';
    this.updateData = data;
    return this;
  }

  // 实际执行更新
  async executeUpdate(): Promise<CompatibilityResult<T[]>> {
    try {
      if (this.conditions.length === 0) {
        throw new Error('Update requires at least one condition');
      }
      if (!this.updateData) {
        throw new Error('No data provided for update');
      }
      // 转换 snake_case 字段名到 camelCase
      const convertedData: CompatibilityRow = {};
      for (const [key, value] of Object.entries(this.updateData)) {
        const camelKey = snakeToCamel(key);
        // 如果是 ISO 字符串格式的日期，转换为 Date 对象
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
          convertedData[camelKey] = new Date(value);
        } else {
          convertedData[camelKey] = value;
        }
      }
      const scopedConditions = this.scopedConditions();
      const updated = ((await db
        .update(this.schema)
        .set(convertedData)
        .where(and(...scopedConditions))
        .returning()) as unknown) as Readonly<Record<string, unknown>>[];
      const result = updated.map((row) => mapCompatibilityRow(row, this.selectFields)) as T[];
      return {
        data: result,
        error: null,
      };
    } catch (error) {
      logger.error('database.compatibility.update_failed', { table: this.tableName, error });
      return {
        data: null,
        error: compatibilityError(),
      };
    }
  }

  // 返回 this 以支持链式调用
  delete() {
    this.operationType = 'delete';
    return this;
  }

  // 实际执行删除
  async executeDelete(): Promise<CompatibilityResult<T[]>> {
    try {
      if (this.conditions.length === 0) {
        throw new Error('Delete requires at least one condition');
      }
      const scopedConditions = this.scopedConditions();
      const deleted = ((await db
        .delete(this.schema)
        .where(and(...scopedConditions))
        .returning()) as unknown) as Readonly<Record<string, unknown>>[];
      const result = deleted.map((row) => mapCompatibilityRow(row, this.selectFields)) as T[];
      return {
        data: result,
        error: null,
      };
    } catch (error) {
      logger.error('database.compatibility.delete_failed', { table: this.tableName, error });
      return {
        data: null,
        error: compatibilityError(),
      };
    }
  }

  // 使 thenable 以支持 await
  then<TResult1 = CompatibilityResult<T[]>, TResult2 = never>(
    resolve?: ((value: CompatibilityResult<T[]>) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    if (this.operationType === 'delete') {
      return this.executeDelete().then(resolve, reject);
    }
    if (this.operationType === 'insert') {
      return this.executeInsert().then(resolve, reject);
    }
    if (this.operationType === 'update') {
      return this.executeUpdate().then(resolve, reject);
    }
    return this.execute().then(resolve, reject);
  }
}

// 数据库客户端
class DatabaseClient {
  from<T extends object = CompatibilityRow>(tableName: string) {
    return new QueryBuilder<T>(tableName);
  }
}

// 导出单例
const dbClient = new DatabaseClient();

export function getDb() {
  return dbClient;
}

// 导出辅助函数供直接使用
export function query<T extends object>(
  table: string,
  options: QueryOptions & { readonly single: true },
): Promise<CompatibilityResult<T>>;
export function query<T extends object = CompatibilityRow>(
  table: string,
  options?: QueryOptions & { readonly single?: false | undefined },
): Promise<CompatibilityResult<T[]>>;
export function query<T extends object = CompatibilityRow>(
  table: string,
  options?: QueryOptions,
): Promise<CompatibilityResult<T> | CompatibilityResult<T[]>> {
  const builder = new QueryBuilder<T>(table);
  if (options?.filter) {
    Object.entries(options.filter).forEach(([key, value]) => {
      builder.eq(key, value);
    });
  }
  if (options?.order) {
    builder.order(options.order.column, { ascending: options.order.ascending });
  }
  if (options?.limit !== undefined) {
    builder.limit(options.limit);
  }
  if (options?.offset !== undefined) {
    builder.offset(options.offset);
  }
  if (options?.single) {
    return builder.single();
  }
  return builder.execute();
}

export async function update<T extends object = CompatibilityRow>(
  table: string,
  id: string,
  data: CompatibilityRow,
) {
  const builder = new QueryBuilder<T>(table);
  builder.eq('id', id);
  return builder.update(data);
}

export async function remove(table: string, id: string) {
  const builder = new QueryBuilder(table);
  builder.eq('id', id);
  return builder.delete();
}

export async function insert<T extends object = CompatibilityRow>(
  table: string,
  data: CompatibilityRow,
) {
  const builder = new QueryBuilder<T>(table);
  return builder.insert(data);
}

// 导出 Drizzle 实例供需要直接使用的场景（复杂查询）
export { db, eq, and, or, desc, asc, sql, inArray, lt, gt, gte, lte, like, ilike, isNull, isNotNull, not, ne };

// 导出 schema 供直接使用
export {
  detectionDimensions,
  detectionRules,
  ruleGroups,
  detectionSessions,
  detectionRecords,
  riskFindings,
  policyProfiles,
  policyRules,
  whitelistRules,
  whitelistRulePolicies,
  llmProviders,
  policyDimensionConfig,
  agentTraces,
  testCases,
  evaluationRuns,
  keywordCategories,
  keywordRules,
  policyVersions,
  documentScanTasks,
  documentScanFindings,
  users,
  userPolicyStates,
  securityAuditEvents,
  exportApprovalRequests,
} from '@/storage/database/shared/schema';
