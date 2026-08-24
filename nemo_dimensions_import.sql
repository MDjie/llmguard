-- ============================================================
-- 从 NVIDIA NeMo Guardrails 导入检测维度到 GuardLLM
-- 新增5个维度 + 检测规则 + 策略配置
-- ============================================================

-- 1. 新增检测维度
INSERT INTO detection_dimensions (id, code, name, description, category, weight, priority, enabled, is_system, config, created_at, updated_at) VALUES
('nemo-hallucination-001', 'hallucination', '幻觉检测', '检测模型输出中的幻觉内容，包括事实性错误、无根据的断言、编造的数据或引用等（来源：NVIDIA NeMo Guardrails hallucination模块）', 'quality', 0.85, 88, true, false, '{"source": "nemo_guardrails", "module": "hallucination"}', now(), now()),
('nemo-topic-safety-001', 'topic_safety', '话题安全', '检测对话是否偏离预设话题范围，防止模型在不相关或受限话题上生成内容（来源：NVIDIA NeMo Guardrails topic_safety模块）', 'security', 0.80, 86, true, false, '{"source": "nemo_guardrails", "module": "topic_safety"}', now(), now()),
('nemo-dialog-manipulation-001', 'dialog_manipulation', '对话操纵', '检测用户试图通过对话流程操纵模型行为，如诱导模型跳过验证、绕过护栏、执行未授权操作等（来源：NVIDIA NeMo Guardrails dialog rails）', 'security', 0.90, 92, true, false, '{"source": "nemo_guardrails", "module": "dialog_rails"}', now(), now()),
('nemo-data-exfiltration-001', 'data_exfiltration', '数据外泄', '检测模型输出中可能被用于数据外泄的内容，包括通过隐蔽编码（Base64、URL编码等）将敏感数据传输到外部（来源：NVIDIA NeMo Guardrails sensitive_data_detection + execution rails）', 'privacy', 0.95, 93, true, false, '{"source": "nemo_guardrails", "module": "sensitive_data_detection"}', now(), now()),
('nemo-model-extraction-001', 'model_extraction', '模型提取攻击', '检测用户试图通过大量查询提取模型参数、训练数据或内部逻辑的攻击行为（来源：NVIDIA NeMo Guardrails ai_defense模块）', 'security', 0.90, 94, true, false, '{"source": "nemo_guardrails", "module": "ai_defense"}', now(), now());

-- 2. 为每个新维度创建检测规则
-- 2.1 幻觉检测规则
INSERT INTO detection_rules (id, dimension_id, name, description, rule_type, pattern, keywords, severity, score, enabled, is_system, config, created_at, updated_at) VALUES
(gen_random_uuid()::text, 'nemo-hallucination-001', '虚构事实', '检测模型编造不存在的客观事实', 'keyword', NULL, '据我所知,研究表明,据统计,有数据显示,实验证明,专家指出,据报告,数据显示,有证据表明', 'high', 60, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-hallucination-001', '编造引用', '检测模型编造不存在的论文、书籍或研究引用', 'regex', '(?:according to|引用|参考|根据)\s*(?:paper|论文|study|研究|report|报告)\s*(?:by|by|作者|from)\s*\w+', NULL, 'high', 70, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-hallucination-001', '虚假数据', '检测模型编造具体数值数据', 'keyword', NULL, '精确到,百分比是,增长率为,占比达,准确率高达,覆盖率超过', 'medium', 50, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now());

-- 2.2 话题安全规则
INSERT INTO detection_rules (id, dimension_id, name, description, rule_type, pattern, keywords, severity, score, enabled, is_system, config, created_at, updated_at) VALUES
(gen_random_uuid()::text, 'nemo-topic-safety-001', '话题偏离', '检测对话偏离预设业务话题范围', 'keyword', NULL, '我们来聊,顺便问一下,说点别的,换个话题,你知道,你觉得,你怎么看', 'medium', 40, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-topic-safety-001', '受限话题探询', '检测用户试图引导模型讨论受限话题', 'keyword', NULL, '你能讨论,你对.*怎么看,告诉我你的观点,你支持还是反对,你认为.*应该', 'high', 65, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-topic-safety-001', '角色设定操纵', '检测用户试图改变模型的角色或行为设定', 'regex', '(?:从现在起|从现在开始|pretend|act as|扮演|你是|你现在是|forget|忽略|forget previous|忽略之前的)', NULL, 'high', 70, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now());

-- 2.3 对话操纵规则
INSERT INTO detection_rules (id, dimension_id, name, description, rule_type, pattern, keywords, severity, score, enabled, is_system, config, created_at, updated_at) VALUES
(gen_random_uuid()::text, 'nemo-dialog-manipulation-001', '流程绕过', '检测用户试图绕过对话流程中的验证步骤', 'keyword', NULL, '跳过验证,不需要验证,直接告诉我,别问了,跳过这一步,直接进入', 'high', 70, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-dialog-manipulation-001', '权限提升', '检测用户试图提升对话权限等级', 'keyword', NULL, '管理员权限,提权,升级权限,超级用户,root权限,debug模式,开发模式,维护模式', 'critical', 80, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-dialog-manipulation-001', '护栏绕过', '检测用户试图绕过安全护栏', 'regex', '(?:ignore\s+(?:the\s+)?(?:rules|guidelines|safety|guardrails|restrictions)|绕过安全|无视规则|忽略限制|disable\s+(?:safety|filter|guard))', NULL, 'critical', 85, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now());

-- 2.4 数据外泄规则
INSERT INTO detection_rules (id, dimension_id, name, description, rule_type, pattern, keywords, severity, score, enabled, is_system, config, created_at, updated_at) VALUES
(gen_random_uuid()::text, 'nemo-data-exfiltration-001', 'Base64编码外传', '检测使用Base64编码将数据外泄的尝试', 'regex', '(?:base64|b64|encode|解码|编码)[\s:]*(?:[A-Za-z0-9+/]{40,}={0,2})', NULL, 'high', 70, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-data-exfiltration-001', 'URL编码外传', '检测使用URL编码将数据外泄的尝试', 'regex', '(?:%[0-9A-Fa-f]{2}){10,}', NULL, 'medium', 55, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-data-exfiltration-001', '隐写术外传', '检测使用隐写术或特殊格式将数据嵌入输出的尝试', 'keyword', NULL, '将数据隐藏在,把信息嵌入,用零宽字符,steganography,隐写,covert channel', 'high', 65, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-data-exfiltration-001', 'JSON/SQL数据外传', '检测试图让模型以结构化格式输出敏感数据', 'regex', '(?:输出|返回|列出|show|list|return|export|导出).*(?:JSON|SQL|CSV|XML|数据库|所有用户|全部记录|all records|all users)', NULL, 'high', 70, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now());

-- 2.5 模型提取攻击规则
INSERT INTO detection_rules (id, dimension_id, name, description, rule_type, pattern, keywords, severity, score, enabled, is_system, config, created_at, updated_at) VALUES
(gen_random_uuid()::text, 'nemo-model-extraction-001', '参数探询', '检测用户试图探询模型参数和配置信息', 'keyword', NULL, '模型参数,参数量,隐藏层,层数,embedding维度,attention头数,模型架构,训练数据量,learning rate', 'high', 70, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-model-extraction-001', '权重提取', '检测用户试图提取模型权重信息', 'keyword', NULL, '模型权重,weight矩阵,参数矩阵,权重文件,checkpoint,model weights,权重分布', 'critical', 85, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-model-extraction-001', '训练数据提取', '检测用户试图提取模型训练数据', 'keyword', NULL, '训练样本,训练数据集,你的训练数据,训练语料,corpus,dataset,training set,你学过什么', 'high', 70, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now()),
(gen_random_uuid()::text, 'nemo-model-extraction-001', '边界探测', '检测用户通过大量边界测试来提取模型决策边界', 'regex', '(?:如果|假设|when|if|suppose|what if|给定条件).*(?:你会|will you|would you|你会如何|how would|是否|would it)', NULL, 'medium', 50, true, false, '{"match_mode": "any", "case_sensitive": false}', now(), now());

-- 3. 为3个策略补全新维度的 policy_dimension_config
-- 获取策略ID
-- strict策略
INSERT INTO policy_dimension_config (id, policy_id, dimension_id, enabled, action, threshold, weight, created_at, updated_at)
SELECT gen_random_uuid()::text, p.id, d.id, true,
  CASE
    WHEN p.name = '严格策略' THEN 'block'
    WHEN p.name = '均衡策略' THEN 'warn'
    WHEN p.name = '宽松策略' THEN 'warn'
  END,
  CASE
    WHEN p.name = '严格策略' THEN 40
    WHEN p.name = '均衡策略' THEN 50
    WHEN p.name = '宽松策略' THEN 60
  END,
  d.weight,
  now(), now()
FROM policies p
CROSS JOIN detection_dimensions d
WHERE d.code IN ('hallucination', 'topic_safety', 'dialog_manipulation', 'data_exfiltration', 'model_extraction')
AND p.name IN ('严格策略', '均衡策略', '宽松策略')
ON CONFLICT DO NOTHING;
