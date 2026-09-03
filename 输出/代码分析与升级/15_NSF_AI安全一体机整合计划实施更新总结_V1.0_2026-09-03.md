# NSF AI 安全一体机整合计划实施更新总结

> 文档版本：V1.0
> 编制日期：2026-09-03
> 代码基线：`main@96cb4d5`
> 对应实施计划：`11`、`12`、`13`、`14`
> 适用范围：GuardLLM Version A 软件网关及 Version B 一体机前置契约

## 1. 更新概述

本次更新按照三份优化计划的统一实施方案，完成了 UWP-00 至 UWP-12
在当前仓库内能够独立落地的代码、契约、数据库、部署和验收治理工作。
功能基线提交为：

```text
96cb4d5d2f6560ad935921ca858921b736896671
✨ feat(security): 落地 NSF 安全一体机整合计划
```

该提交共涉及 184 个文件，新增 15,744 行、删除 346 行。更新重点从
“单点检测能力”转向“统一决策、可信上下文、资源治理、Agent 行为控制、
供应链准入、可验证证据和可运维交付”的完整软件安全基线。

本次可以准确确认：

1. Version A 软件网关的核心安全控制面已形成仓库代码基线。
2. Guard V2、RAG、Tool/Agent、DLP、资源控制和审计采用统一策略与证据语义。
3. 新增能力已进入自动化测试、生产构建、部署配置和运行手册。
4. 外部模型、扫描器、TONE、数据库、硬件和目标性能仍须独立验收。
5. 当前结果不能等同于完整网络安全一体机已经完成现场交付。

## 2. 实施状态总览

| 状态 | 工作包 | 当前结论 |
| --- | --- | --- |
| `IN_PROGRESS_EXTERNAL` | UWP-00 | 仓库治理清单已完成，目标环境、盲测数据、供应商许可和具名责任人待冻结 |
| `CODE_IMPLEMENTED_ACCEPTANCE_PENDING` | UWP-01 至 UWP-07、UWP-09、UWP-11 | 代码与自动化基线已完成，仍需目标环境和外部系统验收 |
| `PARTIAL_BASELINE` | UWP-08、UWP-10 | 多模态及供应链已有控制基线，真实分析器与第三方制品尚未准入 |
| `BLOCKED_EXTERNAL` | UWP-12 | Version B 网络数据面依赖商业范围、硬件、实网和技术路线决策 |

五类产品级声明继续保持未批准状态：

1. 99% 检测效果声明。
2. 毫秒级端到端性能声明。
3. 128K 全量安全检测声明。
4. 信创或国产化平台全面兼容声明。
5. 完整网络安全一体机能力声明。

这些声明只有在目标环境测试、原始证据固化和责任人签字后才能变更。

## 3. 核心能力更新

### 3.1 Guard V2 统一检测主链

新增签名策略包驱动的检测 DAG，支持：

- 并行与条件节点执行。
- 节点级超时、有限重试和成本预算。
- 失败关闭、受控降级和 Shadow/Enforce 模式。
- 聚合决策、节点观测和统一错误语义。
- 旧 `/api/detect` 到 Guard V2 的兼容转换。

新增生产语义分类器适配器，强制绑定 detector、模型、版本、权重摘要、
量化方式、标签覆盖率和校准参数。服务响应必须与请求中的模型身份、
输入视图和内容摘要一致，Enforce 模式下异常默认失败关闭。

主要实现：

- `src/lib/guard-engine-v2/dag.ts`
- `src/lib/guard-engine-v2/default-dag.ts`
- `src/lib/guard-engine-v2/semantic-classifier.ts`
- `src/lib/detection/v2-compat.ts`
- `services/guard-gateway/src/main/java/com/guardllm/gateway/StreamingCommitGate.java`

### 3.2 可信上下文与跨协议契约

建立统一上下文信封、派生信封、动作意图和外部事件校验机制：

- 绑定租户、应用、用户、会话、策略、模型和 Trace 身份。
- 派生上下文保留来源关系和完整性证据。
- 外部事件使用 HMAC、作用域校验、过期窗口和防重放声明。
- TypeScript、Java、Python、Go、OpenAPI 和 protobuf 共用 Guard v1 契约。
- 兼容性检查阻止无版本升级的破坏性协议变化。

主要实现位于 `src/lib/context-trust/` 和 `packages/contracts/`。

### 3.3 精确 Token 与资源准入

生产 Guard 路径新增签名资源准入配置和 PostgreSQL 配额账本：

- 精确 Tokenizer 响应必须匹配模型、Tokenizer、版本、摘要和内容摘要。
- 覆盖租户、应用、用户、显式用户组、凭据、模型和 API 七类身份范围。
- 覆盖 RPM、输入 TPM、输出 TPM、并发、日成本和月成本六类指标。
- 形成 7 个身份范围乘 6 个指标窗口的 42 项强制配置覆盖。
- 请求 Charge 幂等，同一请求并发重放被拒绝。
- 并发租约在请求结束后释放，并支持故障 TTL 回收。
- 复杂度估算、三级公平调度和签名模型路由共同限制资源消耗。

主要实现：

- `src/lib/tokenization/`
- `src/lib/resource-control/admission-config.ts`
- `src/lib/resource-control/admission.ts`
- `src/lib/resource-control/quota-store.ts`
- `src/app/api/v1/guard/evaluate/route.ts`

### 3.4 安全内存与会话风险

新增分层安全内存和不可变风险账本：

- 会话事件分段加密保存。
- Provenance、敏感标签和风险状态随上下文传播。
- 策略、模型和 Tokenizer 变化进入缓存隔离键。
- 租户与应用作用域在存储和读取两端同时约束。
- 数据层迁移提供约束、索引和追加式记录结构。

主要实现位于 `src/lib/secure-memory/`，数据库结构见迁移 `0028`。

### 3.5 RAG 全链路安全

RAG 流程从单次检索检查扩展为摄取、检索、组装和输出全链路控制：

- 文档来源、版本、摘要和租户 ACL 校验。
- 检索结果按主体权限和来源能力过滤。
- 上下文组装保留引用与证据绑定。
- 输出阶段执行 Groundedness 和策略门禁。
- 摄取 Worker 与在线 Guard 使用一致的来源语义。

主要实现：

- `src/lib/rag/flow.ts`
- `src/lib/rag/provenance.ts`
- `src/lib/rag/groundedness.ts`
- `src/lib/rag/ingest-worker.ts`

### 3.6 Agent 与 Tool Action Firewall

所有具有副作用的 Tool/MCP 调用进入统一授权状态机：

- 校验结构化动作意图和参数摘要。
- 检查工具、资源、网络、文件、命令和凭据能力。
- 高风险动作要求人工批准。
- 使用一次性 Permit，绑定调用主体、目标和有效期。
- 工具执行结果重新进入 Guard 检测。
- 旧的未准入工具记录默认拒绝执行。

主要实现位于 `src/lib/tools/` 和迁移 `0029`、`0032`。

### 3.7 DLP、隐私和效果指标

新增确定性规则、校验器和实体融合机制，并形成逐分类效果指标：

- 多检测器实体结果按位置、类别和证据融合。
- 支持 Precision、Recall、FPR、FNR 和 F1。
- 评测 Attempt 不可变，首轮结果与数据集摘要绑定。
- 差分隐私与受保护计算采用准入门禁，缺少威胁模型、参数和硬件证据时
  不允许标记为启用。

主要实现：

- `src/lib/dlp/entity-fusion.ts`
- `src/lib/evaluation/classification-metrics.ts`
- `docs/security/privacy-computing-admission-gate.md`

### 3.8 多模态安全

补充文件准入、音视频采样和检测前约束：

- 文件大小、类型、摘要和处理预算验证。
- 音频、视频时间线融合与边界采样。
- 多策略抽帧共享最大帧数预算。
- 文档、图像、音频和视频进入 Guard 前保留制品证据。

当前属于控制和适配基线，真实 OCR、ASR、VLM、AV、Office 与压缩包分析器
仍须完成制品准入和目标数据集验证。

### 3.9 统一安全扫描与供应链治理

新增主机、Web 和模型供应链扫描控制面：

- 扫描目标必须先登记为租户激活资产，API 不接受任意 URL。
- 扫描器定义固定版本、代码摘要、许可证、NOTICE、权限和网络边界。
- 扫描器制品与定义摘要双向绑定，并通过 Ed25519 验证。
- 异步任务支持抢占、心跳、有限重试和取消。
- Attempt 不可变，Finding 按指纹去重。
- 提交者不能复核自己的结果；仲裁要求两个独立前置复核人。

新增接口：

| 接口 | 用途 |
| --- | --- |
| `POST/GET /api/security-scan-assets` | 登记和查询租户扫描资产 |
| `POST/GET /api/security-scans` | 提交和查询扫描任务 |
| `GET /api/security-scans/{id}` | 查询任务、Attempt、Finding 和复核 |
| `POST /api/security-scan-findings/{id}/reviews` | 提交独立复核或仲裁 |

新增 Worker：`pnpm security-scan:worker`。

### 3.10 四域事件、TONE 与发布治理

建立审计、运行、网络安全和模型安全四域事件模型：

- 统一网络、模型、策略、检测器、Trace、动作和证据摘要字段。
- 原始敏感内容不进入统一事件。
- MAC 地址只允许在 L2 透明采集场景记录。
- 数据库按月分区，并使用触发器阻止事件更新。
- 自动预建当前月和下一月分区。

新增 TONE 出站连接器：

- 强制 HTTPS 和出站主机白名单。
- 使用 HMAC-SHA256 签名和审计事件 ID 幂等键。
- 校验 TONE 回执中的 `accepted` 和 `eventId`。
- 失败进入 Outbox 重试，终态失败保留并触发告警。

Helm 新增 `audit-export` 和 `security-scan` Worker 工作负载。

### 3.11 一体机 PAL/HAL 边界

为 Version B 提供可验证的网络和硬件抽象契约：

- PAL 约束协议解码后、转发前必须完成检测。
- 检测失败默认阻断。
- 只有未保护流量可凭限时、限定范围、双人批准的签名 Permit 旁路。
- HAL 对 CPU、加速器、内存、磁盘、RAID、NIC、温度、电源、模型实例和
  队列生成健康、降级与摘除决定。

PAL/HAL 是一体机集成边界，不代表透明转发、IPS、AV、DoS 或目标硬件已经
交付。

## 4. 数据库更新

本次新增迁移 `0028` 至 `0035`：

| 迁移 | 内容 |
| --- | --- |
| `0028_secure_memory_layers` | 安全内存、会话事件和风险账本 |
| `0029_action_firewall` | Agent/Tool 动作授权和一次性 Permit |
| `0030_guard_resource_control` | 资源策略与调度控制 |
| `0031_immutable_evaluation_attempts` | 不可变评测 Attempt |
| `0032_tool_supply_chain_admission` | Tool/MCP 供应链准入 |
| `0033_operational_security_domains` | 四域安全事件、月分区和不可变约束 |
| `0034_security_scanning` | 资产、扫描任务、Attempt、Finding 和复核 |
| `0035_guard_quota_ledger` | 策略版本化配额计数器和幂等 Charge |

迁移必须在生产规模的 PostgreSQL 恢复副本上按编号执行。未完成约束、
触发器、查询计划、并发一致性和回滚验证前，不得直接切换生产流量。

## 5. 配置与部署更新

新增或强化以下关键配置：

| 配置 | 作用 |
| --- | --- |
| `SEMANTIC_CLASSIFIER_CONFIG_JSON` | 编译进入签名策略包的语义分类器配置 |
| `GUARD_RESOURCE_ADMISSION_CONFIG_JSON` | 编译进入签名策略包的资源准入配置 |
| `SUPPLY_CHAIN_TRUSTED_PUBLIC_KEYS_JSON` | 供应链制品 Ed25519 公钥 |
| `SECURITY_SCANNER_DEFINITIONS_JSON` | 固定版本并签名的扫描器目录 |
| `AUDIT_EXPORT_TONE_BASE_URL` | TONE HTTPS 服务地址 |
| `AUDIT_EXPORT_TONE_PATH` | TONE 事件接收路径 |
| `AUDIT_EXPORT_TONE_KEY_ID` | TONE 签名密钥标识 |
| `AUDIT_EXPORT_TONE_HMAC_KEY` | 至少 32 字节的 TONE HMAC 密钥 |

密钥与私钥必须由运行环境 Secret 提供，不能写入 Helm values 或仓库。
私有服务 DNS 只有在服务网格身份边界内并显式进入出站白名单后才能使用。

完整上线与回滚步骤见：

- `docs/runbooks/nsf-plan-runtime-integration.md`
- `deploy/README.md`
- `deploy/helm/guardllm/values.yaml`

## 6. 验证结果

截至 2026-09-03，仓库验证结果如下：

| 验证项 | 结果 |
| --- | --- |
| `pnpm plan:check` | 通过；13 个工作包有效，5 项声明未批准，目标环境为 `BLOCKED_EXTERNAL` |
| `pnpm contracts:check` | 通过；生成制品无漂移，Guard v1 对基线向后兼容 |
| `pnpm ts-check` | 通过；TypeScript 错误为 0 |
| `pnpm lint:build` | 通过；ESLint 错误为 0 |
| `pnpm lint` | 通过；0 错误，仓库仍有 84 个基线警告，本次新增模块警告已清理 |
| `pnpm quality:ratchet` | 通过；未突破 TypeScript/ESLint 质量基线 |
| `pnpm test:unit --run` | 通过；100 个测试文件、396 项测试 |
| 相关安全模块回归 | 通过；8 个测试文件、28 项测试 |
| `pnpm build` | 通过；Next.js 16.3.3，生成 80 个页面/路由 |
| `pnpm test:sdk-python` | 通过；3 项测试 |
| 暂存差异与密钥检查 | 通过；无补丁错误，高置信度密钥模式 0 命中 |

未计为通过的项目：

- Go SDK：本机没有 Go 工具链。
- Java StreamingCommitGate：本机没有 JDK 21 和 Maven。
- PostgreSQL 集成测试：未提供隔离的 `INTEGRATION_DATABASE_URL`。

## 7. 尚需外部关闭的事项

以下工作不能通过继续编写仓库代码完成：

1. 冻结目标模型、Tokenizer、量化制品、硬件和镜像摘要。
2. 获取 4,000 条客户盲测数据、独立标注和效果复核签字。
3. 完成两种目标 Tokenizer 的 131,072 Token 首部、中部、尾部、跨轮、
   跨语言和缓存失效测试。
4. 完成单节点、集群、3,000 会话、300 控制台用户和 72 小时长稳测试。
5. 在目标 PostgreSQL 执行 `0028` 至 `0035`，验证并发配额和故障恢复。
6. 在 Java 21/Maven 环境验证 SSE、WebSocket、gRPC 和流式泄漏边界。
7. 接入真实主机、Web、模型扫描器及其授权、规则库和客户资产。
8. 完成 TONE/SOC/SIEM 双向联调和客户正式回调状态机。
9. 完成 KMS/HSM、OCR、ASR、VLM、AV、Office 与压缩包分析器 POC。
10. 完成信创实机、故障注入、双机灾备和备份恢复验收。
11. 批准 Version B 后完成 OEM/eBPF/XDP/DPDK 选型、PCAP、洪泛、回注、
    旁路、故障和线速测试。

## 8. 推荐上线顺序

1. 冻结 `scope-manifest`、`target-environment`、第三方制品和责任人。
2. 在隔离环境执行数据库迁移、约束和并发一致性验证。
3. 生成并签署包含语义模型和资源准入配置的新策略包。
4. 启动 Guard V2 Shadow，固化模型、策略、Tokenizer、数据集和环境摘要。
5. 接入真实扫描器与 TONE 测试端，验证签名、幂等、重试和终态告警。
6. 执行盲测、128K、配额隔离、流式泄漏、容量和故障注入。
7. 只有签名证据满足冻结门禁后，才从 Shadow 进入 Canary。
8. Canary 达标后逐步扩大流量；任何 P99、漏检、审计终态失败或必需
   Detector 异常均触发回滚。

## 9. 回滚原则

- 恢复上一份已签名策略包，原子恢复检测器、模型、Tokenizer 和资源策略。
- 停止扫描或 TONE Worker 只阻止新外部调用，不删除已有审计和任务证据。
- 数据库新增结构以应用回滚优先，不在紧急回滚中直接删除新表。
- 保留扫描 Attempt、Finding、Review、四域事件和 Outbox 终态记录。
- 所有重新上线必须生成新的制品与环境证据指纹。

## 10. 结论

本次更新已经完成三份优化计划在仓库内可实现部分的整合落地，使产品具备
面向 Version A 软件网关的统一安全控制、证据治理和可运维基线。其核心价值
不是增加孤立功能数量，而是将检测、上下文、资源、Agent、RAG、供应链、
扫描、审计和发布纳入同一套可签名、可追踪、可回滚的安全边界。

当前最准确的交付表述是：

> UWP-00 至 UWP-12 的仓库代码基线已完成分段实现，并通过现有
> TypeScript、Node.js 和 Python 自动化验证；目标性能、外部系统、
> 信创硬件和 Version B 网络数据面仍待签名验收。

在第 7 节外部事项全部关闭前，不应将本次更新宣传为已经达到 99% 检测率、
毫秒级性能、完整 128K 覆盖或完整网络安全一体机现场交付。
