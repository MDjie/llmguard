# 0022 审计外发 Outbox

## 目的

将审计事件的防篡改存储与外部 Syslog/Kafka 送达解耦。事件和待发送记录在同一数据库事务中写入，后台发送器使用行锁认领、指数退避和终态失败告警，避免外部平台故障导致在线请求阻塞或事件静默丢失。

## 前置条件

- 已执行 `0017_tamper_evident_audit.sql`。
- 上线前完成目标 Syslog/Kafka 的 TLS、身份认证、主题权限和网络连通性验证。

## 回滚

先停止 `audit-export-worker`，确认无 `pending`、`sending` 或 `failed` 行，再归档表中证据后执行：

```sql
DROP TABLE IF EXISTS audit_export_outbox;
```

回滚只移除外发队列，不修改 `security_audit_events` 的审计证据。
