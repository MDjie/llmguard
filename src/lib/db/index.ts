/**
 * 数据库操作封装
 * 使用 Supabase SDK 执行数据库操作
 */

import { getSupabaseClient } from '@/storage/database/supabase-client';

// 获取 Supabase 客户端
export function getDb() {
  return getSupabaseClient();
}

// 通用查询函数
export async function query<T>(table: string, options?: {
  select?: string;
  filter?: Record<string, unknown>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
  single?: boolean;
}): Promise<T[]> {
  const client = getDb();
  let query = client.from(table).select(options?.select || '*');

  if (options?.filter) {
    Object.entries(options.filter).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        query = query.eq(key, value);
      }
    });
  }

  if (options?.order) {
    query = query.order(options.order.column, { 
      ascending: options.order.ascending ?? false 
    });
  }

  if (options?.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = options?.single 
    ? await query.single()
    : await query;

  if (error) {
    throw new Error(`Failed query: ${error.message}`);
  }

  return data as T[];
}

// 插入数据
export async function insert<T>(table: string, data: Record<string, unknown> | Record<string, unknown>[]): Promise<T> {
  const client = getDb();
  const { data: result, error } = await client
    .from(table)
    .insert(data)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed insert: ${error.message}`);
  }

  return result as T;
}

// 更新数据
export async function update<T>(table: string, id: string, data: Record<string, unknown>): Promise<T> {
  const client = getDb();
  const { data: result, error } = await client
    .from(table)
    .update(data)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed update: ${error.message}`);
  }

  return result as T;
}

// 删除数据
export async function remove<T>(table: string, id: string): Promise<T> {
  const client = getDb();
  const { data: result, error } = await client
    .from(table)
    .delete()
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed delete: ${error.message}`);
  }

  return result as T;
}
