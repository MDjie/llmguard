/**
 * 创建缺失的数据库表
 * 用于修复表不存在的问题
 */

import { db } from './db';
import { sql } from 'drizzle-orm';

async function createMissingTables() {
  console.log('开始创建缺失的数据库表...');

  try {
    // 创建 whitelist_rules 表（新版结构）
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS whitelist_rules (
        id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        application_id VARCHAR(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        -- 兼容旧字段
        policy_id VARCHAR(36) REFERENCES policy_profiles(id) ON DELETE CASCADE,
        dimension_id VARCHAR(36) REFERENCES detection_dimensions(id) ON DELETE CASCADE,
        -- 受治理的目标范围
        name VARCHAR(200),
        description TEXT,
        policy_scope VARCHAR(20) NOT NULL DEFAULT 'specific',
        dimension_scope VARCHAR(20) NOT NULL DEFAULT 'specific',
        dimension_codes JSONB NOT NULL DEFAULT '[]',
        target_rule_ids JSONB NOT NULL DEFAULT '[]',
        directions JSONB NOT NULL DEFAULT '[]',
        valid_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE,
        approval_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        approved_by VARCHAR(100),
        approved_at TIMESTAMP WITH TIME ZONE,
        priority INTEGER NOT NULL DEFAULT 100,
        -- 匹配规则
        pattern TEXT NOT NULL,
        match_type VARCHAR(20) NOT NULL DEFAULT 'contains',
        case_sensitive BOOLEAN NOT NULL DEFAULT false,
        enabled BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE
      );
    `);
    console.log('✅ whitelist_rules 表创建成功');

    await db.execute(sql`
      ALTER TABLE whitelist_rules
        ADD COLUMN IF NOT EXISTS target_rule_ids JSONB NOT NULL DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS directions JSONB NOT NULL DEFAULT '[]',
        ADD COLUMN IF NOT EXISTS valid_from TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS approval_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS approved_by VARCHAR(100),
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE;
    `);

    // 创建 whitelist_rules 索引
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rules_policy_id_idx ON whitelist_rules(policy_id);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rules_dimension_id_idx ON whitelist_rules(dimension_id);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rules_policy_scope_idx ON whitelist_rules(policy_scope);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rules_dimension_scope_idx ON whitelist_rules(dimension_scope);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rules_enabled_idx ON whitelist_rules(enabled);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rules_priority_idx ON whitelist_rules(priority);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rules_expires_at_idx ON whitelist_rules(expires_at);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rules_approval_idx ON whitelist_rules(approval_status, valid_from);
    `);
    console.log('✅ whitelist_rules 索引创建成功');

    // 创建 whitelist_rule_policies 表
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS whitelist_rule_policies (
        id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
        application_id VARCHAR(36) NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
        whitelist_rule_id VARCHAR(36) NOT NULL REFERENCES whitelist_rules(id) ON DELETE CASCADE,
        policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE(tenant_id, application_id, whitelist_rule_id, policy_id)
      );
    `);
    console.log('✅ whitelist_rule_policies 表创建成功');

    // 创建 whitelist_rule_policies 索引
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rule_policies_whitelist_rule_id_idx ON whitelist_rule_policies(whitelist_rule_id);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS whitelist_rule_policies_policy_id_idx ON whitelist_rule_policies(policy_id);
    `);
    console.log('✅ whitelist_rule_policies 索引创建成功');

    // 为 detection_sessions 添加白名单命中信息字段
    await db.execute(sql`
      ALTER TABLE detection_sessions 
      ADD COLUMN IF NOT EXISTS whitelist_matched JSONB;
    `);
    await db.execute(sql`
      ALTER TABLE detection_sessions 
      ADD COLUMN IF NOT EXISTS skipped_dimensions JSONB DEFAULT '[]';
    `);
    console.log('✅ detection_sessions 白名单字段添加成功');

    // 创建 policy_dimension_config 表（如果不存在）
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS policy_dimension_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
        dimension_id UUID NOT NULL REFERENCES detection_dimensions(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT true,
        warn_enabled BOOLEAN NOT NULL DEFAULT true,
        block_enabled BOOLEAN NOT NULL DEFAULT true,
        warn_threshold INTEGER NOT NULL DEFAULT 50,
        block_threshold INTEGER NOT NULL DEFAULT 80,
        auto_mask BOOLEAN NOT NULL DEFAULT false,
        auto_rewrite BOOLEAN NOT NULL DEFAULT false,
        custom_weight DECIMAL(5, 2),
        action_config JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ policy_dimension_config 表创建成功');

    // 创建索引
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS policy_dimension_config_policy_id_idx ON policy_dimension_config(policy_id);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS policy_dimension_config_dimension_id_idx ON policy_dimension_config(dimension_id);
    `);
    console.log('✅ policy_dimension_config 索引创建成功');

    // 创建 document_scan_tasks 表
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS document_scan_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_name VARCHAR(500) NOT NULL,
        file_type VARCHAR(50) NOT NULL,
        file_size INTEGER,
        policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        status_message TEXT,
        extracted_text TEXT,
        parsed_chunks JSONB DEFAULT '[]',
        ocr_enabled BOOLEAN DEFAULT FALSE,
        ocr_results JSONB DEFAULT '[]',
        overall_score INTEGER,
        final_action VARCHAR(20),
        findings_count INTEGER DEFAULT 0,
        whitelist_matched JSONB,
        skipped_dimensions JSONB,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE
      );
    `);
    console.log('✅ document_scan_tasks 表创建成功');

    // 创建 document_scan_tasks 索引
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_scan_tasks_policy_id_idx ON document_scan_tasks(policy_id);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_scan_tasks_status_idx ON document_scan_tasks(status);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_scan_tasks_created_at_idx ON document_scan_tasks(created_at);
    `);
    console.log('✅ document_scan_tasks 索引创建成功');

    // 创建 document_scan_findings 表
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS document_scan_findings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id UUID NOT NULL REFERENCES document_scan_tasks(id) ON DELETE CASCADE,
        chunk_index INTEGER,
        line_number INTEGER,
        start_offset INTEGER,
        end_offset INTEGER,
        dimension_id UUID,
        dimension_code VARCHAR(100),
        dimension_name VARCHAR(200),
        rule_id UUID,
        rule_name VARCHAR(200),
        rule_type VARCHAR(20),
        score INTEGER NOT NULL,
        severity VARCHAR(20) NOT NULL,
        action VARCHAR(20) NOT NULL,
        evidence JSONB DEFAULT '[]',
        masked_evidence JSONB DEFAULT '[]',
        reason TEXT,
        suggestion TEXT,
        whitelist_matched JSONB,
        skipped_dimensions JSONB,
        status VARCHAR(20) DEFAULT 'open' NOT NULL,
        ignore_reason VARCHAR(50),
        ignore_note TEXT,
        ignored_at TIMESTAMP WITH TIME ZONE,
        ignored_by VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ document_scan_findings 表创建成功');

    // 创建 document_scan_findings 索引
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_scan_findings_task_id_idx ON document_scan_findings(task_id);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_scan_findings_dimension_code_idx ON document_scan_findings(dimension_code);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_scan_findings_status_idx ON document_scan_findings(status);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS document_scan_findings_severity_idx ON document_scan_findings(severity);
    `);
    console.log('✅ document_scan_findings 索引创建成功');

    console.log('\n所有缺失的表已创建完成！');
  } catch (error) {
    console.error('创建表失败:', error);
    throw error;
  }
}

// 执行创建
createMissingTables()
  .then(() => {
    console.log('数据库初始化完成');
    process.exit(0);
  })
  .catch((error) => {
    console.error('数据库初始化失败:', error);
    process.exit(1);
  });
