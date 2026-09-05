# 检测优化 V2：工程交付与单客户部署手册

日期：2026-09-05。对应原 24 号方案与同名任务 JSON，不另起一套设计。用户已授权本地开发、测试、提交和推送；未执行客户生产迁移或策略激活。

## 1. 交付边界

一套部署服务一个客户；沿用已有应用级权限及数据隔离，不建设跨客户运营平台。核心实现、控制台、隔离评测、迁移回滚工具已交付。Q01 的真实业务质量验收、O01 的客户发布与观察不属于“代码通过测试”可以替代的工作。

本次实际模型为本机 Ollama 的 `qwen3.5:9b`，只发送本地合成样例。DeepSeek、GLM、Qwen、Kimi、Ollama、OpenAI-compatible、custom 等适配预设做了离线协议测试；没有把离线测试描述为这些供应商全部型号的真实验收。

## 2. 产品主路径

1. 保留规范化、权限、DLP、强制红线与原文证据。普通词命中在决策 V2 中是候选，不直接等同于语义违规。
2. 新签名包显式启用 `semanticDecisionMode: coverage-v1` 并声明 `semanticCoverage.requiredRiskIds`。旧签名包没有此字段，保持旧逻辑，不在加载时偷偷升级。
3. 一个已取得对应范围资格的基础裁判或显式语义分类器即可满足覆盖；零词命中仍执行必要语义检测。基础已覆盖时，不再无条件重复调用复核模型。
4. 复核只处理缺口或冲突，共享基础阶段截止时间。SHADOW、未知、失败、缺标签、截断和未覆盖模态不能当 SAFE。已确认风险与强制拒绝不会被随后 SAFE 消除。
5. 会话合并历史与当前文本，只执行一次完整新请求评估。加密回执先于重复配额扣减，重放不重复推理/记账；冲突回滚和只读影子快照保留。
6. 长文重叠分窗保留 UTF-16 原文坐标、尾部、emoji 边界。`contextScope: full` 不把若干局部 SAFE 拼成全文安全；只有另经资格评估的 window 配置才允许对应分窗覆盖。
7. 输出脱敏/改写在投影回当前请求之后执行，历史不得成为释放文本。失败复检继续阻断。

## 3. 私有模型如何配置

先在“模型管理”保存服务地址与密钥，再在策略“裁判模型”中添加场景：

| 设置 | 作用及边界 |
| --- | --- |
| providerType / modelId / modelRevision | 品牌预设不限制私有模型名称；固定模型身份、可变别名与权重摘要分别记录 |
| baseUrl / path / backendKind | 支持兼容 Chat 接口，或使用 guard v2 JSON 的分类服务；非兼容任意 REST 必须经客户适配网关转换，不能声称填 URL 即可兼容 |
| deploymentMode / dataBoundaryPolicyId | 部署属性独立于品牌；Ollama 不天然可信，私有地址必须经管理员登记 |
| authMode / secretRef | Bearer 安全密钥引用；无认证仅限已批准私有端点。当前不直接存储任意认证头或客户端私钥 |
| role | base 基础、refiner 条件复核、grounding 引用事实核验 |
| directions / industries / locales / priority | 一个客户不同业务应用、方向、行业与语言的路由；主备范围必须兼容 |
| maxConcurrent / maxAttempts / perAttemptTimeoutMs / totalTimeoutMs | 并发、有限主备尝试、单次和共享总预算 |
| contextScope / windowing | 全文或分窗资格、窗口数量与重叠，不静默截断 |
| structuredOutputMode | `json_schema` 原生约束、`json_object`、`strict_text_json`。必须按实际端点能力选择，不支持时失败，不自动放宽解析 |
| qualityEvidenceId / qualityValidUntil | 只填写名称不会取得资格；须匹配部署管理员批准目录中的配置摘要、数据集与独立审核证据 |

私有客户使用 mTLS、API-key 自定义头、复杂网关签名时，将凭据和身份交换配置在客户批准的反向代理/服务网格中，向本产品暴露支持的接口；不得关闭 TLS 验证或把密钥放进 URL、策略 JSON、日志。企业 CA 使用经审核的容器信任库/证书挂载方案；本次不替客户自动部署证书。

部署环境需配置最小化 `PROVIDER_ALLOWED_HOSTS` / `PROVIDER_ALLOWED_PRIVATE_HOSTS`。`JUDGE_PRIVATE_ENDPOINT_APPROVALS_JSON` 必须逐条绑定应用、完整地址和数据边界；`JUDGE_QUALITY_APPROVALS_JSON`、`SEMANTIC_CLASSIFIER_QUALITY_APPROVALS_JSON`、`MULTIMODAL_QUALITY_APPROVALS_JSON` 默认为空，已在 compose 显式透传。上述目录由部署管理员维护，不是普通 HTTP 请求可写的参数。private-only 失败不能切到云端备用。

协议依据：[Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)、[Ollama 结构化输出](https://docs.ollama.com/capabilities/structured-outputs)。本地已实测 `json_schema`；原生约束不替代风险判断质量、完整标签、证据坐标和回包身份校验。

## 4. 词库与审核

词库仍是独立数据文件和带来源的 release-set，不散落进检测代码。输入清单为 `data/content-safety/sources/conversion-sources.v2.json`。转换器读取原始 JSONL/受限 SQL 字符串，绝不执行历史 SQL。

本次 3 个源共 11,713 条数据记录，另有 49 条元数据；797 条解析可用候选、990 条重复、9,914 条隔离候选、12 条拒绝，合计守恒。跨风险标签保留；规范化独立术语 9,561 个不等于可上线术语数。797 条也仍需审核和许可，不能自动发布。13 组历史声明数与可见数组数量不一致，保留对账，不补造缺失内容，也不将所有差额武断认定为新丢词。

双人 Ed25519 签名绑定候选正文、来源、授权用途、映射后的发布词条以及审核链。更改词条、许可或来源后必须重新审核。模型生成、模型自审、同一密钥伪装两个身份、未授权源均不能发布。分歧需要第三方裁决；已裁决链封存。

```powershell
pnpm lexicon:convert-reviewed --help
pnpm detection:dataset-prepare --help
pnpm detection:assist-candidates --help
pnpm lexicon:compile-release-set --help
```

工作台操作见 `docs/detection-v2-workbench.md`。词库集合的整组导入、审核、影子、灰度、激活、准确回滚沿用事务状态机；集合“激活”仅选择编译来源，不会自行更改实时应用绑定。白名单只豁免已批准的规则/风险/方向/时效范围，不能豁免其他风险、强制 DLP 或权限。

## 5. 模型辅助与可复现评测

模型辅助工具覆盖候选整理、正反例/有限改写、预标注和关联 trace 的错误归因。生成物是待审核建议，不执行其代码/SQL，不自动修改发布状态。预算同时约束调用、保守字节/输出 token 预留与墙钟；该预留不是价格承诺或供应商 tokenizer 的精确值。

控制台“候选隔离评测”是需测试权限、CSRF、限流、版本 CAS 和审计的专用管理入口，最多 4 条；默认禁止候选数据外发。不能用公共检测请求开启测试绕过。

```powershell
pnpm detection:judge-selftest --help
pnpm detection:evaluate-candidate --help
pnpm detection:eval-compare --help
pnpm detection:evaluation-report --help
pnpm detection:quality-gate --help
```

`detection:eval-compare` 读取固定 baseline/candidate payload、案例、scope 和预算，显式 `--allow-network`。输出 first/warm/concurrent 的 B0、B1、S1、H1、逐例 trace、摘要、时延、缺证/未知分母和配对比较：

- B0 使用提供的实际基线包；本次摘要与业务库实际 active 一致。
- B1 对候选规则与局部例外运行确定性对照，移除语义分支。
- S1 移除普通词库和条件复核，保留强制规则与固定安全控制。
- H1 运行混合链路；基础/复核通过同一生产规则、DAG、规范化、融合、证据和输出控制组件。

模拟晋级仅限 `src/lib/evaluation/isolated-policy.ts` 内部；对外模型请求强制 SHADOW，产物为 `isolated-policy-simulation` / `productionEligible:false`，不返回可绑定引擎或签名包，不伪造生产质量批准。旧独立 classifier 暂不由此候选适配器模拟：显式拒绝，须走其独立批准评测，不会静默跳过。

first 只表示首个观测请求，不证明模型权重冷启动；工具不会擅自卸载用户本地模型。真正冷启动需客户专用实例和批准窗口。真实效果需独立 effect oracle，当前无此证据的逐例效果均 UNKNOWN，不从模型标签推导工具实际执行或业务安全效果。

本次原 JSON Object 对照出现格式/坐标失败，全部保留；随后采用可配置 JSON Schema 做了独立新运行。不能只选后一次成功样例作为质量达标证据。2 条合成文本的重复运行不是独立业务金标，不能推出准确率提升比例、低误杀承诺或高分位 SLO。

分层指标包含风险识别、误干预、UNKNOWN、审核、缺证与实际效果状态；组级 bootstrap 保留同源变体，零分母为 null。原质量门禁计算器仅检查数值，并非发布资格。新客户验收画像草稿在 `data/content-safety/acceptance/customer-profile.proposed.v2.json`，尚未批准，无默认宽松阈值。

## 6. RAG、工具与流式/多模态

RAG 继续先验证 ACL、签名、摘要、版本、时效和引用来源。coverage-v1 下事实核验使用 grounding 角色对输出与有效引用做语义对照；缺来源或模型资格返回无法核验。词面重叠仅保留作辅助展示。保密 classification 标签向私有边界传播，不能送云；工具授权仍依赖已有服务端许可，模型不拥有实际执行权限。

流式 Node 适配器为 `gatePolicySseStream`：默认完整缓冲，只有 window 基础画像取得完整风险覆盖资格才可申请增量释放。已输出内容不能事后撤回。空覆盖、缺终止、解析超限、检查超时、上游停滞、取消、工具调用/未知结构化事件均不当安全放行。Java 网关保持原有缓冲门；普通 evaluate API 不提供未认证的真流式绕行。

图像/PDF 检查实际页数和帧数，禁止把超页尾部、动画首帧、丢失 OCR 或解析失败表示完整安全。音视频现有 ASR/采样只能给 SAMPLED/INCOMPLETE；新模式下至少审核，已知风险仍阻断。尚无客户批准的全模态模型与效果数据，所以没有将音视频标为已证明全面安全。多模态 COMPLETE 还需与制品摘要、分析器版本、期望/实际处理单元及操作员批准目录一致。

## 7. 安全发布与回滚

1. 客户确认用途、模态、风险集合、事实源、认证方式及禁止外发边界，批准验收画像。
2. 收集授权真实数据，独立双审/裁决并锁定测试集。模型/词库/阈值校准用 development/calibration，不能反复调整 locked test。
3. 对实际主模型及每个 ENFORCE 备用、方向、语言和客户启用的 X01/X02 范围验证质量和容量；冻结配置与权重/别名漂移策略。质检证据不满足则不发布 ENFORCE。
4. 获得生产窗口和发布授权后备份数据库、现有应用绑定、bundle 摘要、字典集合、部署镜像和密钥版本。运行已演练的增量迁移 0042/0043；本次仅在 `guardllm_integration_v2_20260905` 演练。
5. 通过既有审核发布流程编译、签名和验证包；依次执行 shadow/canary/active，并记录真实请求 trace 对应的 bundle ID/hash/generation。
6. 监控未知率、缺覆盖、队列/端点超时、主备调用、误干预、审核积压、CPU/GPU/显存和耗时分层。触及已批准门限停止放量，回到精确 previous bundle/集合；不得删卷重建，不删除审计或回执来掩盖事故。
7. 密钥轮转先建立新 secretRef 与镜像/运行时版本，重测候选、编译签名新包并按授权切换；待所有旧包退出后按客户保留策略撤销旧引用。不要在旧签名制品下悄悄换模型或行为配置。

## 8. 复现与证据

证据根目录：`data/content-safety/reports/optimization/v2-development-2026-09-05/`。`engineering-summary.json` 与原任务清单是当前状态索引。大型原始转换结果只保留本地，仓库保存其对账、摘要与复现命令，避免重复传播待许可候选原文。

最终全量单测 897/897 通过，另有隔离数据库 26 项断言（含真实签名包切换/准确回滚/篡改拒绝）、浏览器 6 项、Python SDK 3 项、Java SDK 3 项、Java 网关 28 项以及 Go SDK 测试通过。全量 lint 为 0 error、98 warnings，随后清理了本轮相关的 11 条未使用变量警告并通过定向 lint；保留其他旧警告。签名包测试使用明确标识的合成 canary 状态夹具，不代表客户模型已通过质量门禁。

```powershell
pnpm contracts:check
pnpm test:unit --run
pnpm test:sdk-python
pnpm test:sdk-go
pnpm test:sdk-java
pnpm test:gateway-java
pnpm lint
pnpm ts-check
pnpm build
pnpm analyzer:build
pnpm production-surface:verify
pnpm plan:check
```

`ts-check` 与 `build` 必须顺序运行。浏览器独立测试启动真实 localhost 服务，仅连接名称受限的测试库，并在结束时清理自己启动的服务树；截图已保存，当前环境图片预览工具失败，因此不宣称另有人工逐像素审核。没有执行 `generate:docs`，因为项目未定义该命令；交付文档已在本次补齐。

外部待验收：真实独立金标、批准指标、各客户主备/模态模型、领域事实源、冷启动/长稳压力窗口、生产发布窗口和观察期。以上保留为 Q01/O01 及相关 X 质量状态，不以“全部开发完成”偷换“全部业务验收完成”。
