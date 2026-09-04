# GuardLLM 安全增强 P2 执行记录

> 阶段：P2——敏感词、混淆识别和文本攻击检测增强
> 执行日期：2026-09-05
> 分支：`codex/security-hardening-v1`
> 基线提交：`e13b48c`
> 结论：**P2 内部工程、专项回归和全量覆盖率门禁通过；生产语义模型与正式内容库准入仍按真实条件保持未就绪。**

## 1. 阶段结论

P2 已完成带来源映射的有界多视图规范化、Aho-Corasick 精确词法匹配、受控近似匹配、上下文语义角色降误报、文本攻击分类、受保护上下文泄露检测、灰区 Judge 调用约束、固定对抗数据集评估和合同证据字段扩展。

Guard Engine v2 的所有观测均可同时指向原文偏移和规范化视图偏移，并携带变换链；规范化超出字符数、视图数、分支数、累计字节数、展开率或 CPU 预算时返回稳定的 `RESOURCE_BUDGET_EXCEEDED`，不会无界解码。证据和评估报告不保存原始攻击文本或受保护上下文原文。

## 2. 计划条目完成情况

### P2-01 多视图规范化

- 保留原文，生成带 `sourceViewId`、原文跨度、变换方法、轮次、深度和置信度的确定性视图；算法版本固定为 `guard-normalization-3.0.0`。
- 覆盖 Unicode NFKC、大小写/全半角、零宽与 Bidi 控制符、HTML 实体、URL、Base64、Base32、Hex、Quoted-Printable、ROT13 和转义码。
- 覆盖同形字骨架、数字替字、受控拼音别名、空格/标点切片和跨行重组。
- 解码注册表受轮次、深度、视图、分支、单视图字符、累计字节、展开率和单调时钟 CPU 预算约束。
- 缓存键增加策略 generation、语言区域和规范化算法版本，避免跨版本复用旧结果。

### P2-02 敏感词匹配引擎

- 精确、包含、前缀和后缀规则使用 Aho-Corasick 自动机；10,000 条规则规模用例通过。
- 近似匹配采用受控 Damerau-Levenshtein：模式长度 4–64、编辑距离 1–2、候选数最多 64；不允许无界模糊匹配替代语义判断。
- 结构化正则继续使用 RE2/安全模式约束，并新增 1,048,576 字符输入上限和稳定 `INPUT_TOO_LARGE` 错误。
- 规则命中返回 canonical term、variant、词典层级、词典/规则版本、上下文角色和双偏移证据。
- 五层优先级固定为平台红线、事件应急、应用、租户、行业；`mandatoryDeny` 不可被低层规则或上下文豁免覆盖。

### P2-03 上下文降误报

- 对词法命中分类 `mention`、`quotation`、`news`、`legal`、`research`、`education`、`medical`、`instruction`、`transaction`、`endorsement`、`disclosure` 十一种角色。
- 对引用、新闻、法律、研究、教育和医疗等良性局部语境仅降低允许调整规则的词法信号；全局可操作意图会覆盖局部良性框架。
- 平台 `mandatoryDeny` 仍保持绝对阻断。
- 固定评估集为每个攻击族同时提供风险正例和正常业务反例，并按攻击族分别输出误报与漏报。

### P2-04 注入与文本攻击语义检测

- 覆盖直接/间接注入、角色扮演、权限提升、目标劫持、拒答压制、系统提示词泄露、推理过程泄露、工具滥用和数据外泄意图。
- 增加西班牙语、法语、德语、日语、韩语直接覆盖及跨语言提示词外泄信号。
- 语义分类器采用版本化多标签输出和逐标签阈值；本阶段没有把单一总分作为所有攻击的统一结论。
- Judge 只在数值灰区或本地语义分类结果处于灰区时调用；已阻断、超过阻断阈值、阈值非法或没有真实灰区信号时不调用。
- 受保护上下文使用 HMAC 指纹、canary、shingle、结构签名和离线授权语言变体检测；运行时和证据不回传原始保护内容。
- 默认检测 DAG 升级至 `guard-default-dag-3`；显式携带 `guard-default-dag-2` 的既有已签名策略仍按其声明的检测器集合运行，避免注册表不匹配。

### P2-05 变形与对抗测试

- 对抗变体生成器覆盖 15 类编码、切片、字符替换、同形字、拼音、多语种、标点、大小写、嵌套引用和跨轮组合，风险结论保持一致。
- 128 轮确定性 Unicode fuzz 同时验证输出顺序、来源跨度、边界和无崩溃；覆盖率插桩下保留完整轮数并设置独立 15 秒上限。
- 递归解码、超长输入、分支/累计字节/CPU 预算和 ReDoS 防护均有负向测试。
- 固定数据集绑定 SHA-256，评估输出只包含用例 ID、输入 SHA-256、期望/实际风险、动作和原因码。

## 3. 合同与兼容性

- `Observation` 新增 `canonicalTermId`、`variantId`、`dictionaryLayer` 和 `contextRole`，并同步 TypeScript、Python、Go、Java、OpenAPI 和 Proto 生成物。
- Guard v1 与已接受 JSON Schema 基线保持向后兼容。
- Protobuf `Observation` 原有字段号保持不变：`dictionary_release_id = 8`、`fail_mode = 17`；新增字段使用 18–21，并有源码级防回归断言。
- 旧版 `guard-default-dag-2` 策略包兼容用例通过；新检测器不会被强行注入旧 DAG。

## 4. 自动化验证结果

| 门禁 | 结果 | 关键证据 |
|---|---:|---|
| `pnpm contracts:check` | PASS | Guard v1 source hash `32b8c5030e767e6f7063b464069f01b32b4e5b0c790e55b9384f0c1eff544d8d`；Guard/Appliance 均向后兼容 |
| P2 计划专项命令 | PASS | 29 个测试文件，209/209 |
| P2 定向核心回归 | PASS | 18 个测试文件，165/165 |
| 旧 DAG 与 Proto 定向回归 | PASS | 2 个测试文件，19/19 |
| `pnpm test:coverage --run` | PASS | 136 个测试文件，630/630 |
| Guard Engine v2 覆盖率 | PASS | statements 88.30%；branches 76.99%；functions 95.08%；lines 93.73% |
| `pnpm ts-check` | PASS | 0 个 TypeScript 错误 |
| `pnpm lint:build` | PASS | ESLint `--quiet`，退出码 0 |
| `pnpm security:text-evaluate` | PASS | 24 个固定用例；四个攻击族逐类达标；不落原文 |

P2 计划专项命令为：

```powershell
pnpm test:unit --run tests/guard-engine-v2 tests/detection tests/llm tests/context-trust
```

## 5. 固定文本防护评估

数据集：`guardllm-text-defense-v1`，24 个用例，SHA-256 为 `59f671a81f3d07dace5aea43d090b7e0a66df531c40c88e498305f413f6387ec`。

| 攻击族 | TP | TN | FP | FN | Precision | Recall | FPR | FNR | Accuracy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| confusion | 4 | 2 | 0 | 0 | 1.0 | 1.0 | 0.0 | 0.0 | 1.0 |
| injection | 4 | 2 | 0 | 0 | 1.0 | 1.0 | 0.0 | 0.0 | 1.0 |
| multilingual | 4 | 2 | 0 | 0 | 1.0 | 1.0 | 0.0 | 0.0 | 1.0 |
| prompt_leak | 4 | 2 | 0 | 0 | 1.0 | 1.0 | 0.0 | 0.0 | 1.0 |

这些结果只证明当前固定小样本集通过，不能外推为开放世界零误报或零漏报，也不替代 P6 的隐藏集、置信区间、分层校准和外部验收。

## 6. 关键制品摘要

| 制品 | SHA-256 |
|---|---|
| `data/security-evaluation/text-defense-v1.json` | `59f671a81f3d07dace5aea43d090b7e0a66df531c40c88e498305f413f6387ec` |
| `P2-text-defense-metrics.json` | `adade29b9311cf34a439085bb4aa1d6e5142b240ed4192040b56e7f57a33e911` |
| `normalization.ts` | `a71b2a430ff87800f7733693f7e70d7f79b5ffe1f5eacc9ac6ffc142c9035e68` |
| `lexical-matcher.ts` | `ee2b197e80ca667a5f607bef5e271436490e1e86f39a8bcb5ab06be8d3be82f1` |
| `protected-context.ts` | `29d1d812a8e73892961ded782d17938d20a87759887c39da48b80d32ab842a73` |
| `packages/contracts/model/guard-v1.schema.json` | `32b8c5030e767e6f7063b464069f01b32b4e5b0c790e55b9384f0c1eff544d8d` |

## 7. 真实边界与后续阶段

1. 当前本地语义分类器合同、版本和逐类阈值已具备，但正式生产模型权重、离线签名制品和分层校准尚未配置；不得把基线规则结果表述为生产语义模型已上线。
2. P1 生产词库仍为 0 个正式 ACTIVE/EMERGENCY 条目，未达到不少于 10,000 条、分项规模、来源许可和双人签名审批门槛；门禁保持 fail closed。
3. 受保护上下文检测需要生产环境按租户安全注入 HMAC 指纹；本阶段没有把客户提示词或内部秘密写入仓库。
4. 多轮会话风险状态、资源控制、多模态检测和性能/故障演练在 P3 完成；输出模板、隐私脱敏和流式二次复检在 P4 完成。
5. 24 例固定评估是工程回归集，不是 2,000 题正式验收集，也不是独立隐藏集；外部附件验收与生产准入继续保持真实阻塞。

## 8. 阶段判定

P2 的代码、合同、兼容性、专项回归、固定评估、类型、静态检查和全量覆盖率门禁全部通过，可以进入 P3。生产词库、生产语义模型和外部验收条件未被伪造、跳过或错误宣称完成。
