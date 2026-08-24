#!/usr/bin/env python3
"""
将 konsheng/Sensitive-lexicon 词库导入 GuardLLM 检测维度和规则
策略：每个词库文件映射为一个检测维度，词汇作为keyword规则导入
"""

import json
import os
import subprocess

VOCAB_DIR = "/home/ubuntu/.openclaw/workspace/project/Sensitive-lexicon/Vocabulary"

# 词库文件 → (维度code, 维度name, 维度description, category, weight, 映射已有维度ID或新建)
# 映射逻辑：优先映射到现有维度，否则创建新维度

MAPPING = {
    "色情词库.txt": {
        "dimension_id": "550e8400-e29b-41d4-a716-446655440009",  # adult_content
        "rule_name": "Sensitive-lexicon色情词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的色情低俗词汇库(928词)",
        "score": 65,
        "confidence": 85,
        "tags": ["sensitive-lexicon", "adult"],
    },
    "色情类型.txt": {
        "dimension_id": "550e8400-e29b-41d4-a716-446655440009",  # adult_content
        "rule_name": "Sensitive-lexicon色情类型",
        "rule_desc": "来自konsheng/Sensitive-lexicon的色情类型词汇库(304词)",
        "score": 60,
        "confidence": 80,
        "tags": ["sensitive-lexicon", "adult"],
    },
    "暴恐词库.txt": {
        "dimension_id": "550e8400-e29b-41d4-a716-446655440004",  # violence_hate
        "rule_name": "Sensitive-lexicon暴恐词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的暴力恐怖词汇库(177词)",
        "score": 65,
        "confidence": 85,
        "tags": ["sensitive-lexicon", "violence"],
    },
    "政治类型.txt": {
        "dimension_id": "8a05ca09-5871-4755-8d25-acc14345c004",  # politically_sensitive
        "rule_name": "Sensitive-lexicon政治敏感词",
        "rule_desc": "来自konsheng/Sensitive-lexicon的政治敏感词汇库(326词)",
        "score": 70,
        "confidence": 90,
        "tags": ["sensitive-lexicon", "politics"],
    },
    "反动词库.txt": {
        "dimension_id": "8a05ca09-5871-4755-8d25-acc14345c004",  # politically_sensitive
        "rule_name": "Sensitive-lexicon反动词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的反动词汇库(556词)",
        "score": 75,
        "confidence": 90,
        "tags": ["sensitive-lexicon", "politics"],
    },
    "涉枪涉爆.txt": {
        "dimension_id": "550e8400-e29b-41d4-a716-446655440005",  # illegal_content
        "rule_name": "Sensitive-lexicon涉枪涉爆词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的涉枪涉爆词汇库(437词)",
        "score": 75,
        "confidence": 90,
        "tags": ["sensitive-lexicon", "weapons"],
    },
    "贪腐词库.txt": {
        "dimension_id": "550e8400-e29b-41d4-a716-446655440008",  # sensitive_compliance
        "rule_name": "Sensitive-lexicon贪腐词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的贪腐词汇库(243词)",
        "score": 60,
        "confidence": 80,
        "tags": ["sensitive-lexicon", "corruption"],
    },
    "广告类型.txt": {
        "dimension_id": "f9e3d08b-ac02-4795-836c-503978e21304",  # ad_detection
        "rule_name": "Sensitive-lexicon广告词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的广告词汇库(123词)",
        "score": 50,
        "confidence": 70,
        "tags": ["sensitive-lexicon", "ads"],
    },
    "民生词库.txt": {
        # 新维度：民生敏感
        "new_dimension": {
            "code": "livelihood_sensitive",
            "name": "民生敏感",
            "description": "检测涉及民生纠纷、社会矛盾、群体性事件等敏感民生话题（来源：konsheng/Sensitive-lexicon民生词库）",
            "category": "compliance",
            "weight": 0.75,
        },
        "rule_name": "Sensitive-lexicon民生词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的民生敏感词汇库(570词)",
        "score": 55,
        "confidence": 75,
        "tags": ["sensitive-lexicon", "livelihood"],
    },
    "COVID-19词库.txt": {
        # 新维度：公共卫生敏感
        "new_dimension": {
            "code": "public_health_sensitive",
            "name": "公共卫生敏感",
            "description": "检测涉及重大公共卫生事件、疫情相关敏感信息等（来源：konsheng/Sensitive-lexicon COVID-19词库）",
            "category": "compliance",
            "weight": 0.70,
        },
        "rule_name": "Sensitive-lexicon COVID-19词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的COVID-19词汇库(75词)",
        "score": 55,
        "confidence": 75,
        "tags": ["sensitive-lexicon", "covid"],
    },
    "非法网址.txt": {
        # 新维度：恶意网址
        "new_dimension": {
            "code": "malicious_url",
            "name": "恶意网址",
            "description": "检测文本中包含已知的非法/恶意网址链接（来源：konsheng/Sensitive-lexicon非法网址库）",
            "category": "security",
            "weight": 0.90,
        },
        "rule_name": "Sensitive-lexicon非法网址库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的非法网址库(14595条)",
        "score": 70,
        "confidence": 85,
        "tags": ["sensitive-lexicon", "malicious_url"],
    },
    "补充词库.txt": {
        "dimension_id": "550e8400-e29b-41d4-a716-446655440005",  # illegal_content
        "rule_name": "Sensitive-lexicon补充词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的补充敏感词汇库(1064词)",
        "score": 55,
        "confidence": 70,
        "tags": ["sensitive-lexicon", "supplementary"],
    },
    "GFW补充词库.txt": {
        "dimension_id": "8a05ca09-5871-4755-8d25-acc14345c004",  # politically_sensitive
        "rule_name": "Sensitive-lexicon GFW补充词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的GFW补充词库(6414词)",
        "score": 65,
        "confidence": 80,
        "tags": ["sensitive-lexicon", "gfw"],
    },
    "网易前端过滤敏感词库.txt": {
        "dimension_id": "45f9982f-84a6-4e5a-917f-d9eb34c592bd",  # spam_detection
        "rule_name": "Sensitive-lexicon网易过滤词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的网易前端过滤词库(7746词)",
        "score": 50,
        "confidence": 65,
        "tags": ["sensitive-lexicon", "netease"],
    },
    "其他词库.txt": {
        "dimension_id": "550e8400-e29b-41d4-a716-446655440005",  # illegal_content
        "rule_name": "Sensitive-lexicon其他词库",
        "rule_desc": "来自konsheng/Sensitive-lexicon的其他敏感词汇库(158词)",
        "score": 45,
        "confidence": 65,
        "tags": ["sensitive-lexicon", "misc"],
    },
    # 零时-Tencent.txt 和 新思想启蒙.txt 数量过大/过小，选择性跳过或简化
}


def load_words(filepath):
    """加载词库文件，去重去空"""
    words = set()
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            w = line.strip()
            if w and len(w) >= 2:  # 至少2个字符
                words.add(w)
    return sorted(words)


def escape_sql_str(s):
    """转义SQL字符串"""
    return s.replace("'", "''")


def main():
    sql_parts = []
    new_dimensions = {}  # code -> dimension info

    # 先收集所有新维度
    for filename, config in MAPPING.items():
        if "new_dimension" in config:
            nd = config["new_dimension"]
            new_dimensions[nd["code"]] = nd

    # 生成新维度插入SQL
    if new_dimensions:
        sql_parts.append("-- 新增检测维度")
        for code, nd in new_dimensions.items():
            dim_id = f"slex-{code}"
            sql_parts.append(
                f"INSERT INTO detection_dimensions (id, code, name, description, category, weight, priority, enabled, is_system, config, created_at, updated_at) VALUES\n"
                f"('{dim_id}', '{code}', '{escape_sql_str(nd['name'])}', '{escape_sql_str(nd['description'])}', '{nd['category']}', {nd['weight']}, 88, true, false, "
                f"'{{\"source\": \"sensitive-lexicon\"}}'::jsonb, now(), now())\n"
                f"ON CONFLICT (code) DO NOTHING;"
            )
            # 记录维度ID供后续规则引用
            nd["id"] = dim_id

    # 生成规则插入SQL
    sql_parts.append("\n-- 导入Sensitive-lexicon词库为检测规则")
    
    for filename, config in MAPPING.items():
        filepath = os.path.join(VOCAB_DIR, filename)
        if not os.path.exists(filepath):
            print(f"跳过不存在的文件: {filename}")
            continue

        words = load_words(filepath)
        if not words:
            print(f"跳过空词库: {filename}")
            continue

        # 确定维度ID
        if "dimension_id" in config:
            dim_id = config["dimension_id"]
        elif "new_dimension" in config:
            nd = config["new_dimension"]
            dim_id = nd["id"]
        else:
            print(f"跳过无维度映射: {filename}")
            continue

        # 关键词JSON
        keywords_json = json.dumps(words, ensure_ascii=False)
        tags_json = json.dumps(config["tags"], ensure_ascii=False)
        config_json = json.dumps({"match_mode": "any", "case_sensitive": False, "keywords": words}, ensure_ascii=False)

        # 限制：如果词汇过多，截取前2000个（避免SQL过大）
        if len(words) > 2000:
            print(f"词库 {filename} 有 {len(words)} 词，截取前2000词")
            words = words[:2000]
            config_json = json.dumps({"match_mode": "any", "case_sensitive": False, "keywords": words, "truncated": True, "total": len(load_words(filepath))}, ensure_ascii=False)

        # 转义SQL
        config_sql = escape_sql_str(config_json)
        tags_sql = escape_sql_str(tags_json)

        sql_parts.append(
            f"INSERT INTO detection_rules (id, dimension_id, name, type, match_type, case_sensitive, score, confidence, priority, enabled, description, suggestion, config, tags, created_at) VALUES\n"
            f"(gen_random_uuid()::text, '{dim_id}', '{escape_sql_str(config['rule_name'])}', 'keyword', 'contains', false, {config['score']}, {config['confidence']}, 100, true, "
            f"'{escape_sql_str(config['rule_desc'])}', '来自Sensitive-lexicon词库', '{config_sql}'::jsonb, '{tags_sql}'::jsonb, now());"
        )

    # 为新维度创建策略配置
    if new_dimensions:
        sql_parts.append("\n-- 为新维度创建策略配置")
        policy_ids = {
            "严格策略": "default-policy-strict",
            "默认策略": "default-policy-balanced", 
            "宽松策略": "default-policy-loose",
        }
        for policy_name, policy_id in policy_ids.items():
            for code, nd in new_dimensions.items():
                dim_id = nd["id"]
                warn_t = 30 if policy_id == "default-policy-strict" else (40 if policy_id == "default-policy-balanced" else 50)
                block_t = 60 if policy_id == "default-policy-strict" else (70 if policy_id == "default-policy-balanced" else 80)
                sql_parts.append(
                    f"INSERT INTO policy_dimension_config (id, policy_id, dimension_id, enabled, warn_enabled, block_enabled, warn_threshold, block_threshold, auto_mask, auto_rewrite, custom_weight, created_at) VALUES\n"
                    f"(gen_random_uuid()::text, '{policy_id}', '{dim_id}', true, true, true, {warn_t}, {block_t}, false, false, {nd['weight']}, now())\n"
                    f"ON CONFLICT (policy_id, dimension_id) DO NOTHING;"
                )

    # 写入SQL文件
    output_path = "/home/ubuntu/.openclaw/workspace/project/GuardLLM/sensitive_lexicon_import.sql"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("-- ============================================================\n")
        f.write("-- 从 konsheng/Sensitive-lexicon (3.7k stars) 导入词库到 GuardLLM\n")
        f.write("-- ============================================================\n\n")
        f.write("\n".join(sql_parts))

    print(f"SQL文件已生成: {output_path}")
    
    # 统计
    total_words = 0
    for filename in MAPPING:
        filepath = os.path.join(VOCAB_DIR, filename)
        if os.path.exists(filepath):
            words = load_words(filepath)
            total_words += min(len(words), 2000)
            print(f"  {filename}: {len(words)} 词 (导入{min(len(words), 2000)})")
    print(f"总计: {total_words} 词将导入")


if __name__ == "__main__":
    main()
