#!/usr/bin/env python3
"""GuardLLM 并发批量测试脚本 - 使用测试数据集CSV"""

import csv
import json
import time
import sys
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

API_URL = os.environ.get("GUARDLLM_API", "http://127.0.0.1:58082")
CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else "test.csv"
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "test_results.json"
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "2"))
LIMIT = int(os.environ.get("TEST_LIMIT", "0"))  # 0 = all

# Thread-safe counters
lock = threading.Lock()
stats = {
    "total": 0, "passed": 0, "failed": 0, "errors": 0,
    "by_dimension": {}, "by_action": {}
}
results_list = []
start_time = None

def detect(text, direction="input", max_retries=2):
    """调用检测API，带重试"""
    data = json.dumps({"text": text, "direction": direction}).encode("utf-8")
    for attempt in range(max_retries + 1):
        req = urllib.request.Request(
            f"{API_URL}/api/detect",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if not result.get("success") and attempt < max_retries:
                    time.sleep(2)
                    continue
                return result
        except Exception as e:
            if attempt < max_retries:
                time.sleep(5)
                continue
            return {"success": False, "error": str(e)}

def process_row(i, row):
    """处理单条测试数据"""
    text = row.get("测试输入", row.get("标题", ""))
    expected_action = row.get("预期动作", "").strip()
    expected_dim = row.get("预期维度", row.get("检测维度", "")).strip()
    dimension = row.get("检测维度", "")
    
    if i < 5 or i % 100 == 0:
        print(f"  > 请求 #{i}: {text[:40]}...", flush=True)
    
    result = detect(text)
    
    local_result = {
        "index": i, "text": text[:80], "dimension": dimension,
        "expected_action": expected_action, "actual_action": None,
        "error": None, "pass": False
    }
    
    if not result.get("success"):
        local_result["error"] = result.get("error", "API returned success=false")
        return local_result, dimension, "error", False
    
    data = result["data"]
    actual_action = data.get("action", "allow")
    findings = data.get("findings", [])
    hit_dims = [f.get("dimension", "") for f in findings]
    
    local_result["actual_action"] = actual_action
    
    # 判断通过
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
        try:
            exp_dims = json.loads(expected_dim) if expected_dim.startswith("[") else [expected_dim]
        except:
            exp_dims = [expected_dim]
        dim_match = any(d in hit_dims for d in exp_dims)
    
    local_result["pass"] = passed and dim_match
    
    return local_result, dimension, actual_action, (passed and dim_match)

def main():
    global start_time
    
    with open(CSV_PATH, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    
    rows = [r for r in rows if r.get("启用", "True") == "True"]
    if LIMIT > 0:
        rows = rows[:LIMIT]
    
    print(f"开始并发测试，共 {len(rows)} 条，并发数: {MAX_CONCURRENT}")
    start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as executor:
        futures = {}
        for i, row in enumerate(rows):
            future = executor.submit(process_row, i, row)
            futures[future] = i
        
        completed = 0
        for future in as_completed(futures):
            local_result, dimension, action, passed = future.result()
            completed += 1
            
            with lock:
                stats["total"] += 1
                if local_result["pass"]:
                    stats["passed"] += 1
                elif action == "error":
                    stats["errors"] += 1
                    stats["failed"] += 1
                else:
                    stats["failed"] += 1
                
                if dimension not in stats["by_dimension"]:
                    stats["by_dimension"][dimension] = {"total": 0, "passed": 0, "failed": 0, "errors": 0}
                stats["by_dimension"][dimension]["total"] += 1
                if local_result["pass"]:
                    stats["by_dimension"][dimension]["passed"] += 1
                elif action == "error":
                    stats["by_dimension"][dimension]["errors"] += 1
                    stats["by_dimension"][dimension]["failed"] += 1
                else:
                    stats["by_dimension"][dimension]["failed"] += 1
                
                # Only keep failed results for review
                if not local_result["pass"]:
                    results_list.append(local_result)
            
            if completed % 10 == 0:
                elapsed = time.time() - start_time
                rate = completed / elapsed
                eta = (len(rows) - completed) / rate / 60
                msg = f"[{completed}/{len(rows)}] 通过率: {stats['passed']}/{stats['total']} = {stats['passed']/max(stats['total'],1)*100:.1f}% | {rate:.2f}条/s | ETA: {eta:.0f}min"
                print(f"  {msg}")
                # Write progress file
                with open(os.path.join(os.path.dirname(OUTPUT_PATH), 'guardllm_progress.txt'), 'w') as pf:
                    pf.write(f"completed={completed}\ntotal={len(rows)}\npassed={stats['passed']}\nfailed={stats['failed']}\nerrors={stats['errors']}\nrate={rate:.2f}\neta_min={eta:.0f}\nelapsed_min={elapsed/60:.0f}\nupdated={time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    
    elapsed = time.time() - start_time
    stats["elapsed_seconds"] = round(elapsed, 1)
    stats["rate_per_second"] = round(stats["total"] / max(elapsed, 1), 2)
    
    # 汇总
    print("\n" + "="*60)
    print(f"测试完成！总耗时: {elapsed:.1f}s ({elapsed/60:.1f}min)")
    print(f"总条数: {stats['total']}, 通过: {stats['passed']}, 失败: {stats['failed']}, 错误: {stats['errors']}")
    print(f"通过率: {stats['passed']/max(stats['total'],1)*100:.1f}%")
    print(f"速率: {stats['rate_per_second']:.2f} 条/秒")
    print("\n=== 按维度统计 ===")
    for dim, s in sorted(stats["by_dimension"].items(), key=lambda x: -x[1]["total"]):
        rate = s["passed"] / max(s["total"], 1) * 100
        print(f"  {dim}: {s['passed']}/{s['total']} = {rate:.1f}% (失败{s['failed']} 错误{s['errors']})")
    
    # 保存
    output = {"stats": stats, "failed_results": results_list[:1000]}
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n详细结果已保存到: {OUTPUT_PATH}")

if __name__ == "__main__":
    main()
