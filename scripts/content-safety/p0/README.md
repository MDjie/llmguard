# P0 内容安全复现与交接

本目录用于离线训练、校准、影子分类器协议验证及错误样本回流。全部候选保持 **SHADOW**；没有发布线上，也没有独立人工审批。执行命令前切到仓库根目录，JavaScript 命令仅使用 `pnpm`。

## 证据范围

- `runtime.py` 提供字符 TF-IDF 双通道基线，以及直接读取 Transformers 原始 logits 的评分。ToxiCN toxicity 与 ToxicChat jailbreaking 分开建模；jailbreaking 只是提示注入代理标签，不能代表所有提示注入。
- `gpu_classifier.py` 用 ChineseSafe 十个来源类别及 ToxiCN toxicity 训练 11 个输出头。来源标签不等于生产违规金标，尤其心理求助等文本需要按实际产品策略人工复核；风险映射是暂定映射。
- 样本经 NFKC、转小写及删除空白/零宽字符后，按精确重复 group 的哈希桶分为 development/calibration/test，目标比例 70/15/15。冲突组隔离，**近重复家族审核未完成**。
- 校准只用 calibration 分区的连续原始 margin/logit；拒绝二值、常量或非有限值。单调 Platt 校准后，在 calibration 上寻找 recall ≥ 0.85 且 FPR ≤ 0.10 的阈值。无可行阈值时使用 FN:FP=10:1 的代价回退，并明确标记未达到目标。该标记不是生产验收结论。
- ChineseSafe 已参与此 MacBERT 的训练，因此早先全量 ChineseSafe 评测不能再作为它的独立测试。生成的 test 分区指标仍只衡量来源标签，不能替代独立策略金标和近重复审核。

## 本机环境与现有产物

```powershell
$artifact = Join-Path (Get-Location) '.artifact-build/p0-completion-20260910'
$python = Join-Path $artifact 'gpu-venv/Scripts/python.exe'
$base = Join-Path (Get-Location) 'eval-data/models/chinese-macbert-base'
$model = Join-Path $artifact 'macbert'
$env:HF_HUB_OFFLINE = '1'
$env:TOKENIZERS_PARALLELISM = 'false'
& $python -c "import torch; print(torch.__version__); print(torch.cuda.is_available())"
```

此次环境为 torch 2.11.0+cu128、RTX 4090 Laptop 16 GB。MacBERT 来源为 `hfl/chinese-macbert-base`，固定 revision `a986e004d2a7f2a1c2f5a3edef4e20604a974ed1`，见本地 `source-lock.json`；数据许可证审核仍待完成。不要自动替换模型权重或升级依赖。

| 目录/文件 | 用途 |
| --- | --- |
| `model/` | 字符 TF-IDF 双通道基线及其独立配置 |
| `raw-content/`、`raw-injection/` | 原模型直接 logits 评分、探索性校准和源文件哈希 |
| `macbert/weights/`、`calibration.json` | 训练权重、tokenizer 与逐头校准参数 |
| `macbert/manifest.json` | 权重/校准文件哈希、来源、分区规模和逐头 test 指标 |
| `macbert/raw-logits.npz`、`split-manifest.jsonl` | calibration/test logits 与可追溯分区、来源、标签 mask |
| `macbert/classifier-shadow-config.json` | 训练生成的完整 11 头协议配置 |
| `macbert/serving-profile.json`、`classifier-shadow-selected.json`（若存在） | 后续选择的服务标签及对应身份；以该 profile 和验收报告为准，不能与完整 11 头身份混用 |
| `feedback/` | 待复核样本、来源链与计数；当前 summary 记录 10,039 条 pending、0 条 gold |
| `cpu-controls.json` | 并行评测进程原 CPU affinity/优先级及调整记录 |

训练进度看 `macbert/progress.json`，结果看 `manifest.json` 和主交付报告。README 不预先宣称训练达标。现有旧 CPU 评测 PID 68952 已限制为 2 核、BelowNormal；不要中断它或盲目按旧 PID 恢复设置，恢复前核实进程身份。GPU 工作与旧 CPU 评测是独立任务。

## 复现训练与原始评分

以下是**复现命令**，会实际占用计算资源；已有产物不需要重跑。输出目录必须不存在，脚本通过 `exist_ok=False` 防止覆盖。示例建立新的复现根目录，再按需运行其中的步骤。

```powershell
$repro = Join-Path $artifact ('repro-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $repro -ErrorAction Stop | Out-Null

# CPU 基线：ToxiCN toxicity 和 ToxicChat jailbreaking 分开训练、校准。
& $python scripts/content-safety/p0/runtime.py train --out (Join-Path $repro 'model')

# 官方预训练模型直接 logits；检测到 CUDA 时使用 GPU，不经 llm-guard scanner。
& $python scripts/content-safety/p0/runtime.py raw-scores --channel content --limit 256 --batch-size 8 --max-length 256 --threads 4 --out (Join-Path $repro 'raw-content')
& $python scripts/content-safety/p0/runtime.py raw-scores --channel injection --limit 256 --batch-size 8 --max-length 256 --threads 4 --out (Join-Path $repro 'raw-injection')

# 中文编码器微调：需要 CUDA，2 epoch，11 头。
& $python scripts/content-safety/p0/gpu_classifier.py train --base $base --out (Join-Path $repro 'macbert') --epochs 2 --batch-size 24 --max-length 256
```

原始评分分别依赖 `eval-data/models/unbiased-toxic-roberta`、`deberta-prompt-injection-v2`。`--limit` 对正负类分别取确定性样本，不能把这种平衡子样本的指标当作真实流量指标。`possiblyTruncated` 记录截断；校准/测试每类支持不足时报告 `INSUFFICIENT_CLASS_SUPPORT`，不得伪造阈值。训练固定随机种子，但 GPU 数值差异可能导致新权重哈希不同，应使用新产物的配置和身份。

## 离线模型到护栏协议验证

下面示例使用完整 11 头训练配置，创建一个真实推理请求，再把响应接入项目 `SemanticClassifierDetector` 与 `createGuardEngine`：

```powershell
$check = Join-Path $artifact ('smoke-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $check -ErrorAction Stop | Out-Null
$config = Join-Path $model 'classifier-shadow-config.json'
$spec = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
$request = Join-Path $check 'request.json'
$response = Join-Path $check 'response.json'
$payload = @{
  schemaVersion = '1.0'; operation = 'classify'
  model = @{ id = $spec.modelId; version = $spec.modelVersion; sha256 = $spec.modelSha256; quantization = $spec.quantization }
  items = @(@{ id = 'ordinary'; text = '请帮我介绍图书馆开放时间。' })
}
[IO.File]::WriteAllText($request, ($payload | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
& $python scripts/content-safety/p0/gpu_classifier.py predict --model $model --input $request --out $response
pnpm exec tsx scripts/content-safety/p0/validate-model.ts --config $config --request $request --response $response --out (Join-Path $check 'validation.json')
```

验证分别经过 `INPUT` 和 `OUTPUT_COMPLETE`，要求 SHADOW 不产生强制阻断、确认风险 MATCH 或降级。`PASS` 仅表示这批真实模型响应符合协议和影子执行约束；它**没有测试网络端点**，也不是召回率/FPR 验收。不得通过换成模拟分数获得“真实模型”结论。

## 本机 HTTP 服务

服务必须指定经过 `prepare_serving.py` 生成的 profile，按 calibration 门槛选择输出头，不能与完整 11 头离线配置混用。服务身份绑定基础模型哈希、所选标签、token 上限及 FP32 权重 + FP16 autocast 推理约定。以下在专用终端以前台方式运行；已有 58193 服务时不要再启动同端口实例。

```powershell
& $python scripts/content-safety/p0/prepare_serving.py --model $model
& $python scripts/content-safety/p0/classifier_server.py --model $model --profile (Join-Path $model 'serving-profile.json') --port 58193
```

服务只绑定 `127.0.0.1`，需要 CUDA，加载时检查模型与校准文件哈希。使用第二个终端重新设置上述路径变量；只有 `/health` 的 model 身份与请求/config 完全一致，才提交对应请求。

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:58193/health'
# 复用上一节的 $check、$payload，但换成所选服务身份。
$config = Join-Path $model 'classifier-shadow-selected.json'
$spec = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
$payload.model = @{ id = $spec.modelId; version = $spec.modelVersion; sha256 = $spec.modelSha256; quantization = $spec.quantization }
$request = Join-Path $check 'http-request.json'
[IO.File]::WriteAllText($request, ($payload | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Invoke-RestMethod -Uri 'http://127.0.0.1:58193/classify' -Method Post -ContentType 'application/json' -InFile $request
```

请求必须包含 schemaVersion `1.0`、operation `classify` 和准确模型身份；一次 1–32 条唯一 ID，正文 ≤1 MiB。超过模型 token 窗口返回 422 `CLASSIFIER_WINDOW_REQUIRED`，需要调用链提供分窗，不能默默截断当作完整覆盖。服务健康检查、HTTP 推理、离线护栏协议验证是三份不同证据；均不代表线上已切换。停止专用终端中的服务用 Ctrl+C，不杀其他评测/训练进程。

## FN/FP 回流

输入必须是已完成且身份验证通过的正式账本。`feedback.ts` 检查同目录 `summary.json` 的输入/账本哈希，再按原始行号、文本哈希和来源标签绑定记录。复现至新目录：

```powershell
$feedbackOut = Join-Path $artifact ('feedback-repro-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
pnpm exec tsx scripts/content-safety/p0/feedback.ts --historical data/content-safety/evaluations/chinesesafe-llmguard-fnfp.v1.jsonl --ledger .artifact-build/toxiccn-p0-1-20260910/chinesesafe-final/ledger.jsonl --data eval-data/chinesesafe/test.jsonl --out $feedbackOut
```

输出为 `workbench-pending.jsonl`、`provenance.jsonl` 和 `summary.json`。历史 Python llm-guard 与当前项目正式引擎的来源分别记录，未知结果不算“确认阴性”。归一化重复合并，来源标签冲突隔离；所有条目为 development、`needs_review`、无审核人、禁止外部使用，不生成生产金标。人工复核后再走工作台既有审核流程，不直接把 scanner 输出或来源标签作为新训练/校准真值。

## 最小检查与交接

```powershell
& $python -m unittest discover -s scripts/content-safety/p0 -p test_runtime.py
pnpm exec tsc -p scripts/content-safety/p0/tsconfig.json
pnpm test:unit --run tests/guard-engine-v2/p0-dimensions.test.ts tests/guard-engine-v2/semantic-classifier.test.ts
```

Python 测试覆盖重复分区一致性、非法分数拒绝、单调校准、阈值不可行标记和未定义指标；维度测试检查内容/注入分离、候选与确认信号分离及独立阈值。交接时保存实际执行命令、测试结果、配置/模型/响应/账本哈希，以及仍待完成的近重复审核、来源许可证审核、独立人工策略标注和生产验收。所有结论引用对应报告，不能仅凭进程退出成功或 SHADOW 协议 PASS 宣称上线可用。
