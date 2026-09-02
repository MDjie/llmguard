-- =====================================================
-- GuardLLM 数据库初始化脚本
-- 基于 schema.ts 自动同步生成
-- 生成时间: 2026-06-10
-- =====================================================

-- 启用必要的扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. 健康检查表 (health_check)
-- =====================================================
DROP TABLE IF EXISTS health_check CASCADE;
CREATE TABLE health_check (
  id SERIAL PRIMARY KEY,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 2. 密钥信封表 (secret_envelopes)
-- =====================================================
DROP TABLE IF EXISTS secret_envelopes CASCADE;
CREATE TABLE secret_envelopes (
  ref VARCHAR(80) PRIMARY KEY,
  key_id VARCHAR(100) NOT NULL,
  algorithm VARCHAR(30) NOT NULL DEFAULT 'AES-256-GCM',
  iv VARCHAR(32) NOT NULL,
  ciphertext TEXT NOT NULL,
  auth_tag VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX secret_envelopes_key_id_idx ON secret_envelopes(key_id);

-- =====================================================
-- 3. LLM 提供商表 (llm_providers)
-- =====================================================
DROP TABLE IF EXISTS llm_providers CASCADE;
CREATE TABLE llm_providers (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(200) NOT NULL,
  provider_type VARCHAR(50) NOT NULL,
  base_url VARCHAR(500),
  secret_ref VARCHAR(80) REFERENCES secret_envelopes(ref) ON DELETE SET NULL,
  api_key_encrypted TEXT,
  default_model VARCHAR(100),
  use_case VARCHAR(20),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_default_target BOOLEAN NOT NULL DEFAULT FALSE,
  is_default_judge BOOLEAN NOT NULL DEFAULT FALSE,
  avg_latency_ms INTEGER,
  last_test_at TIMESTAMPTZ,
  last_test_success BOOLEAN,
  config_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ,
  created_by VARCHAR(100) DEFAULT 'system' NOT NULL
);

CREATE INDEX llm_providers_name_idx ON llm_providers(name);
CREATE INDEX llm_providers_is_enabled_idx ON llm_providers(is_enabled);

-- =====================================================
-- 3. 策略方案表 (policy_profiles)
-- =====================================================
DROP TABLE IF EXISTS policy_profiles CASCADE;
CREATE TABLE policy_profiles (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  tags JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  -- 策略升级字段
  escalation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_threshold INTEGER NOT NULL DEFAULT 5,
  escalation_target_policy_id VARCHAR(36) REFERENCES policy_profiles(id),
  deescalation_threshold INTEGER NOT NULL DEFAULT 1,
  escalation_cooldown_minutes INTEGER NOT NULL DEFAULT 30,
  -- 基础字段
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ,
  created_by VARCHAR(100) DEFAULT 'system' NOT NULL
);

CREATE INDEX policy_profiles_name_idx ON policy_profiles(name);
CREATE INDEX policy_profiles_is_default_idx ON policy_profiles(is_default);
CREATE INDEX policy_profiles_is_active_idx ON policy_profiles(is_active);

-- =====================================================
-- 4. 检测维度表 (detection_dimensions)
-- =====================================================
DROP TABLE IF EXISTS detection_dimensions CASCADE;
CREATE TABLE detection_dimensions (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  weight DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX detection_dimensions_code_idx ON detection_dimensions(code);
CREATE INDEX detection_dimensions_enabled_idx ON detection_dimensions(enabled);

-- =====================================================
-- 5. 规则组表 (rule_groups)
-- =====================================================
DROP TABLE IF EXISTS rule_groups CASCADE;
CREATE TABLE rule_groups (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  dimension_id VARCHAR(36) NOT NULL REFERENCES detection_dimensions(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  logic VARCHAR(10) NOT NULL DEFAULT 'OR',
  score DECIMAL(5,2) NOT NULL DEFAULT 50.00,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX rule_groups_dimension_id_idx ON rule_groups(dimension_id);

-- =====================================================
-- 6. 检测规则表 (detection_rules)
-- =====================================================
DROP TABLE IF EXISTS detection_rules CASCADE;
CREATE TABLE detection_rules (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  dimension_id VARCHAR(36) NOT NULL REFERENCES detection_dimensions(id) ON DELETE CASCADE,
  group_id VARCHAR(36) REFERENCES rule_groups(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL,
  pattern TEXT,
  match_type VARCHAR(20) NOT NULL DEFAULT 'contains',
  case_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  score DECIMAL(5,2) NOT NULL DEFAULT 50.00,
  confidence DECIMAL(5,2) NOT NULL DEFAULT 80.00,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  suggestion TEXT,
  config JSONB DEFAULT '{}'::jsonb,
  tags JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX detection_rules_dimension_id_idx ON detection_rules(dimension_id);
CREATE INDEX detection_rules_group_id_idx ON detection_rules(group_id);
CREATE INDEX detection_rules_type_idx ON detection_rules(type);

-- =====================================================
-- 7. 策略规则表 (policy_rules)
-- =====================================================
DROP TABLE IF EXISTS policy_rules CASCADE;
CREATE TABLE policy_rules (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
  dimension VARCHAR(50) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  warn_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  block_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  warn_threshold DECIMAL(5,2) NOT NULL DEFAULT 50.00,
  block_threshold DECIMAL(5,2) NOT NULL DEFAULT 80.00,
  auto_mask BOOLEAN NOT NULL DEFAULT FALSE,
  auto_rewrite BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX policy_rules_policy_id_idx ON policy_rules(policy_id);
CREATE INDEX policy_rules_dimension_idx ON policy_rules(dimension);

-- =====================================================
-- 8. 策略维度配置表 (policy_dimension_config)
-- =====================================================
DROP TABLE IF EXISTS policy_dimension_config CASCADE;
CREATE TABLE policy_dimension_config (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
  dimension_id VARCHAR(36) NOT NULL REFERENCES detection_dimensions(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  warn_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  block_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  warn_threshold INTEGER NOT NULL DEFAULT 50,
  block_threshold INTEGER NOT NULL DEFAULT 80,
  auto_mask BOOLEAN NOT NULL DEFAULT FALSE,
  auto_rewrite BOOLEAN NOT NULL DEFAULT FALSE,
  custom_weight DECIMAL(5,2),
  action_config JSONB,
  UNIQUE(policy_id, dimension_id)
);

-- =====================================================
-- 9. 关键词分类表 (keyword_categories)
-- =====================================================
DROP TABLE IF EXISTS keyword_categories CASCADE;
CREATE TABLE keyword_categories (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  dimension VARCHAR(50) NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX keyword_categories_policy_id_idx ON keyword_categories(policy_id);
CREATE INDEX keyword_categories_dimension_idx ON keyword_categories(dimension);

-- =====================================================
-- 10. 自定义关键词规则表 (keyword_rules)
-- =====================================================
DROP TABLE IF EXISTS keyword_rules CASCADE;
CREATE TABLE keyword_rules (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
  category_id VARCHAR(36) REFERENCES keyword_categories(id) ON DELETE SET NULL,
  dimension VARCHAR(50) NOT NULL,
  keyword VARCHAR(500) NOT NULL,
  score DECIMAL(5,2) NOT NULL DEFAULT 90.00,
  match_type VARCHAR(20) NOT NULL DEFAULT 'exact',
  case_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT,
  tags JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX keyword_rules_policy_id_idx ON keyword_rules(policy_id);
CREATE INDEX keyword_rules_category_id_idx ON keyword_rules(category_id);
CREATE INDEX keyword_rules_dimension_idx ON keyword_rules(dimension);
CREATE INDEX keyword_rules_keyword_idx ON keyword_rules(keyword);

-- =====================================================
-- 11. 策略版本历史表 (policy_versions)
-- =====================================================
DROP TABLE IF EXISTS policy_versions CASCADE;
CREATE TABLE policy_versions (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  change_summary TEXT,
  changed_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX policy_versions_policy_id_idx ON policy_versions(policy_id);

-- =====================================================
-- 12. 白名单规则表 (whitelist_rules)
-- =====================================================
DROP TABLE IF EXISTS whitelist_rules CASCADE;
CREATE TABLE whitelist_rules (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  policy_id VARCHAR(36) REFERENCES policy_profiles(id) ON DELETE CASCADE,
  dimension_id VARCHAR(36) REFERENCES detection_dimensions(id) ON DELETE CASCADE,
  name VARCHAR(200),
  description TEXT,
  policy_scope VARCHAR(20) NOT NULL DEFAULT 'specific',
  dimension_scope VARCHAR(20) NOT NULL DEFAULT 'specific',
  dimension_codes JSONB DEFAULT '[]'::jsonb,
  priority INTEGER NOT NULL DEFAULT 100,
  pattern TEXT NOT NULL,
  match_type VARCHAR(20) NOT NULL DEFAULT 'contains',
  case_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ
);

CREATE INDEX whitelist_rules_policy_id_idx ON whitelist_rules(policy_id);
CREATE INDEX whitelist_rules_dimension_id_idx ON whitelist_rules(dimension_id);
CREATE INDEX whitelist_rules_policy_scope_idx ON whitelist_rules(policy_scope);
CREATE INDEX whitelist_rules_dimension_scope_idx ON whitelist_rules(dimension_scope);
CREATE INDEX whitelist_rules_enabled_idx ON whitelist_rules(enabled);
CREATE INDEX whitelist_rules_priority_idx ON whitelist_rules(priority);

-- =====================================================
-- 13. 白名单规则-策略关联表 (whitelist_rule_policies)
-- =====================================================
DROP TABLE IF EXISTS whitelist_rule_policies CASCADE;
CREATE TABLE whitelist_rule_policies (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  whitelist_rule_id VARCHAR(36) NOT NULL REFERENCES whitelist_rules(id) ON DELETE CASCADE,
  policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX whitelist_rule_policies_whitelist_rule_id_idx ON whitelist_rule_policies(whitelist_rule_id);
CREATE INDEX whitelist_rule_policies_policy_id_idx ON whitelist_rule_policies(policy_id);

-- =====================================================
-- 14. 检测会话表 (detection_sessions)
-- =====================================================
DROP TABLE IF EXISTS detection_sessions CASCADE;
CREATE TABLE detection_sessions (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR(100),
  user_prompt TEXT NOT NULL,
  mock_model_output TEXT,
  final_response TEXT,
  input_action VARCHAR(20),
  input_score DECIMAL(5,2),
  input_summary TEXT,
  output_action VARCHAR(20),
  output_score DECIMAL(5,2),
  output_summary TEXT,
  final_action VARCHAR(20),
  policy_id VARCHAR(36) REFERENCES policy_profiles(id),
  target_provider_id VARCHAR(36) REFERENCES llm_providers(id),
  judge_provider_id VARCHAR(36) REFERENCES llm_providers(id),
  duration_ms INTEGER,
  whitelist_matched JSONB,
  skipped_dimensions JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX detection_sessions_user_id_idx ON detection_sessions(user_id);
CREATE INDEX detection_sessions_final_action_idx ON detection_sessions(final_action);
CREATE INDEX detection_sessions_created_at_idx ON detection_sessions(created_at);
CREATE INDEX detection_sessions_policy_id_idx ON detection_sessions(policy_id);

-- =====================================================
-- 15. 检测记录表 (detection_records)
-- =====================================================
DROP TABLE IF EXISTS detection_records CASCADE;
CREATE TABLE detection_records (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id VARCHAR(36) NOT NULL REFERENCES detection_sessions(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL,
  raw_text TEXT NOT NULL,
  masked_text TEXT,
  rewritten_text TEXT,
  overall_score DECIMAL(5,2),
  confidence DECIMAL(3,2),
  action VARCHAR(20),
  processing_action VARCHAR(20),
  summary TEXT,
  rule_latency_ms INTEGER,
  coze_latency_ms INTEGER,
  total_latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX detection_records_session_id_idx ON detection_records(session_id);
CREATE INDEX detection_records_direction_idx ON detection_records(direction);
CREATE INDEX detection_records_action_idx ON detection_records(action);

-- =====================================================
-- 16. 风险明细表 (risk_findings)
-- =====================================================
DROP TABLE IF EXISTS risk_findings CASCADE;
CREATE TABLE risk_findings (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  record_id VARCHAR(36) NOT NULL REFERENCES detection_records(id) ON DELETE CASCADE,
  dimension VARCHAR(50) NOT NULL,
  score DECIMAL(5,2),
  confidence DECIMAL(3,2),
  severity VARCHAR(20),
  matched_rules JSONB,
  evidence JSONB,
  reason TEXT,
  suggestion TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX risk_findings_record_id_idx ON risk_findings(record_id);
CREATE INDEX risk_findings_dimension_idx ON risk_findings(dimension);
CREATE INDEX risk_findings_severity_idx ON risk_findings(severity);

-- =====================================================
-- 17. 文档扫描任务表 (document_scan_tasks)
-- =====================================================
DROP TABLE IF EXISTS document_scan_tasks CASCADE;
CREATE TABLE document_scan_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name VARCHAR(500) NOT NULL,
  file_type VARCHAR(50) NOT NULL,
  file_size INTEGER,
  file_key VARCHAR(500),
  policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  status_message TEXT,
  extracted_text TEXT,
  parsed_chunks JSONB DEFAULT '[]'::jsonb,
  ocr_enabled BOOLEAN DEFAULT FALSE,
  ocr_results JSONB DEFAULT '[]'::jsonb,
  overall_score INTEGER,
  final_action VARCHAR(20),
  findings_count INTEGER DEFAULT 0,
  whitelist_matched JSONB,
  skipped_dimensions JSONB,
  error_message TEXT,
  preview_html TEXT,
  plain_lines JSONB DEFAULT '[]'::jsonb,
  parse_meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX document_scan_tasks_policy_id_idx ON document_scan_tasks(policy_id);
CREATE INDEX document_scan_tasks_status_idx ON document_scan_tasks(status);
CREATE INDEX document_scan_tasks_created_at_idx ON document_scan_tasks(created_at);

-- =====================================================
-- 18. 文档扫描风险发现表 (document_scan_findings)
-- =====================================================
DROP TABLE IF EXISTS document_scan_findings CASCADE;
CREATE TABLE document_scan_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES document_scan_tasks(id) ON DELETE CASCADE,
  chunk_index INTEGER,
  line_number INTEGER,
  start_offset INTEGER,
  end_offset INTEGER,
  location_status VARCHAR(20) DEFAULT 'located',
  dimension_id UUID,
  dimension_code VARCHAR(100),
  dimension_name VARCHAR(200),
  rule_id UUID,
  rule_name VARCHAR(200),
  rule_type VARCHAR(20),
  score INTEGER NOT NULL,
  severity VARCHAR(20) NOT NULL,
  action VARCHAR(20) NOT NULL,
  evidence JSONB DEFAULT '[]'::jsonb,
  masked_evidence JSONB DEFAULT '[]'::jsonb,
  reason TEXT,
  suggestion TEXT,
  whitelist_matched JSONB,
  skipped_dimensions JSONB,
  status VARCHAR(20) DEFAULT 'open' NOT NULL,
  ignore_reason VARCHAR(50),
  ignore_note TEXT,
  ignored_at TIMESTAMPTZ,
  ignored_by VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX document_scan_findings_task_id_idx ON document_scan_findings(task_id);
CREATE INDEX document_scan_findings_dimension_code_idx ON document_scan_findings(dimension_code);
CREATE INDEX document_scan_findings_status_idx ON document_scan_findings(status);
CREATE INDEX document_scan_findings_severity_idx ON document_scan_findings(severity);

-- =====================================================
-- 19. 测试用例表 (test_cases)
-- =====================================================
DROP TABLE IF EXISTS test_cases CASCADE;
CREATE TABLE test_cases (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL,
  input_text TEXT NOT NULL,
  output_text TEXT,
  expected_action VARCHAR(20),
  expected_dimensions JSONB,
  expected_score_min DECIMAL(5,2),
  expected_score_max DECIMAL(5,2),
  severity VARCHAR(20),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX test_cases_category_idx ON test_cases(category);
CREATE INDEX test_cases_enabled_idx ON test_cases(enabled);

-- =====================================================
-- 20. 批量评估任务表 (evaluation_runs)
-- =====================================================
DROP TABLE IF EXISTS evaluation_runs CASCADE;
CREATE TABLE evaluation_runs (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR(100),
  policy_id VARCHAR(36) REFERENCES policy_profiles(id),
  test_case_ids JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_cases INTEGER NOT NULL,
  completed_cases INTEGER NOT NULL DEFAULT 0,
  accuracy DECIMAL(5,2),
  false_positive_rate DECIMAL(5,2),
  false_negative_rate DECIMAL(5,2),
  recall DECIMAL(5,2),
  f1_score DECIMAL(5,2),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX evaluation_runs_user_id_idx ON evaluation_runs(user_id);
CREATE INDEX evaluation_runs_status_idx ON evaluation_runs(status);
CREATE INDEX evaluation_runs_policy_id_idx ON evaluation_runs(policy_id);

-- =====================================================
-- 21. Agent 日志表 (agent_logs)
-- =====================================================
DROP TABLE IF EXISTS agent_logs CASCADE;
CREATE TABLE agent_logs (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id VARCHAR(36) NOT NULL,
  agent_name VARCHAR(100) NOT NULL,
  level VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX agent_logs_session_id_idx ON agent_logs(session_id);
CREATE INDEX agent_logs_agent_name_idx ON agent_logs(agent_name);
CREATE INDEX agent_logs_level_idx ON agent_logs(level);
CREATE INDEX agent_logs_created_at_idx ON agent_logs(created_at);

-- =====================================================
-- 22. Agent 追踪表 (agent_traces)
-- =====================================================
DROP TABLE IF EXISTS agent_traces CASCADE;
CREATE TABLE agent_traces (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id VARCHAR(36) NOT NULL,
  trace_type VARCHAR(50) NOT NULL,
  trace_data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX agent_traces_session_id_idx ON agent_traces(session_id);
CREATE INDEX agent_traces_trace_type_idx ON agent_traces(trace_type);

-- =====================================================
-- 插入初始数据
-- =====================================================

-- 插入检测维度数据
INSERT INTO detection_dimensions (id, code, name, description, category, weight, priority, enabled, is_system, config, created_at, updated_at) VALUES
('550e8400-e29b-41d4-a716-446655440001', 'prompt_injection', '提示词注入', '检测用户输入中是否存在试图操纵模型行为的提示词注入攻击', 'security', 1.00, 100, true, true, '{"color": "#ef4444", "icon": "shield-alert"}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440002', 'pii_leak', '信息泄露', '检测文本中是否包含个人隐私信息（手机号、身份证、银行卡等）', 'compliance', 1.00, 90, true, true, '{"color": "#f97316", "icon": "user-x"}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440003', 'malicious_code', '恶意代码', '检测文本中是否包含恶意代码、攻击脚本或漏洞利用代码', 'security', 1.00, 95, true, true, '{"color": "#8b5cf6", "icon": "code-2"}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440004', 'violence_hate', '暴力仇恨', '检测文本中是否包含暴力、仇恨、歧视性言论', 'content', 0.80, 80, true, true, '{"color": "#ec4899", "icon": "alert-triangle"}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440005', 'illegal_content', '非法内容', '检测文本中是否包含违法犯罪、黄赌毒等相关内容', 'content', 0.80, 85, true, true, '{"color": "#dc2626", "icon": "ban"}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440008', 'sensitive_compliance', '敏感合规', '检测可能涉及平台合规、公共安全、敏感议题的内容', 'compliance', 0.80, 90, true, true, '{}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440009', 'adult_content', '色情低俗', '检测色情、低俗、露骨性内容、未成年人相关性内容', 'content', 0.90, 100, true, true, '{}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440010', 'self_harm', '自伤自杀', '检测自伤、自杀、求助、诱导自伤等高风险内容', 'safety', 1.00, 100, true, true, '{}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440011', 'credential_secret_leak', '密钥凭证泄露', '检测 API Key、Token、Secret、Access Key 等敏感凭证泄露', 'privacy', 0.90, 95, true, true, '{}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440012', 'fraud_scam', '诈骗欺诈', '检测诈骗话术、钓鱼链接、冒充客服、虚假投资等欺诈内容', 'content', 1.00, 100, true, true, '{}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440013', 'misinformation', '虚假信息', '检测虚假新闻、谣言传播、高风险医疗建议等误导性内容', 'content', 0.80, 85, true, true, '{}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440014', 'copyright_risk', '版权风险', '检测侵权内容、盗版资源传播等版权风险内容', 'compliance', 0.70, 80, true, true, '{}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440015', 'business_sensitive', '企业敏感信息', '检测企业内部信息、商业机密、内部代码库等敏感信息泄露', 'privacy', 0.90, 90, true, true, '{}', NOW(), NOW()),
('550e8400-e29b-41d4-a716-446655440016', 'output_leak', '输出泄露', '检测模型输出中是否泄露系统指令、内部信息等', 'security', 0.80, 85, true, true, '{}', NOW(), NOW()),
('45f9982f-84a6-4e5a-917f-d9eb34c592bd', 'spam_detection', '垃圾信息检测', '检测垃圾邮件和垃圾信息', 'content', 0.70, 100, true, false, '{}', NOW(), NOW()),
('f9e3d08b-ac02-4795-836c-503978e21304', 'ad_detection', '广告检测', '检测广告内容', 'content', 0.90, 100, true, false, '{}', NOW(), NOW());

-- 插入策略配置数据
INSERT INTO policy_profiles (id, name, description, is_default, is_active, version, tags, metadata, created_at, updated_at, created_by) VALUES
('default-policy-strict', '严格策略', '严格安全策略，对各类风险高度敏感', false, true, 1, '["strict", "high-security"]', '{}', NOW(), NOW(), 'system'),
('default-policy-balanced', '默认策略', '默认安全策略，平衡安全与用户体验', true, true, 1, '["default", "balanced"]', '{}', NOW(), NOW(), 'system'),
('default-policy-loose', '宽松策略', '宽松安全策略，仅拦截高风险内容', false, true, 1, '["loose", "permissive"]', '{}', NOW(), NOW(), 'system');

-- 插入 LLM 提供商配置
INSERT INTO llm_providers (id, name, display_name, provider_type, base_url, default_model, use_case, is_enabled, is_default_target, is_default_judge, created_at, updated_at, created_by) VALUES
('default-llm-provider', 'default', '默认LLM', 'openai_compatible', NULL, 'gpt-4o-mini', 'both', true, true, true, NOW(), NOW(), 'system');

-- =====================================================
-- 插入检测规则数据
-- =====================================================

-- 提示词注入规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('550e8400-e29b-41d4-a716-446655440101', '550e8400-e29b-41d4-a716-446655440001', '忽略指令关键词', 'keyword', '忽略之前', 'contains', false, 90.00, 0.85, 100, true, '检测"忽略之前"类指令覆盖', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440102', '550e8400-e29b-41d4-a716-446655440001', '系统提示词探测', 'keyword', '系统提示词', 'contains', false, 95.00, 0.90, 100, true, '检测系统提示词探测行为', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440103', '550e8400-e29b-41d4-a716-446655440001', '角色扮演注入', 'keyword', '你现在是', 'contains', false, 85.00, 0.80, 100, true, '检测角色扮演类注入', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440104', '550e8400-e29b-41d4-a716-446655440001', '越狱指令', 'keyword', 'DAN模式', 'contains', false, 100.00, 0.95, 100, true, '检测DAN越狱模式', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440105', '550e8400-e29b-41d4-a716-446655440001', '忽略规则', 'keyword', '忽略所有规则', 'contains', false, 95.00, 0.90, 100, true, '检测忽略规则指令', NULL, '[]', '{}', NOW()),
('9c28e929-664c-477f-b858-6a5129be1c90', '550e8400-e29b-41d4-a716-446655440001', '忽略', 'keyword', '忽略', 'contains', false, 60.00, 0.80, 80, true, '忽略关键词', NULL, '[]', '{}', NOW()),
('a0b95748-6c4f-4190-b6e0-a3883200fa10', '550e8400-e29b-41d4-a716-446655440001', '忽略之前', 'keyword', '忽略之前', 'contains', false, 85.00, 0.85, 90, true, '忽略之前关键词', NULL, '[]', '{}', NOW()),
('92283b6f-5c42-4674-90b4-e4d91da35660', '550e8400-e29b-41d4-a716-446655440001', '越狱', 'keyword', '越狱', 'contains', false, 90.00, 0.85, 95, true, '越狱关键词', NULL, '[]', '{}', NOW()),
('6daae776-8053-4f79-bfca-71df89c87fe1', '550e8400-e29b-41d4-a716-446655440001', 'DAN', 'keyword', 'DAN', 'contains', false, 85.00, 0.85, 90, true, 'DAN越狱', NULL, '[]', '{}', NOW()),
('9e2eb5e7-c22a-4a95-93c9-ae94f84c85f3', '550e8400-e29b-41d4-a716-446655440001', '开发者模式', 'keyword', '开发者模式', 'contains', false, 85.00, 0.85, 90, true, '开发者模式越狱', NULL, '[]', '{}', NOW()),
('f93194bd-8c7e-40d6-a06e-7739c90d374d', '550e8400-e29b-41d4-a716-446655440001', '无限制模式', 'keyword', '无限制模式', 'contains', false, 85.00, 0.85, 90, true, '无限制模式', NULL, '[]', '{}', NOW()),
('ac9c1c01-3b0c-4990-aca7-f907e3be9f33', '550e8400-e29b-41d4-a716-446655440001', '输出规则', 'regex', '(输出|泄露|告诉我).*系统提示词', 'regex', false, 95.00, 0.90, 100, true, '输出系统提示词', NULL, '[]', '{}', NOW()),
('9411f354-90e5-48f9-ae66-0aa2fccac8ff', '550e8400-e29b-41d4-a716-446655440001', '绕过限制', 'keyword', '绕过限制', 'contains', false, 90.00, 0.90, 100, true, '绕过限制关键词', NULL, '[]', '{}', NOW()),
('0e806fa7-077c-4785-971f-d3dda64ecf02', '550e8400-e29b-41d4-a716-446655440001', '系统提示词', 'keyword', '系统提示词', 'contains', false, 95.00, 0.90, 100, true, '系统提示词探测', NULL, '[]', '{}', NOW()),
('97f13468-15fc-4767-abd8-6266ceb3b35f', '550e8400-e29b-41d4-a716-446655440001', 'system prompt', 'keyword', 'system prompt', 'contains', false, 95.00, 0.90, 100, true, '系统提示词探测英文', NULL, '[]', '{}', NOW()),
('4fbf40bf-e8d3-4834-90d5-d1af7b07b9e0', '550e8400-e29b-41d4-a716-446655440001', '忽略指令', 'keyword', '忽略之前的指令', 'contains', false, 90.00, 0.90, 100, true, '忽略指令关键词', NULL, '[]', '{}', NOW()),
('2d5ae48d-fdb5-4fa9-9eef-7533a88d8d40', '550e8400-e29b-41d4-a716-446655440001', '忽略所有规则', 'keyword', '忽略所有规则', 'contains', false, 90.00, 0.90, 100, true, '忽略规则关键词', NULL, '[]', '{}', NOW()),
('3621dff1-a563-468a-b4ae-43160bfabde4', '550e8400-e29b-41d4-a716-446655440001', '扮演', 'keyword', '扮演', 'contains', false, 50.00, 0.70, 70, true, '扮演关键词', NULL, '[]', '{}', NOW());

-- 信息泄露规则 (PII)
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('550e8400-e29b-41d4-a716-446655440204', '550e8400-e29b-41d4-a716-446655440002', '邮箱检测', 'regex', '[\w.-]+@[\w.-]+\.\w+', 'regex', false, 75.00, 0.85, 100, true, '检测邮箱地址', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440205', '550e8400-e29b-41d4-a716-446655440002', 'API Key检测', 'regex', '(sk-|api[_-]?key|Bearer\s+)[a-zA-Z0-9_-]{20,}', 'regex', false, 100.00, 0.95, 100, true, '检测API密钥', NULL, '[]', '{}', NOW()),
('a404ffac-705b-488c-a413-9e66319ae3ff', '550e8400-e29b-41d4-a716-446655440002', '邮箱', 'regex', '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', 'regex', false, 60.00, 0.80, 80, true, '邮箱正则', NULL, '[]', '{}', NOW()),
('2f8afb55-6609-4968-a9b7-ea8ac2cfb415', '550e8400-e29b-41d4-a716-446655440002', '手机号检测', 'regex', '1[3-9]\d{9}', 'regex', false, 80.00, 0.90, 100, true, '检测中国大陆手机号码', '检测到手机号码，建议脱敏处理或移除', '[]', '{}', NOW()),
('a4a826dd-7e19-4223-a7aa-d4ae9cec6168', '550e8400-e29b-41d4-a716-446655440002', '银行卡号检测', 'regex', '\d{16,19}', 'regex', false, 85.00, 0.85, 100, true, '检测银行卡号码', '检测到银行卡号码，建议脱敏处理或移除', '[]', '{}', NOW()),
('91a2d38e-fd89-42f6-bf45-3c5ff259782e', '550e8400-e29b-41d4-a716-446655440002', '身份证号检测', 'regex', '\d{17}[\dXx]', 'regex', false, 90.00, 0.95, 100, true, '检测中国大陆身份证号码', '检测到身份证号码，建议脱敏处理或移除', '[]', '{}', NOW());

-- 恶意代码规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('550e8400-e29b-41d4-a716-446655440301', '550e8400-e29b-41d4-a716-446655440003', 'SQL注入检测', 'keyword', 'SELECT * FROM', 'contains', false, 90.00, 0.85, 100, true, '检测SQL注入', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440302', '550e8400-e29b-41d4-a716-446655440003', 'XSS攻击', 'keyword', '<script>', 'contains', false, 85.00, 0.80, 100, true, '检测XSS攻击', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440303', '550e8400-e29b-41d4-a716-446655440003', '远程控制', 'keyword', '远程控制', 'contains', false, 100.00, 0.95, 100, true, '检测远程控制请求', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440304', '550e8400-e29b-41d4-a716-446655440003', '木马检测', 'keyword', '木马', 'contains', false, 95.00, 0.90, 100, true, '检测木马相关内容', NULL, '[]', '{}', NOW()),
('18313cfe-08cf-494e-a4ad-3750a58a11d1', '550e8400-e29b-41d4-a716-446655440003', '木马', 'keyword', '木马', 'contains', false, 95.00, 0.90, 100, true, '木马关键词', NULL, '[]', '{}', NOW()),
('a7518ee9-d64a-468f-b2ac-5c46b8858e05', '550e8400-e29b-41d4-a716-446655440003', '后门', 'keyword', '后门', 'contains', false, 95.00, 0.90, 100, true, '后门关键词', NULL, '[]', '{}', NOW()),
('77ad7478-4bcf-40de-b259-bb36782445f4', '550e8400-e29b-41d4-a716-446655440003', '获取文件', 'keyword', '获取文件', 'contains', false, 90.00, 0.85, 95, true, '获取文件关键词', NULL, '[]', '{}', NOW()),
('dd6d53fc-bb83-47c2-b07f-097392094442', '550e8400-e29b-41d4-a716-446655440003', '反弹shell', 'keyword', '反弹shell', 'contains', false, 90.00, 0.85, 95, true, '反弹shell关键词', NULL, '[]', '{}', NOW()),
('badb1cea-4393-45aa-8d87-75298b14118b', '550e8400-e29b-41d4-a716-446655440003', '免杀', 'keyword', '免杀', 'contains', false, 90.00, 0.85, 95, true, '免杀关键词', NULL, '[]', '{}', NOW()),
('724addd7-101b-4a43-a2ee-a6998ba2fb7b', '550e8400-e29b-41d4-a716-446655440003', '入侵', 'keyword', '入侵', 'contains', false, 85.00, 0.85, 90, true, '入侵关键词', NULL, '[]', '{}', NOW()),
('cf998c94-3aef-4d2f-b790-d0abe0eeb491', '550e8400-e29b-41d4-a716-446655440003', '窃取密码', 'keyword', '窃取密码', 'contains', false, 95.00, 0.90, 100, true, '窃取密码关键词', NULL, '[]', '{}', NOW()),
('137254a4-794d-4f51-85b4-3a6e9194e1f8', '550e8400-e29b-41d4-a716-446655440003', '控制他人电脑', 'keyword', '控制他人电脑', 'contains', false, 95.00, 0.90, 100, true, '控制他人电脑关键词', NULL, '[]', '{}', NOW());

-- 暴力仇恨规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('550e8400-e29b-41d4-a716-446655440401', '550e8400-e29b-41d4-a716-446655440004', '暴力关键词', 'keyword', '杀死', 'contains', false, 90.00, 0.85, 100, true, '检测暴力关键词', NULL, '[]', '{}', NOW()),
('9a93c464-9813-4922-b31b-77f14555e76d', '550e8400-e29b-41d4-a716-446655440004', '仇恨', 'keyword', '仇恨', 'contains', false, 80.00, 0.80, 85, true, '仇恨关键词', NULL, '[]', '{}', NOW()),
('244956fe-0f94-4564-9e1d-51239661a31e', '550e8400-e29b-41d4-a716-446655440004', '暴力威胁', 'keyword', '暴力威胁', 'contains', false, 90.00, 0.85, 100, true, '暴力威胁关键词', NULL, '[]', '{}', NOW()),
('f44f21ec-1bdb-4a95-90c0-02eab07df10f', '550e8400-e29b-41d4-a716-446655440004', '杀人', 'keyword', '杀人', 'contains', false, 95.00, 0.85, 100, true, '杀人关键词', NULL, '[]', '{}', NOW());

-- 非法内容规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('550e8400-e29b-41d4-a716-446655440501', '550e8400-e29b-41d4-a716-446655440005', '毒品相关', 'keyword', '毒品', 'contains', false, 95.00, 0.90, 100, true, '检测毒品相关内容', NULL, '[]', '{}', NOW()),
('550e8400-e29b-41d4-a716-446655440502', '550e8400-e29b-41d4-a716-446655440005', '诈骗相关', 'keyword', '诈骗', 'contains', false, 95.00, 0.90, 100, true, '检测诈骗相关内容', NULL, '[]', '{}', NOW()),
('6215b42d-c220-452e-9ec5-bc31667b6355', '550e8400-e29b-41d4-a716-446655440005', '买卖账号', 'keyword', '买卖账号', 'contains', false, 90.00, 0.85, 100, true, '买卖账号关键词', NULL, '[]', '{}', NOW()),
('1f88d3a6-614c-40d5-b6e2-a34cea335224', '550e8400-e29b-41d4-a716-446655440005', '洗钱', 'keyword', '洗钱', 'contains', false, 95.00, 0.90, 100, true, '洗钱关键词', NULL, '[]', '{}', NOW()),
('993df25f-c721-4aea-b9ec-e172abbf003e', '550e8400-e29b-41d4-a716-446655440005', '黑产', 'keyword', '黑产', 'contains', false, 90.00, 0.85, 95, true, '黑产关键词', NULL, '[]', '{}', NOW()),
('670bdf5a-0957-4a0e-9128-264f73b3c661', '550e8400-e29b-41d4-a716-446655440005', '诈骗', 'keyword', '诈骗', 'contains', false, 90.00, 0.85, 95, true, '诈骗关键词', NULL, '[]', '{}', NOW()),
('f36cbd94-fc9e-4aa3-a0cc-8dc29df7b68f', '550e8400-e29b-41d4-a716-446655440005', '绕过实名', 'keyword', '绕过实名', 'contains', false, 85.00, 0.80, 90, true, '绕过实名关键词', NULL, '[]', '{}', NOW());

-- 敏感合规规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('3cd8f55a-11db-4d80-abba-a0771a1fd1f6', '550e8400-e29b-41d4-a716-446655440008', '绕过监管', 'keyword', '绕过监管', 'contains', false, 85.00, 0.80, 90, true, '绕过监管关键词', NULL, '[]', '{}', NOW()),
('0faefc79-ea3b-4809-a346-39d2eef8c4a2', '550e8400-e29b-41d4-a716-446655440008', '水军', 'keyword', '水军', 'contains', false, 75.00, 0.75, 80, true, '水军关键词', NULL, '[]', '{}', NOW()),
('875e1ef7-64d6-49cb-bafe-0fbe2483b0b6', '550e8400-e29b-41d4-a716-446655440008', '控评', 'keyword', '控评', 'contains', false, 75.00, 0.75, 80, true, '控评关键词', NULL, '[]', '{}', NOW());

-- 色情低俗规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('32ad99d1-1335-43f8-aea5-fd7aa8ca91f3', '550e8400-e29b-41d4-a716-446655440009', '裸聊', 'keyword', '裸聊', 'contains', false, 90.00, 0.85, 100, true, '裸聊关键词', NULL, '[]', '{}', NOW()),
('2c774d78-2a11-4e97-a5e4-196121313ffe', '550e8400-e29b-41d4-a716-446655440009', '色情', 'keyword', '色情', 'contains', false, 95.00, 0.90, 100, true, '色情关键词', NULL, '[]', '{}', NOW()),
('7a368eaf-9ac0-4392-919b-fabb7c6a445f', '550e8400-e29b-41d4-a716-446655440009', '约炮', 'keyword', '约炮', 'contains', false, 90.00, 0.85, 95, true, '约炮关键词', NULL, '[]', '{}', NOW());

-- 自伤自杀规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('5e16d1c5-e5d3-4aba-aacc-79a96ac5d756', '550e8400-e29b-41d4-a716-446655440010', '自杀', 'keyword', '自杀', 'contains', false, 95.00, 0.90, 100, true, '自杀关键词', NULL, '[]', '{}', NOW()),
('9d42c300-db73-4b2d-bc36-664c2a66aed1', '550e8400-e29b-41d4-a716-446655440010', '不想活了', 'keyword', '不想活了', 'contains', false, 90.00, 0.85, 100, true, '不想活了关键词', NULL, '[]', '{}', NOW()),
('dbbdb35d-91b4-4aa6-9c23-cda71c438d1a', '550e8400-e29b-41d4-a716-446655440010', '结束生命', 'keyword', '结束生命', 'contains', false, 95.00, 0.90, 100, true, '结束生命关键词', NULL, '[]', '{}', NOW()),
('69f9ead1-3703-4fb8-88e3-b90528c779d9', '550e8400-e29b-41d4-a716-446655440010', '割腕', 'keyword', '割腕', 'contains', false, 95.00, 0.90, 100, true, '割腕关键词', NULL, '[]', '{}', NOW());

-- 密钥凭证泄露规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('179c3205-8ec3-4851-9889-7d77e200cae2', '550e8400-e29b-41d4-a716-446655440011', 'OpenAI Key', 'regex', 'sk-[A-Za-z0-9_-]{20,}', 'regex', false, 95.00, 0.90, 100, true, 'OpenAI API Key', NULL, '[]', '{}', NOW()),
('38b1b25c-2b57-4e0f-8878-47f339f9791f', '550e8400-e29b-41d4-a716-446655440011', 'api_key', 'keyword', 'api_key', 'contains', false, 80.00, 0.80, 90, true, 'api_key关键词', NULL, '[]', '{}', NOW()),
('63e492c5-158b-46a0-a9d8-7eb81e3b280b', '550e8400-e29b-41d4-a716-446655440011', 'secret_key', 'keyword', 'secret_key', 'contains', false, 80.00, 0.80, 90, true, 'secret_key关键词', NULL, '[]', '{}', NOW()),
('e708bfb8-70f1-4563-88ab-e17b37a6e045', '550e8400-e29b-41d4-a716-446655440011', 'access_token', 'keyword', 'access_token', 'contains', false, 85.00, 0.85, 95, true, 'access_token关键词', NULL, '[]', '{}', NOW());

-- 诈骗欺诈规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('1cb98b4b-4352-497f-bacc-f653ef975a02', '550e8400-e29b-41d4-a716-446655440012', '恭喜中奖', 'keyword', '恭喜中奖', 'contains', false, 90.00, 0.85, 100, true, '恭喜中奖诈骗', NULL, '[]', '{}', NOW()),
('6cae7426-1f35-4b1a-89a2-1bfd5ee8ecd2', '550e8400-e29b-41d4-a716-446655440012', '钓鱼链接', 'keyword', '钓鱼链接', 'contains', false, 90.00, 0.85, 100, true, '钓鱼链接诈骗', NULL, '[]', '{}', NOW()),
('a745d009-26ee-4770-b309-1a6649b87b31', '550e8400-e29b-41d4-a716-446655440012', '冒充客服', 'keyword', '冒充客服', 'contains', false, 85.00, 0.80, 95, true, '冒充客服诈骗', NULL, '[]', '{}', NOW()),
('a761d512-5083-4c90-ae52-fd276adcfdd1', '550e8400-e29b-41d4-a716-446655440012', '稳赚不赔', 'keyword', '稳赚不赔', 'contains', false, 85.00, 0.80, 95, true, '稳赚不赔诈骗', NULL, '[]', '{}', NOW()),
('9a93e073-1f96-4d78-95d7-763d846582b3', '550e8400-e29b-41d4-a716-446655440012', '内幕消息', 'keyword', '内幕消息', 'contains', false, 80.00, 0.75, 90, true, '内幕消息诈骗', NULL, '[]', '{}', NOW());

-- 虚假信息规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('85c523a2-5c55-4d4d-b07b-060b27ec99dc', '550e8400-e29b-41d4-a716-446655440013', '谣言', 'keyword', '谣言', 'contains', false, 75.00, 0.75, 80, true, '谣言关键词', NULL, '[]', '{}', NOW()),
('10a8599f-b257-4efc-9b95-114e8d2bd2fe', '550e8400-e29b-41d4-a716-446655440013', '虚假新闻', 'keyword', '虚假新闻', 'contains', false, 80.00, 0.80, 85, true, '虚假新闻关键词', NULL, '[]', '{}', NOW());

-- 版权风险规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('ea56d8dd-0aaa-4511-9546-3434b0f4e329', '550e8400-e29b-41d4-a716-446655440014', '盗版', 'keyword', '盗版', 'contains', false, 80.00, 0.80, 90, true, '盗版关键词', NULL, '[]', '{}', NOW()),
('ae4026e3-e513-490a-9391-93f8931cb4cd', '550e8400-e29b-41d4-a716-446655440014', '侵权', 'keyword', '侵权', 'contains', false, 75.00, 0.75, 85, true, '侵权关键词', NULL, '[]', '{}', NOW());

-- 企业敏感信息规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('57b2be14-fc0d-43a6-97a7-a3df2bf58c0b', '550e8400-e29b-41d4-a716-446655440015', '商业机密', 'keyword', '商业机密', 'contains', false, 90.00, 0.85, 95, true, '商业机密关键词', NULL, '[]', '{}', NOW()),
('5499855b-7cac-446d-87e0-4956bc5e3fc7', '550e8400-e29b-41d4-a716-446655440015', '内部资料', 'keyword', '内部资料', 'contains', false, 85.00, 0.80, 90, true, '内部资料关键词', NULL, '[]', '{}', NOW()),
('b07a5e2b-3ae0-417c-857c-a83205ffe5f5', '550e8400-e29b-41d4-a716-446655440015', '机密文件', 'keyword', '机密文件', 'contains', false, 90.00, 0.85, 95, true, '机密文件关键词', NULL, '[]', '{}', NOW());

-- 输出泄露规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('9daab45f-f10f-4cc7-9649-fa7071c205d7', '550e8400-e29b-41d4-a716-446655440016', '系统指令', 'keyword', '系统指令', 'contains', false, 85.00, 0.85, 90, true, '系统指令关键词', NULL, '[]', '{}', NOW()),
('01ec8db4-504c-4183-ac22-3fbe65497c4d', '550e8400-e29b-41d4-a716-446655440016', '内部信息', 'keyword', '内部信息', 'contains', false, 80.00, 0.80, 85, true, '内部信息关键词', NULL, '[]', '{}', NOW());

-- 垃圾信息检测规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('7f057d88-ff31-4425-8615-40909fe9eba3', '45f9982f-84a6-4e5a-917f-d9eb34c592bd', '重复字符', 'regex', '(.)\1{8,}', 'regex', false, 70.00, 0.80, 80, true, '重复字符检测', NULL, '[]', '{}', NOW()),
('ecc3a096-4ae8-4644-9b64-785c3666fa18', '45f9982f-84a6-4e5a-917f-d9eb34c592bd', '顶顶顶', 'keyword', '顶顶顶', 'contains', false, 50.00, 0.60, 60, true, '灌水关键词', NULL, '[]', '{}', NOW()),
('4b8874df-ee45-42ee-a6de-f08500ecf8ae', '45f9982f-84a6-4e5a-917f-d9eb34c592bd', '刷屏', 'keyword', '刷屏', 'contains', false, 60.00, 0.70, 70, true, '刷屏关键词', NULL, '[]', '{}', NOW());

-- 广告检测规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, tags, config, created_at) VALUES
('66fcb24d-d59d-4ae4-b955-eb44d514b64b', 'f9e3d08b-ac02-4795-836c-503978e21304', '限时优惠', 'keyword', '限时优惠', 'contains', false, 70.00, 0.80, 80, true, '限时优惠广告', NULL, '[]', '{}', NOW()),
('a6b2c1d3-e4f5-6a7b-8c9d-0e1f2a3b4c5d', 'f9e3d08b-ac02-4795-836c-503978e21304', '加微信', 'keyword', '加微信', 'contains', false, 80.00, 0.85, 90, true, '加微信广告', NULL, '[]', '{}', NOW()),
('b7c3d2e4-f5a6-7b8c-9d0e-1f2a3b4c5d6e', 'f9e3d08b-ac02-4795-836c-503978e21304', '点击购买', 'keyword', '点击购买', 'contains', false, 75.00, 0.80, 85, true, '点击购买广告', NULL, '[]', '{}', NOW());

-- =====================================================
-- 完成提示
-- =====================================================
SELECT '数据库初始化完成！' AS status;
SELECT COUNT(*) AS dimensions_count FROM detection_dimensions;
SELECT COUNT(*) AS rules_count FROM detection_rules;
SELECT COUNT(*) AS policies_count FROM policy_profiles;

-- =====================================================
-- 初始化策略规则配置
-- =====================================================
-- 为每个策略创建所有维度的规则配置
INSERT INTO policy_rules (id, policy_id, dimension, enabled, warn_enabled, block_enabled, warn_threshold, block_threshold, auto_mask, auto_rewrite)
SELECT
  gen_random_uuid()::text,
  p.id,
  d.code,
  true,
  true,
  true,
  CASE
    WHEN p.id = 'default-policy-strict' THEN 30.00
    WHEN p.id = 'default-policy-loose' THEN 70.00
    ELSE 50.00
  END,
  CASE
    WHEN p.id = 'default-policy-strict' THEN 60.00
    WHEN p.id = 'default-policy-loose' THEN 90.00
    ELSE 80.00
  END,
  CASE WHEN d.code = 'pii_leak' THEN true ELSE false END,
  false
FROM policy_profiles p
CROSS JOIN detection_dimensions d;

SELECT COUNT(*) AS policy_rules_count FROM policy_rules;
