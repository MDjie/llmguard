# 自研护栏独立离线验收工具

本目录独立于正在执行的 P0 工作。只读复用正式 `createEngineForPolicyBundle`；不改引擎、词库、训练语料、校准配置、错误回流和现有测评脚本，不写线上数据库或发布策略。所有产物必须写入一个不存在的新目录，拒绝覆盖已有结果。

## 快速使用

在项目根目录运行，使用现有 pnpm/tsx，无需安装依赖或修改 package.json。

### 1. 准备确定性诊断小样本

```powershell
pnpm exec tsx scripts/independent-acceptance/prepare.ts --input .artifact-build/eval-full-live-20260909/input/batch-1.jsonl --input .artifact-build/eval-full-live-20260909/input/batch-3.jsonl --dataset ChineseSafe --dataset WildGuardTest --dataset PKU-SafeRLHF --per-stratum 2 --out .artifact-build/acceptance-my-run/cases
```

按数据集、方向、语言、类别、标签来源、正负标签分层，以固定 seed 的 SHA-256 排名取样。默认仅取来源二元标签；`--include-proxy` 允许代理标签，`--include-unlabeled` 允许无标签样本，报告仍各自分开。保留原始正文、标签、源行号和文本 hash；不自行重新标注。

这是诊断子集，不能外推全量错误占比，也不算独立留出集。全量时可直接把既有规范化 JSONL 传给 run.ts，不必先抽样。每个输入文件分别出报告；配对比较要求两版使用完全相同的输入文件。

### 2. 执行指定策略的正式项目引擎

```powershell
pnpm exec tsx scripts/independent-acceptance/run.ts --input .artifact-build/acceptance-my-run/cases/cases.jsonl --snapshot .artifact-build/eval-full-live-20260909/pilot-stage-20260909/baseline/policy-snapshot.private.json --out .artifact-build/acceptance-my-run/B0 --name B0 --timeout-ms 10000
```

历史快照仅用于工具验证。P0 正式验收必须使用明确的 B0 代码版本及其策略快照，再在 P0 冻结版本运行相同输入。**旧策略 + 当前代码并不等于 P0 修改前的基准。** B0 可在独立冻结 checkout 中运行本工具，P0 在另一冻结 checkout 中运行，结果目录可统一交给 compare.ts。

实际加载的是快照中配置的全部检测器，包含规则、输出处理和配置模型；不会为了运行成功而自动移除模型、升级 DAG 或更改阈值。默认禁止进程的 fetch/Socket 网络连接。若快照配置了语义分类器或已启用裁判，默认在测评前拒绝启动，不能伪装成完整语义结果。

需要真实模型时显式增加 `--allow-model-network`，并设置较小的 `--max-cases` 先验证调用与成本。它允许正式运行时按快照配置访问网络，并非网络目标白名单；项目现有 egress、凭证与预算机制继续生效。凭证从受控进程环境/项目 secret provider 提供，不写进样本或报告。工具进程关闭 dotenv 自动加载；此次交付验证未使用此模式、未调用付费模型。

需要额外固定本地模型权重或非静态加载资产时，可重复传入 `--asset 文件路径`；其内容参与前后指纹检查。远端模型实际版本只能依据运行时返回信息与配置记录，不能仅凭配置中的模型名证明权重未变。

参数：`--timeout-ms` 每条请求超时预算，默认 60000，上限 600000；`--max-cases` 输入数量上限，默认 1000000；`--name` 为结果名。CLI 不截断数据凑样本：数量超过上限直接失败。

### 3. 同样本配对比较

```powershell
pnpm exec tsx scripts/independent-acceptance/compare.ts --baseline .artifact-build/acceptance-my-run/B0 --candidate .artifact-build/acceptance-my-run/P0 --out .artifact-build/acceptance-my-run/comparison
```

比较前校验运行完成状态、代码指纹稳定性、逐条文件 hash、样本数量、样本 ID、内容/上下文/标签指纹。拒绝用部分完成结果、变过标签的样本或不同输入文件计算“收益”。P0 应当与 B0 的代码/策略不同；比较工具允许这种版本差异。

输出 FN→TP、TP→FN、FP→TN、TN→FP，并完整保留 UNKNOWN 转移。UNKNOWN→TP 单独记账，不冒充已知 FN 的救回。不会根据小样本或无验证的目标自动宣告 P0 达标。

## 输入与策略契约

直接兼容现有 `.artifact-build/eval-full-live-20260909/input/batch-*.jsonl`：

```json
{"caseId":"example:1","dataset":"example","split":"test","sourcePath":"cases.jsonl","sourceRow":1,"direction":"INPUT","locale":"zh-CN","category":"example-risk","labelBasis":"source_label","expectedRisk":false,"text":"待审文本","textSha256":"实际UTF-8正文的64位SHA256"}
```

`expectedRisk` 是来源标签，可为 null。`labelBasis=source_label`、`dataset_intent`、其他标签来源及无标签结果分开统计。其他来源字段按原样保留并纳入样本指纹。

可附加 `policyExpectedRisk`、`policyReviewStatus=CONFIRMED` 和非空 `policyLabelVersion`，产生独立的政策标签报告；未确认者不计入该视图。不能把这些视图相加，因为它们可能引用同一条样本。

快照格式与已有离线快照一致：

```text
{ bundle: { id, tenantId, applicationId, generation, payload }, payloadHash, verifiedAt? }
```

工具用正式 parser 解析 payload，重新核对 canonical hash。它不加载线上 binding，也不独立重验原签名/审批；`verifiedAt` 只是来源快照元数据。正式上线门禁仍由项目系统负责。新 P0 策略应由负责 P0 的任务导出同格式快照。

### 输入/输出上下文

普通规范化数据默认是 TEXT_ONLY。工具为 INPUT/OUTPUT_COMPLETE 构造对应角色和 envelope，正文 hash 必须一致。**只有输出文本、pairId 或 promptSha256 不能恢复原始 prompt**，报告明确记为未提供问题上下文。

高级样本可提供 `request`（完整项目 GuardRequest），以及 `contextualRequest`（正式上下文合并请求）。工具分别调用 `evaluate` 或 `evaluateContextual`，复用投影与输出干预流程。当前 request 正文和方向必须与样本相同，tenant/application 必须匹配快照；运行时重新绑定请求 ID、截止时间和 bundle ID。构造的上下文还必须满足项目 envelope/来源完整性约束；失败会单独记 ERROR。不要把 user prompt 拼成 assistant 输出以“增加上下文”。本次 TEXT_ONLY 烟测不声称已验证全部多轮/配对上下文路径。

## 产物

| 文件 | 内容 |
| --- | --- |
| manifest.json | 代码/策略/数据指纹、DAG、实际检测器、模型配置版本、环境和完成状态 |
| code-index.json | src、packages、本工具源码、静态导入 JSON、显式 asset、锁文件等逐文件 SHA-256；包含未提交修改 |
| ledger.jsonl | 每条请求的执行/跳过轨迹、规则 ID、模型身份、语义覆盖、决策角色、原因和最终动作 |
| summary.json / report.md | 分标签来源、方向、数据集、语言及类别的统计 |
| progress.json | 每 250 条更新一次的进度；小批量可能没有该文件 |
| comparison.json / changes.jsonl | 配对转移矩阵及发生变化的样本定位 |

报告不保存完整正文、凭证或原始 provider 错误。规则项“不匹配”不会伪造逐条原因：当前引擎提供节点执行/跳过轨迹和实际观察到的规则，无法从中区分所有未命中规则的具体过滤条件。更细粒度的规则归因需要另行修改引擎，属于 P0 协作边界之外。

## 如何读指标

- `confirmedDetection`：仅正式引擎确认的风险为阳性。无确认但存在降级、覆盖不完整或送审时为 UNKNOWN；正常完成且无确认风险才为阴性。
- `blockDecision`：最终 action 是否为 BLOCK。降级导致的 BLOCK 也会出现在这里，不能当成模型正确识别了内容。
- 两种指标分别计算 TP/FN/FP/TN；无负例时 FPR 为 null。错误、空文本、无标签、UNKNOWN 都有单独计数。
- `fnrKnownOnly/fprKnownOnly` 只以可判定样本为分母，同时提供未知样本计数、包含未知时的最优/最坏边界和 Wilson 95% 区间。
- REQUIRE_REVIEW、MASK、REWRITE、SAFE_RESPONSE 不自动等于成功拦截。输出转换和复检信息被记录，但工具不测试 HTTP 鉴权、网关流式出口或实际内容是否释放，始终标记 `transportEnforcementVerified=false`。
- `category` 是数据集来源类别，不等于逐风险多标签 gold；没有逐风险标注时，不制造某风险的真负例。

## 并行工作与运行完整性

代码指纹在动态导入引擎前和运行结束时各计算一次；数据、策略文件也做前后核对。发现变动时产物为 INVALID，禁止进入配对对比。该机制检测净变更，**不会锁定工作区，也不能代替冻结 checkout**。长时间测评应在固定版本副本运行，不能与持续改代码的任务共享可变源码。

目录存在就拒绝运行，避免覆盖或混入其他配置的旧结果。进程中断留下 RUNNING；本版本不提供断点续跑，需新建目录重跑，或事先切分稳定输入为多个独立批次。错误输出统计保留全部分母，不以删除失败行换取好看的成绩。

## 验证命令

```powershell
pnpm exec tsc --project scripts/independent-acceptance/tsconfig.json --pretty false
pnpm exec tsx --test scripts/independent-acceptance/metrics.test.ts scripts/independent-acceptance/integration.test.ts
```

统计测试覆盖零分母、错误/空文本/未知处理、标签口径隔离、输入输出分离、降级阻断与确认风险分离、改善与退化转移、配对样本/标签篡改拒绝。真实引擎烟测及命令完整性检查见交付报告。
