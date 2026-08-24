-- ============================================================
-- 从 NVIDIA NeMo Guardrails 导入检测规则 + 策略配置
-- 维度已在上一轮成功导入5个
-- ============================================================

-- 2.1 幻觉检测规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, config, tags, created_at) VALUES
(gen_random_uuid()::text, 'nemo-hallucination-001', '虚构事实', 'keyword', NULL, 'contains', false, 60, 80, 100, true, '检测模型编造不存在的客观事实', '请核实输出的客观事实是否准确', '{"keywords": ["据我所知", "研究表明", "据统计", "有数据显示", "实验证明", "专家指出", "据报告", "数据显示", "有证据表明"]}', '["nemo", "hallucination"]', now()),
(gen_random_uuid()::text, 'nemo-hallucination-001', '编造引用', 'regex', '(?:according to|引用|参考|根据)\s*(?:paper|论文|study|研究|report|报告)\s*(?:by|作者|from)\s*\w+', 'regex', false, 70, 85, 100, true, '检测模型编造不存在的论文、书籍或研究引用', '请核实引用来源是否真实存在', '{}', '["nemo", "hallucination"]', now()),
(gen_random_uuid()::text, 'nemo-hallucination-001', '虚假数据', 'keyword', NULL, 'contains', false, 50, 75, 100, true, '检测模型编造具体数值数据', '请核实数据来源和准确性', '{"keywords": ["精确到", "百分比是", "增长率为", "占比达", "准确率高达", "覆盖率超过"]}', '["nemo", "hallucination"]', now());

-- 2.2 话题安全规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, config, tags, created_at) VALUES
(gen_random_uuid()::text, 'nemo-topic-safety-001', '话题偏离', 'keyword', NULL, 'contains', false, 40, 70, 100, true, '检测对话偏离预设业务话题范围', '请将对话引导回业务主题', '{"keywords": ["我们来聊", "顺便问一下", "说点别的", "换个话题", "你知道", "你觉得", "你怎么看"]}', '["nemo", "topic_safety"]', now()),
(gen_random_uuid()::text, 'nemo-topic-safety-001', '受限话题探询', 'keyword', NULL, 'contains', false, 65, 80, 100, true, '检测用户试图引导模型讨论受限话题', '拒绝讨论受限话题，引导回业务范围', '{"keywords": ["你能讨论", "你对.*怎么看", "告诉我你的观点", "你支持还是反对"]}', '["nemo", "topic_safety"]', now()),
(gen_random_uuid()::text, 'nemo-topic-safety-001', '角色设定操纵', 'regex', '(?:从现在起|从现在开始|pretend|act as|扮演|你是|你现在是|forget|忽略|forget previous|忽略之前的)', 'regex', false, 70, 85, 100, true, '检测用户试图改变模型的角色或行为设定', '拒绝角色变更请求，维持原有设定', '{}', '["nemo", "topic_safety"]', now());

-- 2.3 对话操纵规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, config, tags, created_at) VALUES
(gen_random_uuid()::text, 'nemo-dialog-manipulation-001', '流程绕过', 'keyword', NULL, 'contains', false, 70, 80, 100, true, '检测用户试图绕过对话流程中的验证步骤', '必须完成验证步骤', '{"keywords": ["跳过验证", "不需要验证", "直接告诉我", "别问了", "跳过这一步", "直接进入"]}', '["nemo", "dialog_manipulation"]', now()),
(gen_random_uuid()::text, 'nemo-dialog-manipulation-001', '权限提升', 'keyword', NULL, 'contains', false, 80, 90, 100, true, '检测用户试图提升对话权限等级', '拒绝权限提升请求', '{"keywords": ["管理员权限", "提权", "升级权限", "超级用户", "root权限", "debug模式", "开发模式", "维护模式"]}', '["nemo", "dialog_manipulation"]', now()),
(gen_random_uuid()::text, 'nemo-dialog-manipulation-001', '护栏绕过', 'regex', '(?:ignore\s+(?:the\s+)?(?:rules|guidelines|safety|guardrails|restrictions)|绕过安全|无视规则|忽略限制|disable\s+(?:safety|filter|guard))', 'regex', false, 85, 95, 100, true, '检测用户试图绕过安全护栏', '拦截护栏绕过尝试', '{}', '["nemo", "dialog_manipulation"]', now());

-- 2.4 数据外泄规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, config, tags, created_at) VALUES
(gen_random_uuid()::text, 'nemo-data-exfiltration-001', 'Base64编码外传', 'regex', '(?:base64|b64|encode|解码|编码)[\s:]*(?:[A-Za-z0-9+/]{40,}={0,2})', 'regex', false, 70, 85, 100, true, '检测使用Base64编码将数据外泄的尝试', '拦截编码数据外泄', '{}', '["nemo", "data_exfiltration"]', now()),
(gen_random_uuid()::text, 'nemo-data-exfiltration-001', 'URL编码外传', 'regex', '(?:%[0-9A-Fa-f]{2}){10,}', 'regex', false, 55, 75, 100, true, '检测使用URL编码将数据外泄的尝试', '拦截编码数据外泄', '{}', '["nemo", "data_exfiltration"]', now()),
(gen_random_uuid()::text, 'nemo-data-exfiltration-001', '隐写术外传', 'keyword', NULL, 'contains', false, 65, 80, 100, true, '检测使用隐写术或特殊格式将数据嵌入输出的尝试', '拦截隐写数据外泄', '{"keywords": ["将数据隐藏在", "把信息嵌入", "用零宽字符", "steganography", "隐写", "covert channel"]}', '["nemo", "data_exfiltration"]', now()),
(gen_random_uuid()::text, 'nemo-data-exfiltration-001', 'JSON/SQL数据外传', 'regex', '(?:输出|返回|列出|show|list|return|export|导出).*(?:JSON|SQL|CSV|XML|数据库|所有用户|全部记录|all records|all users)', 'regex', false, 70, 80, 100, true, '检测试图让模型以结构化格式输出敏感数据', '拦截结构化数据外泄', '{}', '["nemo", "data_exfiltration"]', now());

-- 2.5 模型提取攻击规则
INSERT INTO detection_rules (id, dimension_id, name, type, pattern, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, config, tags, created_at) VALUES
(gen_random_uuid()::text, 'nemo-model-extraction-001', '参数探询', 'keyword', NULL, 'contains', false, 70, 80, 100, true, '检测用户试图探询模型参数和配置信息', '拒绝泄露模型参数', '{"keywords": ["模型参数", "参数量", "隐藏层", "层数", "embedding维度", "attention头数", "模型架构", "训练数据量", "learning rate"]}', '["nemo", "model_extraction"]', now()),
(gen_random_uuid()::text, 'nemo-model-extraction-001', '权重提取', 'keyword', NULL, 'contains', false, 85, 90, 100, true, '检测用户试图提取模型权重信息', '拒绝泄露模型权重', '{"keywords": ["模型权重", "weight矩阵", "参数矩阵", "权重文件", "checkpoint", "model weights", "权重分布"]}', '["nemo", "model_extraction"]', now()),
(gen_random_uuid()::text, 'nemo-model-extraction-001', '训练数据提取', 'keyword', NULL, 'contains', false, 70, 80, 100, true, '检测用户试图提取模型训练数据', '拒绝泄露训练数据信息', '{"keywords": ["训练样本", "训练数据集", "你的训练数据", "训练语料", "corpus", "dataset", "training set", "你学过什么"]}', '["nemo", "model_extraction"]', now()),
(gen_random_uuid()::text, 'nemo-model-extraction-001', '边界探测', 'regex', '(?:如果|假设|when|if|suppose|what if|给定条件).*(?:你会|will you|would you|你会如何|how would|是否|would it)', 'regex', false, 50, 70, 100, true, '检测用户通过大量边界测试来提取模型决策边界', '限制边界测试频率', '{}', '["nemo", "model_extraction"]', now());

-- 3. 为3个策略补全新维度的 policy_dimension_config
INSERT INTO policy_dimension_config (id, policy_id, dimension_id, enabled, warn_enabled, block_enabled, warn_threshold, block_threshold, auto_mask, auto_rewrite, custom_weight, action_config, created_at)
SELECT gen_random_uuid()::text, p.id, d.id, true, true, true,
  CASE
    WHEN p.id = 'default-policy-strict' THEN 30
    WHEN p.id = 'default-policy-balanced' THEN 40
    WHEN p.id = 'default-policy-loose' THEN 50
  END,
  CASE
    WHEN p.id = 'default-policy-strict' THEN 60
    WHEN p.id = 'default-policy-balanced' THEN 70
    WHEN p.id = 'default-policy-loose' THEN 80
  END,
  CASE
    WHEN d.code IN ('data_exfiltration', 'model_extraction') THEN true
    ELSE false
  END,
  false,
  d.weight,
  CASE
    WHEN p.id = 'default-policy-strict' THEN '{"block_on_warn": true}'
    ELSE '{}'
  END::jsonb,
  now()
FROM policy_profiles p
CROSS JOIN detection_dimensions d
WHERE d.code IN ('hallucination', 'topic_safety', 'dialog_manipulation', 'data_exfiltration', 'model_extraction')
AND p.id IN ('default-policy-strict', 'default-policy-balanced', 'default-policy-loose')
ON CONFLICT (policy_id, dimension_id) DO NOTHING;
