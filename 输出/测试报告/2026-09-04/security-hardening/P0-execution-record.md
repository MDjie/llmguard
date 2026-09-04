# GuardLLM 安全增强 P0 执行记录

- 状态：完成（本地开发部署与自动化门禁）；正式审批和客户验收不在本阶段声称范围内
- 基线提交：`69639dc`
- 工作分支：`codex/security-hardening-v1`
- 完成提交：本文件所在的 P0 阶段提交；最终汇总报告记录其不可变哈希
- 执行日期：2026-09-04

## 完成范围

1. 建立 Ed25519 公私钥职责分离：运行容器仅挂载公钥和 Key ID，私钥只进入显式本地签名流程。
2. 新增空库可用、事务锁保护、内容感知且幂等的默认策略引导；策略变化会生成新版本并审计退役旧版本。
3. 严格校验 Bundle 状态、算法、Key ID、Schema、签名、策略一致性和应用绑定；短时数据库故障只允许在 TTL 内使用已验签 LKG。
4. 新增独立 policy readiness；容器 readiness 与 process liveness 分离。
5. 修复 `policy_dimension_config.created_at` 初始化/迁移漂移，并为特殊重复字符规则增加确定性线性匹配器。
6. 修复只读容器 Next 缓存写入面，仅为 `/app/.next/cache` 和 `/tmp` 提供受限 tmpfs。
7. 增加通用内容意图检测、教育/防御语境抑制和旧版风险维度映射，关闭附件 32 条在线用例中的实际能力缺口。

## 关键设计决定

- 本地引导产物固定标记 `operator-attested-development-only`、`externalApproval=false`，不冒充正式审批。
- 策略 DAG 是签名 payload 的一部分；新增检测节点通过 `guard-default-dag-2` 和新 Bundle generation 生效，不在运行时绕过签名内容。
- 防御语境只影响允许调整的上下文型普通规则；`mandatoryDeny`、PII、凭证和业务秘密规则不因该语境跳过。
- 证据默认只保存掩码预览、HMAC、偏移、版本和动作；在线附件报告只记录输入 SHA-256。

## 自动化测试

| 命令/检查 | 结果 |
|---|---|
| 基线 `pnpm validate` | 117 个测试文件、495/495 通过 |
| 策略、API、部署定向测试 | 11 个文件、36/36 通过 |
| Schema/部署兼容测试 | 2 个文件、12/12 通过 |
| 安全正则、动态规则、策略回归 | 11 个文件、31/31 通过 |
| 内容意图、上下文、兼容映射及策略引导 | 5 个文件、46/46 通过 |
| 内容意图与既有内置检测器最终回归 | 2 个文件、34/34 通过 |
| P0 规定的策略包/无策略/路由门禁 | 10 个文件、24/24 通过 |
| `pnpm contracts:check` | 通过；Guard v1 与 Appliance v1 均向后兼容 |
| `pnpm ts-check` / `pnpm lint:build` | 全仓通过 |
| 合并工作区最终 `pnpm validate` | 128 个测试文件、548/548 通过；包含尚未提交的 P1 词库测试，合同、计划、TypeScript、ESLint 全部通过 |
| P0 暂存树隔离门禁 | 合同、计划、TypeScript、ESLint 全部通过；127 个测试文件、539/539 通过 |

## 部署与运行态证据

- Compose 项目：`guardllm-r0`
- 运行服务：App、PostgreSQL、媒体分析器及 10 个 Worker，共 13 个服务全部运行；App/PostgreSQL/媒体分析器健康。
- 当前签名策略：generation 3、policy version 3、DAG `guard-default-dag-2`、16 个维度、81 条规则、16 个阈值。
- 幂等复核：在补齐后续 P1 的 `0037` 加法迁移后再次执行引导，复用同一 Bundle `b79d16b5-4581-4364-88fa-e85fb50f4af4`、generation 3，未生成重复版本。
- readiness：HTTP 200、`ready=true`，应用绑定、Ed25519、Key ID 和公钥摘要校验通过。
- 密钥边界：App 与 10 个 Worker 均无私钥环境变量；公钥挂载只读。
- 文件系统：App 根文件系统只读；`/app/.next/cache` 可写且容量受限。
- 日志：部署后未发现策略加载异常、缓存 `ENOENT`、fatal/error/exception 或私钥泄露迹象。

## 附件在线回归

- 结果文件：`输出/测试报告/2026-09-04/runtime-api-results.json`
- 选定用例：32
- HTTP 200：32/32
- 断言通过：32/32
- 匿名边界：HTTP 401 `AUTHENTICATION_REQUIRED`
- 账号处理：每次运行使用随机高强度一次性本地账号，结束后删除用户及租户成员关系；报告不保存密码或 Cookie。

## 迁移与回滚

- 增量迁移：`drizzle/0036_policy_dimension_config_created_at.sql`；可重复执行，先补列、回填、再设置默认值与非空约束。
- 策略回滚：使用生命周期 rollback 恢复 `previousBundleId`，generation 前进并写入 `rollback_restore` 审计；不得修改旧 Bundle。
- 代码回滚：回退 P0 阶段提交并恢复前一镜像；数据库新增列可保留，旧应用兼容。

## 遗留与边界

- 正式生产签名仍需独立审批人及 KMS/HSM/受控 Secret；本地密钥不是生产凭据。
- 客户 2K+2K 盲测、目标国产硬件、客户数据库、30 分钟目标拓扑压测和独立 QA 签名仍为外部前置条件。
- 独立词库任务已停在稳定检查点；其白名单与候选词影子改动将在 P1/P2 审阅整合，不冒充 P0 完成范围。

下一阶段准入结论：允许。P0 产品链路、本地运行态与全仓门禁均已通过，可进入 P1。
