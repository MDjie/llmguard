# P0-1：ToxiCN 中文词库接入

本模块完成本地词库接入、正式 RuleDetector 编译和离线候选策略验证。不会加载 Python 的 llm-guard 扫描器，不会更改线上策略或直接修改权威主词库。P0-2/P0-3 与语义模型训练不在此次变更范围。

## 数据与行为

- 输入为 `sources.lock.json` 中 `toxiccn-v1` 的 5 个 JSON 文件，逐文件验证 SHA-256 和字节数。原始文件键是词，值是来源样本编号。
- `data/content-safety/lexicon/toxiccn-curation.v1.json` 保存自动清洗决策；文件名的 v1 表示结构，当前内容版本为 `toxiccn-curation-v2`。每条原始记录都进入 pack 的 dispositions，不会无声丢弃。
- 最终 537 条来源记录，279 个候选词，258 条排除，0 条归一化重复。支持 NFKC、大小写统一、跨分类重复合并和稳定词条 ID。
- 自动排除单字、纯 ASCII 碰撞、中性身份词及明确字面歧义词。此表是工程候选清洗，不是独立人工审批。
- 每词按风险类别展开 INPUT / OUTPUT_COMPLETE 规则，最终共 558 条。默认 locale 为 zh-CN，不覆盖其他 locale 或工具方向。
- 复用引擎已有的归一化、`LOCAL_INTENT_V1`、局部引用和否定语境处理，不增加整条消息的白名单。
- 规则统一为 `evidenceClass=SIGNAL`、`mandatoryDeny=false`，不将粗口、性倾向或历史用词直接认定为法律风险。0.7 是策略信号强度，不是经过校准的风险概率。
- 在本次旧版决策策略中，新增未确认信号进入 WARN；decisionPolicyVersion=2 下的孤立未确认信号进入 REQUIRE_REVIEW。现有硬阻断规则保持优先级。具体动作以完整策略和实测为准。
- 这是内容词法能力。ToxiCN 的五类词库不包含完整的政治风险、导流广告、隐私和违法指导词库，不能支撑这些维度的完整覆盖声明。

## 生成候选包与策略快照

在项目根目录运行，输出目录必须尚不存在：

```powershell
pnpm exec tsx scripts/content-safety/toxiccn-import.ts --out .artifact-build/toxiccn-next --snapshot .artifact-build/eval-full-live-20260909/pilot-stage-20260909/baseline/policy-snapshot.private.json
```

旧入口仍可用：`node scripts/content-safety/import-toxiccn-candidates.mjs --out NEW_DIRECTORY`。旧入口原本有语法错误和隐式自动合入逻辑，现改为调用类型化导入器。

产物：

| 文件 | 用途 |
|---|---|
| pack.json | 来源哈希、清洗版本、词条 ID、每条来源记录处理结果、不可变摘要 |
| candidates.jsonl | 可供治理转换器消费的候选输入 |
| review-conversion.json | 已通过项目 convertLexiconSources 的待审查转换结果 |
| shadow-rules.json | 正式 RuleSpec，含方向、局部语境约束、候选证据角色 |
| candidate-snapshot.json | 可选：基准策略只追加本词库规则的离线快照，不含签名或虚构的验证时间 |
| manifest.json | 计数、来源许可状态、基准哈希与非生产用途声明 |

不会覆盖已有输出目录，也不会向主词库追加重复词条。重复生成新目录应得到相同 pack 摘要。候选快照可由已有 independent-acceptance/run.ts 消费；运行时通过 --asset 加入 pack 和清洗配置以记录资产版本。

## 正式引擎全量 A/B 验证

```powershell
pnpm exec tsx scripts/content-safety/evaluate-toxiccn.ts --input eval-data/chinesesafe/test.jsonl --baseline .artifact-build/eval-full-live-20260909/pilot-stage-20260909/baseline/policy-snapshot.private.json --candidate .artifact-build/toxiccn-next/candidate-snapshot.json --pack .artifact-build/toxiccn-next/pack.json --out .artifact-build/toxiccn-next-evaluation
```

两侧均调用本项目 `createEngineForPolicyBundle`，候选 payload 必须精确等于“原 payload + 编译得到的词库规则”，不允许同时更改阈值、DAG、语义模型配置。只评估输入方向；输出方向由双向全词覆盖和引擎测试验证。

评测拒绝含语义模型的策略，禁止 fetch/socket 网络连接。对源码、静态资源、策略、评测数据和执行脚本做前后指纹校验，运行中变化则结果 INVALID。ledger 保存行号、文本哈希、规则 ID、两侧动作与信号，避免复制原始文本；发生异常计为 ERROR，不作为负例。

指标需要分开阅读：anySignal 包含未确认候选；confirmed 仅包含权威观测，其分母排除无确认且状态未知的样本；block 仅代表动作。不能把 anySignal 的改进写成已确认风险召回提升，也不能用不同的 confirmed 有效分母直接比较 FNR。ChineseSafe 原标签不是人工裁决后的生产策略标签。

## 测试与交付边界

```powershell
pnpm exec vitest run tests/content-safety/toxiccn-lexicon.test.ts tests/content-safety/lexicon-pipeline.test.ts tests/guard-engine-v2/engine.test.ts
pnpm exec tsc -p scripts/content-safety/tsconfig.toxiccn.json
```

新增测试包括全词双向检测、正常词义与身份语境、引用/否定与同消息恶意片段、零宽字符、语言范围、来源篡改、去重、转换器消费、v2 复核动作及硬阻断优先级。

当前 source lock 将 ToxiCN 标为 `PENDING_REVIEW`、`candidate_import_only`，上游提交未锁定。正式发布仍需完成来源许可核对、词条/上下文审查、语义确认链路验收，并使用现有 `compileReviewedConversion`、发布集评估、审批与签名流程。这里没有伪造人工审批，也没有新增生产绕过入口。最终交付报告记录已经完成的工作与尚未上线的状态。
