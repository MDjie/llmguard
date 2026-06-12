#!/usr/bin/env python3
"""GuardLLM 健壮批量测试脚本 - 使用subprocess+curl确保超时可靠"""

import csv
import json
import time
import sys
import os
import subprocess

API_URL = os.environ.get("GUARDLLM_API", "http://127.0.0.1:58082")
CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else "test.csv"
OUTPUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "test_results.json"
REQUEST_TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT", "60"))
LIMIT = int(os.environ.get("TEST_LIMIT", "0"))  # 0 = all
RESUME_FILE = OUTPUT_PATH + ".resume"
CHECKPOINT_INTERVAL = 50
GUARDLLM_CONTAINER = os.environ.get("GUARDLLM_CONTAINER", "guardllm-app")

stats = {
    "total": 0, "passed": 0, "failed": 0, "errors": 0, "timeouts": 0,
    "by_dimension": {}
}
results_list = []
start_time = None
completed_indices = set()

def detect(text, direction="input", timeout=REQUEST_TIMEOUT):
    """调用检测API，使用curl确保超时可靠"""
    payload = json.dumps({"text": text, "direction": direction})
    try:
        result = subprocess.run(
            ["curl", "-s", "-m", str(timeout), "--max-time", str(timeout),
             "-X", "POST", "-H", "Content-Type: application/json",
             "-d", payload,
             f"{API_URL}/api/detect"],
            capture_output=True, text=True, timeout=timeout + 10
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        elif result.returncode == 28:
            return {"success": False, "error": f"TIMEOUT after {timeout}s"}
        else:
            return {"success": False, "error": f"curl exit {result.returncode}: {result.stderr[:100]}"}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"PROCESS_TIMEOUT after {timeout+10}s"}
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"JSON decode error: {str(e)[:80]}"}
    except Exception as e:
        return {"success": False, "error": str(e)[:100]}

def restart_guardllm():
    """重启GuardLLM容器"""
    print(f"  🔄 重启 GuardLLM 容器...", flush=True)
    subprocess.run(["sudo", "docker", "restart", GUARDLLM_CONTAINER], 
                   capture_output=True, timeout=60)
    time.sleep(15)
    for attempt in range(5):
        result = detect("health check", timeout=30)
        if result.get("success"):
            print(f"  ✅ GuardLLM 恢复正常", flush=True)
            return True
        time.sleep(5)
    print(f"  ⚠️ GuardLLM 未能恢复", flush=True)
    return False

def save_checkpoint():
    """保存检查点"""
    checkpoint = {
        "stats": stats,
        "completed_indices": list(completed_indices),
        "results_count": len(results_list),
        "timestamp": time.strftime('%Y-%m-%d %H:%M:%S')
    }
    with open(RESUME_FILE, "w", encoding="utf-8") as f:
        json.dump(checkpoint, f, ensure_ascii=False)

def load_checkpoint():
    """加载检查点"""
    global stats, completed_indices
    if os.path.exists(RESUME_FILE):
        with open(RESUME_FILE, "r", encoding="utf-8") as f:
            checkpoint = json.load(f)
        stats.update(checkpoint["stats"])
        completed_indices = set(checkpoint["completed_indices"])
        print(f"从检查点恢复: 已完成 {len(completed_indices)} 条", flush=True)
        return True
    return False

def main():
    global start_time, stats, results_list
    
    with open(CSV_PATH, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    
    rows = [r for r in rows if r.get("启用", "True") == "True"]
    if LIMIT > 0:
        rows = rows[:LIMIT]
    
    resumed = load_checkpoint()
    start_time = time.time()
    if resumed and stats.get("elapsed_seconds"):
        start_time = time.time() - stats["elapsed_seconds"]
    
    print(f"开始串行测试，共 {len(rows)} 条，请求超时: {REQUEST_TIMEOUT}s", flush=True)
    
    consecutive_errors = 0
    
    for i, row in enumerate(rows):
        if i in completed_indices:
            continue
        
        text = row.get("测试输入", row.get("标题", ""))
        expected_action = row.get("预期动作", "").strip()
        expected_dim = row.get("预期维度", row.get("检测维度", "")).strip()
        dimension = row.get("检测维度", "")
        
        result = detect(text)
        completed_indices.add(i)
        
        local_result = {
            "index": i, "text": text[:100], "dimension": dimension,
            "expected_action": expected_action, "actual_action": None,
            "error": None, "pass": False, "latency_ms": 0
        }
        
        if not result.get("success"):
            error_msg = result.get("error", "unknown")
            local_result["error"] = error_msg
            stats["total"] += 1
            stats["errors"] += 1
            stats["failed"] += 1
            if "TIMEOUT" in error_msg.upper():
                stats["timeouts"] = stats.get("timeouts", 0) + 1
                consecutive_errors += 2
            else:
                consecutive_errors += 1
            
            if consecutive_errors >= 3:
                restart_guardllm()
                consecutive_errors = 0
        else:
            consecutive_errors = 0
            data = result["data"]
            actual_action = data.get("action", "allow")
            findings = data.get("findings", [])
            hit_dims = [f.get("dimension", "") for f in findings]
            latency_ms = data.get("latencyMs", 0)
            
            local_result["actual_action"] = actual_action
            local_result["latency_ms"] = latency_ms
            
            passed = False
            if expected_action == "block" and actual_action in ("block", "warn"):
                passed = True
            elif expected_action == "allow" and actual_action == "allow":
                passed = True
            elif expected_action == "warn" and actual_action in ("block", "warn"):
                passed = True
            
            dim_match = True
            if expected_dim and hit_dims:
                try:
                    exp_dims = json.loads(expected_dim) if expected_dim.startswith("[") else [expected_dim]
                except:
                    exp_dims = [expected_dim]
                dim_match = any(d in hit_dims for d in exp_dims)
            
            local_result["pass"] = passed and dim_match
            
            stats["total"] += 1
            if local_result["pass"]:
                stats["passed"] += 1
            else:
                stats["failed"] += 1
        
        # 维度统计
        if dimension not in stats["by_dimension"]:
            stats["by_dimension"][dimension] = {"total": 0, "passed": 0, "failed": 0, "errors": 0}
        stats["by_dimension"][dimension]["total"] += 1
        if local_result["pass"]:
            stats["by_dimension"][dimension]["passed"] += 1
        elif not result.get("success"):
            stats["by_dimension"][dimension]["errors"] += 1
            stats["by_dimension"][dimension]["failed"] += 1
        else:
            stats["by_dimension"][dimension]["failed"] += 1
        
        if not local_result["pass"]:
            results_list.append(local_result)
        
        completed_count = len(completed_indices)
        elapsed = time.time() - start_time
        rate = completed_count / max(elapsed, 1)
        eta = (len(rows) - completed_count) / max(rate, 0.001) / 60
        pass_rate = stats["passed"] / max(stats["total"], 1) * 100
        
        # Progress every 10 items or on error
        if completed_count % 10 == 0 or not result.get("success"):
            msg = f"[{completed_count}/{len(rows)}] 通过率: {pass_rate:.1f}% | {rate:.2f}条/s | ETA: {eta:.0f}min"
            if not result.get("success"):
                msg += f" | ERROR: {local_result.get('error','?')[:50]}"
            print(f"  {msg}", flush=True)
        
        # Checkpoint and progress file every 50 items
        if completed_count % CHECKPOINT_INTERVAL == 0:
            save_checkpoint()
            with open(os.path.join(os.path.dirname(OUTPUT_PATH) or '/tmp', 'guardllm_progress.txt'), 'w') as pf:
                pf.write(f"completed={completed_count}\ntotal={len(rows)}\npassed={stats['passed']}\nfailed={stats['failed']}\nerrors={stats['errors']}\ntimeouts={stats.get('timeouts',0)}\nrate={rate:.2f}\neta_min={eta:.0f}\nelapsed_min={elapsed/60:.0f}\nupdated={time.strftime('%Y-%m-%d %H:%M:%S')}\n")
    
    # 完成
    elapsed = time.time() - start_time
    stats["elapsed_seconds"] = round(elapsed, 1)
    stats["rate_per_second"] = round(stats["total"] / max(elapsed, 1), 2)
    
    print("\n" + "="*60, flush=True)
    print(f"测试完成！总耗时: {elapsed:.1f}s ({elapsed/3600:.1f}h)", flush=True)
    print(f"总条数: {stats['total']}, 通过: {stats['passed']}, 失败: {stats['failed']}, 错误: {stats['errors']}, 超时: {stats.get('timeouts',0)}", flush=True)
    print(f"通过率: {stats['passed']/max(stats['total'],1)*100:.1f}%", flush=True)
    print(f"速率: {stats['rate_per_second']:.2f} 条/秒", flush=True)
    print("\n=== 按维度统计 ===", flush=True)
    for dim, s in sorted(stats["by_dimension"].items(), key=lambda x: -x[1]["total"]):
        rate = s["passed"] / max(s["total"], 1) * 100
        print(f"  {dim}: {s['passed']}/{s['total']} = {rate:.1f}% (失败{s['failed']} 错误{s['errors']})", flush=True)
    
    output = {"stats": stats, "failed_results": results_list[:2000]}
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n详细结果已保存到: {OUTPUT_PATH}", flush=True)
    
    if os.path.exists(RESUME_FILE):
        os.remove(RESUME_FILE)

if __name__ == "__main__":
    main()
