#!/usr/bin/env python3
"""GuardLLM 批量测试脚本 - 使用测试数据集CSV"""

import csv
import json
import time
import sys
import os

API_URL = os.environ.get("GUARDLLM_API", "http://127.0.0.1:58082")
CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else "test.csv"
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "test_results.json"
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))
LIMIT = int(os.environ.get("TEST_LIMIT", "0"))  # 0 = all

import urllib.request

def detect(text, direction="input"):
    """调用检测API"""
    data = json.dumps({"text": text, "direction": direction}).encode("utf-8")
    req = urllib.request.Request(
        f"{API_URL}/api/detect",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"success": False, "error": str(e)}

def run_test():
    results = []
    stats = {
        "total": 0, "passed": 0, "failed": 0, "errors": 0,
        "by_dimension": {}, "by_action": {}
    }
    
    with open(CSV_PATH, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    
    # 过滤启用的
    rows = [r for r in rows if r.get("启用", "True") == "True"]
    
    if LIMIT > 0:
        rows = rows[:LIMIT]
    
    print(f"开始测试，共 {len(rows)} 条")
    start_time = time.time()
    
    for i, row in enumerate(rows):
        text = row.get("测试输入", row.get("标题", ""))
        expected_action = row.get("预期动作", "").strip()
        expected_dim = row.get("预期维度", row.get("检测维度", "")).strip()
        min_score = float(row.get("最低分", 0))
        max_score = float(row.get("最高分", 100))
        dimension = row.get("检测维度", "")
        
        result = detect(text)
        stats["total"] += 1
        
        if not result.get("success"):
            stats["errors"] += 1
            results.append({
                "index": i, "text": text[:50], "dimension": dimension,
                "expected_action": expected_action, "actual_action": "error",
                "error": result.get("error", "unknown"), "pass": False
            })
            if (i + 1) % 50 == 0:
                print(f"  [{i+1}/{len(rows)}] 错误: {result.get('error','')[:50]}")
            continue
        
        data = result["data"]
        actual_action = data.get("action", "allow")
        actual_score = data.get("overallScore", 0)
        findings = data.get("findings", [])
        hit_dims = [f.get("dimension", "") for f in findings]
        
        # 判断通过：
        # 1. 预期block → 实际block或warn
        # 2. 预期allow → 实际allow
        # 3. 预期维度在命中维度中（如有命中）
        passed = False
        if expected_action == "block" and actual_action in ("block", "warn"):
            passed = True
        elif expected_action == "allow" and actual_action == "allow":
            passed = True
        elif expected_action == "warn" and actual_action in ("block", "warn"):
            passed = True
        
        # 维度匹配
        dim_match = True
        if expected_dim and hit_dims:
            # 解析expected_dim，可能是JSON数组字符串
            try:
                exp_dims = json.loads(expected_dim) if expected_dim.startswith("[") else [expected_dim]
            except:
                exp_dims = [expected_dim]
            dim_match = any(d in hit_dims for d in exp_dims)
        
        if passed and dim_match:
            stats["passed"] += 1
        else:
            stats["failed"] += 1
        
        # 统计
        if dimension not in stats["by_dimension"]:
            stats["by_dimension"][dimension] = {"total": 0, "passed": 0, "failed": 0, "errors": 0}
        stats["by_dimension"][dimension]["total"] += 1
        if not result.get("success"):
            stats["by_dimension"][dimension]["errors"] += 1
        elif passed and dim_match:
            stats["by_dimension"][dimension]["passed"] += 1
        else:
            stats["by_dimension"][dimension]["failed"] += 1
        
        if (i + 1) % 100 == 0:
            elapsed = time.time() - start_time
            rate = (i + 1) / elapsed
            print(f"  [{i+1}/{len(rows)}] 通过率: {stats['passed']}/{stats['total']} = {stats['passed']/max(stats['total'],1)*100:.1f}% | {rate:.1f}条/s")
    
    elapsed = time.time() - start_time
    stats["elapsed_seconds"] = round(elapsed, 1)
    stats["rate_per_second"] = round(stats["total"] / max(elapsed, 1), 2)
    
    # 汇总
    print("\n" + "="*60)
    print(f"测试完成！总耗时: {elapsed:.1f}s")
    print(f"总条数: {stats['total']}, 通过: {stats['passed']}, 失败: {stats['failed']}, 错误: {stats['errors']}")
    print(f"通过率: {stats['passed']/max(stats['total'],1)*100:.1f}%")
    print("\n=== 按维度统计 ===")
    for dim, s in sorted(stats["by_dimension"].items(), key=lambda x: -x[1]["total"]):
        rate = s["passed"] / max(s["total"], 1) * 100
        print(f"  {dim}: {s['passed']}/{s['total']} = {rate:.1f}% (失败{s['failed']} 错误{s['errors']})")
    
    # 保存
    output = {"stats": stats, "results": results[:500]}  # 只保存前500条失败详情
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n详细结果已保存到: {OUTPUT_PATH}")

if __name__ == "__main__":
    run_test()
