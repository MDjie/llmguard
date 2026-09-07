# 执行事件批量审计

每条发送、释放、写出及终止事件仍先持久确认，批量锚定不替代释放前的确认语义。事件正文不可修改或删除，`auditBatchId` 只能从空值绑定一次。默认每批 500 条，上限 1000；并发 worker 通过 `FOR UPDATE SKIP LOCKED` 领取事件，不依赖会漏掉晚提交事务的时间游标。

批次保存事件编号、业务请求、事件序号及完整记录摘要，并使用 `gateway-audit-batch-v1` Ed25519 签名。沿用现有安全审计链，增加 `gateway.execution.batch` 类型，一批只占一条审计链记录；批次 SHA-256 放在审计记录 queryString 中并纳入既有链计算，不改变旧审计链版本和字段含义。

批次、审计链记录、现有 SIEM 投递 outbox 和事件归属在同一个短数据库事务中提交。无外部网络调用在事务内进行。投递方沿用 syslog/TLS、Kafka 或 TONE 的现有重试机制；目标未配置时仅持久锚定，不声称外部送达。外部投递可重复，接收端按 auditEventId 去重。

现有 gateway-request worker 每轮至多处理 20 批，另执行超期请求和工具执行对账。监控暴露 `guardllm_gateway_audit_unanchored_events` 与 `guardllm_gateway_audit_oldest_age_seconds`，无请求、主体或租户高基数标签。请求详情事件返回批次编号；`GET /api/gateway/audit-batches?id=<uuid>` 需 audit:read 权限及相同作用域。

查询验证批次签名、摘要、锚定引用和当前持久记录。完整历史审计链及可信时间验证仍由既有审计巡检负责，批次接口不会把自身验证标成整条历史链验证。

部署先执行幂等迁移 `0054_gateway_audit_batches.sql`，再启用新 worker。历史事件会逐批进入锚定。后续事件留存删除须另行设计授权归档/删除证明，当前不可直接删除已保存执行事件。

隔离数据库 7 项测试通过：签名验证、并发无重复、outbox 写失败整体回滚、不可改写/删除、跨应用拒绝、摘要投递对应、积压清空与重试。报告：`acceptance/gateway-v2/evidence/2026-09-07/audit-batch-evidence.json`。尚未代替目标硬件写吞吐和外部 SIEM 联调。
