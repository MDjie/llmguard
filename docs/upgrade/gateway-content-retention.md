# 网关原文保留与清理

升级新增的请求上下文和步骤决定中含有加密原文，原有对账任务采用 1 小时/24 小时的直接清空方式，现统一增加保留锁定和删除证明。0055 扩展迁移新增保留锁定、版本、清理时间与删除证明引用；不删除请求、策略、决定摘要及执行事件。

`scripts/gateway-content-purge.ts` 每次最多领取同一应用的 100 个请求，使用 `GATEWAY_CONTENT_RETENTION_HOURS`（默认 1 小时），并以 `RAW_CONTENT_RETENTION_DAYS`（默认 7 天）作为更长保留配置的上限；有有效保留锁定时不清理。请求对账 worker 同样调用该流程，旧的直接清空分支已移除。只有终态、会话已完成提交、请求截止时间已超过保留期、没有 RUNNING 步骤且没有有效保留锁定的请求才可领取。并发进程使用行锁与 SKIP LOCKED。

```powershell
pnpm exec tsx scripts/gateway-content-purge.ts
```

进程使用独立 `DELETION_PROOF_HMAC_KEY`/`DELETION_PROOF_HMAC_KEY_ID` 和已有审计链密钥。清理 `gateway_requests.session_snapshot` 与 `gateway_steps.decision_envelope`，在同一事务保存删除清单、签名、请求墓碑与审计事件。审计或证明持久化失败时完整回滚；数据库触发器禁止恢复已清理内容。原幂等键和请求摘要继续拒绝重复执行。

`GET /api/gateway/content-retention?requestId=...` 需要 audit:read，仅返回本应用保留状态与证明。`POST` 需要 security:operate 及现有 CSRF 校验，字段为 requestId、expectedVersion、holdUntil（ISO 时间或 null）、reason；所有修改采用版本比较，原因只保存 HMAC。已清理内容不能事后设为保留，也不会尝试恢复。

原始上传对象、引用来源、外部索引和备份是不同保留域。这里的删除证明只确认网关数据库内容；有响应对象引用时对象存储阶段为 PENDING_EXTERNAL，备份始终保持 PENDING_EXTERNAL。部署必须另行配置备份过期/保留锁定，不宣称物理备份已删除。

6 项隔离数据库集成测试通过，包括锁定/CAS/作用域、到期清理与签名、未完成请求保留、墓碑、审计失败回滚、并发清理与显式解除锁定。首次夹具错误把额外作用域字段放入证明，已在隔离库明确作废该轮证明、移除多余字段并重新完整测试；最终服务只投影 tenantId/applicationId，测试断言不含凭据字段。
