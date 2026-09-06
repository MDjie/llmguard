# 大模型护栏自动化测试与发布门禁

## 1. 结论与边界

当前产品是“确定性规则召回 + 受限白名单 + 可选上下文语义裁判 + 策略聚合”的混合检测系统，不是纯关键词系统，也不是所有请求都调用大模型。工程数据集和 Mock Provider 已形成可重复门禁；真实模型连通、客户脱敏金标质量、测试环境部署和生产发布仍是彼此独立的验收阶段。

本次没有写生产数据库、没有修改线上策略、没有部署生产、没有调用付费模型。合成数据全部标记为 `needs_review`、`INSUFFICIENT_EVIDENCE` 和 `independentBusinessGold=false`，不得据此宣称客户准确率。

## 2. 当前检测链路

1. `normalization.ts` 生成原文、Unicode、零宽字符、全角、编码解码等候选视图并保留坐标映射。
2. `RuleDetector`、内置正则和 `PromptAttackDetector` 进行词法、结构、组合与提示词攻击召回。
3. 动态白名单仅抑制被批准规则的局部命中；必须绑定客户、应用、维度、规则、方向和有效期，不能抑制 mandatory deny，也不能跳过后续语义检测。
4. `SemanticClassifierDetector` / `JudgeDetector` 按策略和场景选择语义裁判；支持完整文本或受限窗口、多轮安全记忆、RAG/工具/输出方向。
5. DAG 在统一截止时间、并发和失败策略下执行检测器，聚合器输出 ALLOW/WARN/BLOCK 及证据。
6. API 将动作映射为产品处置并写审计链；证据使用 HMAC/脱敏，不应记录原始密钥或系统提示词。

## 3. 词库与规则静态盘点

| 资产 | 当前数量 | 状态/说明 |
| --- | ---: | --- |
| 主内容安全候选词 | 61 | `content-safety-lexicon.v1.jsonl`；清单声明 63 seed，其中实际 `_type=term` 为 61 |
| 主白名单规则 | 12 | 候选治理规则 |
| 提示词注入短语 | 144 | 24 家族 × 中文 3 + 英文 3；待审核、不可直接生产硬阻断 |
| 提示词注入组合正则 | 48 新增 + 16 保留 = 64 | 内置 V2 检测器 |
| FWWDN 暂存候选 | 1,156 | 来源/授权与人工复核未完成 |
| 多源转换盘点 | 11,713 输入、9,561 唯一 | 797 接受、990 重复、9,914 隔离、12 拒绝；全部候选、不可生产 |
| 工程自动化数据 | 298 | 240 攻击、48 正常、10 反绕过；不是金标词库 |
| 截图目标环境 | 3 英文词 | 仅为用户截图；无目标环境凭证，不能据此推断数据库总量 |
| 本地只读历史审计 | prompt_injection 关键词 0、活动包规则 18 | 仅对应先前本地审计快照，不代表线上 |

文件资产和数据库运行时资产必须分开统计。数据库的启用/停用/影子/正式发布总数只有在明确的隔离测试库或获得目标环境只读凭证后才能重新核对；本次未连接未知数据库。

## 4. 现状—缺口—测试映射

| 能力 | 现状 | 本次处理 | 自动化证据 |
| --- | --- | --- | --- |
| 提示词注入覆盖 | 24 个重叠工程家族，中英文规则 | 构造每家族 10 种固定变体 | dataset + bilingual detector tests |
| 正常语境 | 引用/否定降级为候选复核 | 48 条难负例，分别报告 WARN 与硬阻断 | engineering report |
| 白名单 | 局部、审批、作用域和期限约束 | 提取纯函数并覆盖 11 个边界 | `whitelist-scope.test.ts` |
| 批量导入 | 页面 CSV 解析脆弱，0 分会变 90，请求内可重复 | 严格 CSV、0 分保留、范围校验、去重 | parser/API row tests |
| 单条新增 | 0 分会因 `|| 90` 被抬高 | 改为 nullish 默认 | 类型检查和现有 API 契约测试 |
| 旧裁判失败 | 无效 JSON/异常可能返回 SAFE | 严格 schema，异常转 REVIEW/WARN，明显风险转 BLOCK | `legacy-judge-fail-safe.test.ts` |
| 模型兼容 | 多品牌 OpenAI-compatible、Bearer、私网无鉴权 | 新增受校验的自定义 API-Key 请求头 | judge/private/egress tests |
| 上游异常 | 超时与格式异常已有测试 | 增加 401/403/429/500 且不泄露响应正文 | `egress.test.ts` |
| E2E | 已有隔离数据库浏览器工作流 | 增加可选只读词库/API 一致性用例 | Playwright + integration script |
| 性能 | 已有 k6 与策略基准脚本 | 门禁报告增加 10/50/100 本地并发采样 | engineering report |

## 5. 数据集与指标定义

数据文件为 `data/guardrail-testing/datasets/prompt-injection-engineering.v1.json`，schema 为 `data/guardrail-testing/schemas/guardrail-engineering-dataset.schema.json`。生成器按源码摘要确定性产出，`--check` 可检测漂移。

二分类指标把 WARN/BLOCK 视为风险信号；产品处置指标另行报告正常样本 WARN 率和硬阻断率。当前合成集：攻击召回 100%，反绕过阻断 100%，正常样本硬阻断 0%；4/48 正常样本进入 WARN 复核，因此二分类信号误报率为 8.33%。这些样本属于否定或引用攻击文本，WARN 是数据集允许动作，但需要客户标注决定业务上是否应视为误报。

不要把 `legacyExactActionMetrics.accuracy` 当作安全准确率：它是 ALLOW/WARN/BLOCK 三值动作完全一致率。正式质量只读取 `binaryRiskMetrics`，并按风险家族、语言、来源方向、策略版本和模型版本切片。

## 6. 发布门禁

执行 `pnpm guardrail:verify`，依次检查数据集未漂移、专项单测、298 条工程评估和门禁。CI 已在全量单测后执行该命令。门禁要求：24 家族、240 攻击变体、至少 40 正常样本、至少 9 反绕过、攻击召回 ≥95%、正常样本硬阻断 ≤2%、反绕过阻断 100%、无外部副作用、不得冒充客户金标。

完整发布前还必须执行：

```text
pnpm contracts:check
pnpm ts-check
pnpm lint
pnpm test:unit --run
pnpm guardrail:verify
pnpm build
```

隔离数据库集成测试使用 `pnpm test:integration`。浏览器真实登录工作流需要本地隔离 PostgreSQL 和显式测试凭证；普通 Playwright 用例使用 `pnpm test:e2e`。真实 Provider 连通仅在配置测试专用密钥、调用预算、超时和非生产端点后执行。

## 7. Provider Mock 合约

统一裁判协议要求固定 assessmentId、完整风险集合、严格结构化 JSON、受限 evidence 坐标、明确 complete 状态；空响应、额外字段、未知标签、错误 JSON、截断或模型身份变化均为 UNKNOWN，不能成为 SAFE。Judge 决策强制非流式以保证一次性 schema 校验；SSE 流式裁判当前明确不支持，不能伪装成已验证能力。

支持 DeepSeek、GLM、Qwen、Kimi、OpenAI-compatible、custom 和 Ollama；认证支持 Bearer、受安全校验的自定义 API-Key 请求头、以及经批准私有端点的 none。自定义头禁止 Authorization、Host、Cookie、Content-Length、代理/转发类头，密钥值仍从客户/应用范围的 SecretProvider 引用。

## 8. 性能、审计与回滚

报告中的性能仅为本机纯规则引擎、100 请求合成负载，不是容量结论。并发 10/50/100 的 P95 会记录在 JSON；语义模型 P95、缓存命中、熔断恢复、长文本和大词库容量仍需在客户等价测试环境完成。

回滚时只回退本次代码和新增测试资产，重新运行生成器与门禁；不要删除数据库记录或重置整个工作区。Provider 自定义认证可通过将配置恢复为 bearer/none 回滚，旧 secretRef 不应因策略包回滚而删除。词库候选没有被导入或激活，因此无需线上词库回滚。

## 9. 人工验收清单

1. 提供脱敏业务样本并由两名独立标注人复核；冻结摘要、标注指南和争议仲裁记录。
2. 在单客户隔离测试部署中核对页面、API、数据库总数、状态、分页和审计事件。
3. 为客户选择的私有模型执行协议连通、故障注入和数据边界测试，不打印密钥。
4. 根据客户对 WARN 的运营定义设定误报门禁，再评估每风险家族、语言和来源的置信区间。
5. 只有代码、隔离部署、真实模型、客户业务和生产发布五个阶段分别通过，才能形成最终发布结论。
