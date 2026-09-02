-- =====================================================
-- GuardLLM 数据库初始化脚本（补充表）
-- 包含: users, user_policy_states, policy_profiles扩展字段
-- 执行顺序: 在 init-database-new.sql 之后执行
-- =====================================================

-- =====================================================
-- 1. 用户表 (users)
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  username VARCHAR(50) NOT NULL UNIQUE,
  nickname VARCHAR(100),
  email VARCHAR(255),
  password VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  avatar VARCHAR(500),
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  department VARCHAR(100),
  description TEXT,
  last_login_at TIMESTAMPTZ,
  last_login_ip VARCHAR(50),
  login_count INTEGER DEFAULT 0,
  failed_login_count INTEGER DEFAULT 0,
  locked_until TIMESTAMPTZ,
  token_version INTEGER NOT NULL DEFAULT 0,
  password_changed_at TIMESTAMPTZ,
  must_change_password BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  created_by VARCHAR(36)
);

CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
CREATE INDEX IF NOT EXISTS users_status_idx ON users(status);

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- 不创建共享默认密码账户。首次管理员必须通过 pnpm auth:bootstrap 显式创建。

-- =====================================================
-- 2. 用户策略状态表 (user_policy_states)
-- =====================================================
CREATE TABLE IF NOT EXISTS user_policy_states (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR(100) NOT NULL,
  session_id VARCHAR(100) NOT NULL,
  original_policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id),
  current_policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id),
  consecutive_warning_count INTEGER NOT NULL DEFAULT 0,
  consecutive_allow_count INTEGER NOT NULL DEFAULT 0,
  is_escalated BOOLEAN NOT NULL DEFAULT FALSE,
  escalated_at TIMESTAMPTZ,
  last_detection_action VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS user_policy_states_user_id_idx ON user_policy_states(user_id);
CREATE INDEX IF NOT EXISTS user_policy_states_session_id_idx ON user_policy_states(session_id);
CREATE INDEX IF NOT EXISTS user_policy_states_current_policy_id_idx ON user_policy_states(current_policy_id);

-- =====================================================
-- 3. 策略升级字段 (policy_profiles 扩展)
-- =====================================================
-- 添加策略升级相关字段（如果不存在）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'policy_profiles' AND column_name = 'escalation_enabled') THEN
    ALTER TABLE policy_profiles ADD COLUMN escalation_enabled BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'policy_profiles' AND column_name = 'escalation_threshold') THEN
    ALTER TABLE policy_profiles ADD COLUMN escalation_threshold INTEGER NOT NULL DEFAULT 5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'policy_profiles' AND column_name = 'escalation_target_policy_id') THEN
    ALTER TABLE policy_profiles ADD COLUMN escalation_target_policy_id VARCHAR(36) REFERENCES policy_profiles(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'policy_profiles' AND column_name = 'deescalation_threshold') THEN
    ALTER TABLE policy_profiles ADD COLUMN deescalation_threshold INTEGER NOT NULL DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'policy_profiles' AND column_name = 'escalation_cooldown_minutes') THEN
    ALTER TABLE policy_profiles ADD COLUMN escalation_cooldown_minutes INTEGER NOT NULL DEFAULT 30;
  END IF;
END $$;

-- 更新宽松策略的升级目标为严格策略
UPDATE policy_profiles
SET
  escalation_enabled = TRUE,
  escalation_threshold = 5,
  escalation_target_policy_id = 'default-policy-strict',
  deescalation_threshold = 1,
  escalation_cooldown_minutes = 0
WHERE id = 'default-policy-loose';

-- =====================================================
-- 4. 裁判模型配置表 (policy_judge_configs)
-- =====================================================
CREATE TABLE IF NOT EXISTS policy_judge_configs (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  policy_id VARCHAR(36) NOT NULL REFERENCES policy_profiles(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  provider_id VARCHAR(36) REFERENCES llm_providers(id) ON DELETE SET NULL,
  mode VARCHAR(20) NOT NULL DEFAULT 'conservative',
  trigger_mode VARCHAR(20) NOT NULL DEFAULT 'risk_or_semantic',
  trigger_threshold INTEGER NOT NULL DEFAULT 40,
  judge_threshold INTEGER NOT NULL DEFAULT 70,
  weight DECIMAL(3,2) NOT NULL DEFAULT 0.5,
  apply_to_input BOOLEAN NOT NULL DEFAULT TRUE,
  apply_to_output BOOLEAN NOT NULL DEFAULT TRUE,
  enabled_dimensions JSONB DEFAULT '[]'::jsonb,
  semantic_dimensions JSONB DEFAULT '[]'::jsonb,
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  fallback_action VARCHAR(20) NOT NULL DEFAULT 'rule',
  fail_closed_for_high_risk BOOLEAN NOT NULL DEFAULT TRUE,
  max_text_length INTEGER NOT NULL DEFAULT 6000,
  mask_pii_before_judge BOOLEAN NOT NULL DEFAULT TRUE,
  block_external_for_secrets BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(policy_id)
);

CREATE INDEX IF NOT EXISTS idx_policy_judge_configs_policy_id ON policy_judge_configs(policy_id);
CREATE INDEX IF NOT EXISTS idx_policy_judge_configs_enabled ON policy_judge_configs(enabled);

-- =====================================================
-- 5. 裁判模型调用记录表 (judge_model_invocations)
-- =====================================================
CREATE TABLE IF NOT EXISTS judge_model_invocations (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id VARCHAR(100),
  policy_id VARCHAR(36) REFERENCES policy_profiles(id) ON DELETE SET NULL,
  provider_id VARCHAR(36) REFERENCES llm_providers(id) ON DELETE SET NULL,
  direction VARCHAR(10) NOT NULL,
  model_name VARCHAR(100),
  prompt_version VARCHAR(20) DEFAULT 'v1',
  text_length INTEGER,
  rule_score INTEGER,
  rule_action VARCHAR(20),
  rule_findings JSONB DEFAULT '[]'::jsonb,
  judge_score INTEGER,
  judge_confidence DECIMAL(3,2),
  judge_action VARCHAR(20),
  judge_reason TEXT,
  judge_dimensions JSONB,
  rule_review JSONB,
  raw_response JSONB,
  parse_error TEXT,
  error_message TEXT,
  latency_ms INTEGER,
  used_in_decision BOOLEAN DEFAULT FALSE,
  decision_mode VARCHAR(20),
  final_score INTEGER,
  final_action VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_judge_model_invocations_session_id ON judge_model_invocations(session_id);
CREATE INDEX IF NOT EXISTS idx_judge_model_invocations_policy_id ON judge_model_invocations(policy_id);
CREATE INDEX IF NOT EXISTS idx_judge_model_invocations_created_at ON judge_model_invocations(created_at);

-- =====================================================
-- 完成提示
-- =====================================================
DO $$
DECLARE
  users_count INTEGER;
  policy_states_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO users_count FROM users;
  SELECT COUNT(*) INTO policy_states_count FROM user_policy_states;

  RAISE NOTICE '========================================';
  RAISE NOTICE '数据库补充表初始化完成!';
  RAISE NOTICE '用户数量: %', users_count;
  RAISE NOTICE '策略状态表: 已创建';
  RAISE NOTICE '策略升级字段: 已添加';
  RAISE NOTICE '========================================';
END $$;
