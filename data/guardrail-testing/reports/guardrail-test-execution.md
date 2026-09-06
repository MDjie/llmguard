# Guardrail 自动化测试执行报告

- 执行时间：2026-09-06 16:04（Asia/Shanghai）
- 分支：`codex/detection-optimization-v2`
- 基线提交：`facba2c490a1a70f255dd083daed516f36a4ca4a`
- 交付状态：工作区实现完成，尚未提交
- 环境：Windows / Node v24.15.0 / pnpm 11.19.0 / Next.js 16.3.3

## 结果摘要

| 阶段 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript | PASS，0 错误 | `pnpm ts-check` |
| 新增及相关代码 lint | PASS，0 错误、0 告警 | scoped eslint `--max-warnings 0` |
| 全仓 lint | PASS，0 错误、85 个既有告警；随后清理相关文件 1 个告警 | `pnpm lint` |
| 全量单元/组件/API 契约测试 | PASS，190 文件、1162 用例 | `pnpm test:unit --run` |
| 工程发布门禁 | PASS | `pnpm guardrail:verify` |
| 合同生成与兼容 | PASS | `pnpm contracts:check` |
| 生产构建 | PASS，68 个静态页生成完成 | `pnpm build` |
| Playwright | PASS：8；SKIP：4 | 通过匿名边界/登录交互；需凭证的桌面和移动工作流跳过 |
| 隔离数据库集成 | NOT_RUN | 未提供 `INTEGRATION_DATABASE_URL`；未借用未知或生产数据库 |
| 真实模型连通 | NOT_RUN | 未配置测试专用密钥/预算；本次 realModelCalls=0 |
| 客户业务验收 | NOT_RUN | 缺少脱敏业务集及独立双人标注 |
| 生产发布 | NOT_RUN | 本任务未授权部署 |

## 数据与工程指标

工程集共 298 条：24 家族的攻击样本 240 条、正常难负例 48 条、反绕过 10 条。攻击集包含中文 120、英文 72、中英混合 48；每个家族固定包含中文 3、英文 3、混合 2、混淆 1、间接/RAG 1。来源为项目自编防御测试数据和已锁定的中英文候选目录，全部 `needs_review`，不是独立金标。

| 指标 | 结果 |
| --- | ---: |
| TP / TN / FP / FN | 250 / 44 / 4 / 0 |
| Precision / Recall / F1 | 98.43% / 100% / 99.21% |
| 二分类 FPR / FNR | 8.33% / 0% |
| 240 条攻击集召回 | 100% |
| 10 条反绕过阻断 | 100% |
| 正常样本硬阻断率 | 0% |
| 正常样本 WARN 复核率 | 8.33%（4/48） |
| 中文 / 英文 / 混合攻击召回 | 100% / 100% / 100% |

FP 的 4 条都是“不要泄露/不要忽略”或引用攻击文本，当前动作是 WARN 而非 BLOCK，且数据集允许 WARN。是否将其定义为客户误报必须由业务标注规则决定。23 个唯一风险类型的逐类型 TP/TN/FP/FN，以及 24 家族、语言和来源方向切片，见 `guardrail-engineering-evaluation.json`。

规则引擎在该工程集上实际执行；语义裁判完成 Mock 协议、路由、超时、异常和失败安全测试，但没有调用真实模型。因此没有把 Mock 结果伪装成真实语义质量，也没有给出规则/真实模型/融合效果的虚假横向结论。

## 性能结果

纯规则引擎 298 条串行样本：P50 0.32 ms、P95 0.80 ms、P99 11.59 ms。100 条本地合成请求并发采样：

| 并发 | wall time | P50 | P95 | P99 |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 27.18 ms | 2.00 ms | 2.71 ms | 2.85 ms |
| 50 | 28.54 ms | 8.98 ms | 14.26 ms | 14.86 ms |
| 100 | 27.04 ms | 15.27 ms | 26.07 ms | 26.78 ms |

这是单机合成微基准，不是客户容量证明。真实语义模型、缓存、熔断恢复、大词库和长文本性能仍需等价测试部署。

## 白名单与模型兼容

白名单测试覆盖 exact/prefix/suffix/regex、审批人、状态、起止时间、维度、目标规则、方向和局部坐标；追加攻击不能因前段白名单被放行，mandatory deny 不受白名单影响。

Provider Mock 覆盖 DeepSeek、GLM、Qwen、Kimi、OpenAI-compatible、custom、Ollama；认证覆盖 Bearer、自定义 API-Key 请求头和获批私网 none；故障覆盖超时、连接失败、空/错 JSON、未知标签、401、403、429、500。裁判协议强制非流式严格响应；SSE 流式裁判明确为当前不支持能力。

## 已修复缺陷

1. 旧裁判无效响应/Provider 异常可能无证据返回 SAFE。
2. 批量导入和单条新增的显式 0 分被默认成 90。
3. CSV 逗号、引号、换行、Unicode、非法分数和重复导入处理不可靠。
4. 白名单局部抑制逻辑难以独立验证。
5. 私有模型缺少自定义 API-Key 请求头。
6. 自定义头 Provider 在裁判草稿切换/保存时会退回 Bearer 或丢失密钥引用。
7. 上游错误响应缺少 401/403/429/500 不泄密的明确回归。

详细复现和状态见 `guardrail-defects.md`。

## 本任务文件

- CI/命令：`.github/workflows/quality.yml`、`package.json`。
- 数据/报告：`data/guardrail-testing/datasets/prompt-injection-engineering.v1.json`、`schemas/guardrail-engineering-dataset.schema.json`、`reports/guardrail-engineering-evaluation.json`、`reports/guardrail-engineering-gate.json`、`reports/guardrail-defects.md`。
- 生成/评估/门禁：`scripts/guardrail-testing/*.ts`。
- 核心修复：`src/lib/llm/judge-llm.ts`、`src/lib/detection/whitelist-match.ts`、`src/lib/detection/dynamic-engine.ts`、`src/lib/policy/keyword-batch*.ts`。
- Provider：`src/lib/providers/{deployment,chat}.ts`、`src/lib/judge/{profile,router,draft-service}.ts`。
- API/UI：关键词单条与批量 API、策略词库页、Provider 页、JudgeProfilesPanel/JudgeConfigPanel。
- 测试：`tests/guardrail-automation/*`、`tests/e2e/guardrail-policy-console.spec.ts`、Provider 与 egress 回归测试。
- 说明：`docs/testing/guardrail-automation-release-gate.md`。

## 外部状态与回滚

本次未确认任何数据库写入，未修改线上策略，未激活候选词库，未部署生产，未调用真实模型。Playwright 在数据库未就绪时产生了审计写入失败日志，但用例只验证允许的降级状态，未形成成功写入。

回滚应仅反向提交上述任务文件；Provider 配置可恢复为 bearer/none；候选词库从未导入或激活，无需线上词库回滚。不要用硬重置或删除整个工作区，因为工作区包含用户既有未提交文件。

## 下一步验收

必须提供隔离测试数据库、测试账号、目标策略 ID、客户脱敏双人金标数据，以及客户私有模型的测试端点/密钥引用/调用预算。随后分别执行数据库集成、完整鉴权 E2E、真实模型协议及故障注入、客户质量门禁；通过后仍需独立的生产发布审批。
