-- 0044: 审计事件来源归因（等保要求：登录等安全事件需记录源地址）
-- query_string: 目标资源追溯（DELETE /api/users?id=xxx 删了谁）
-- client_ip / user_agent: 源地址与客户端指纹
-- 链条版本同步升级为 2（新字段纳入哈希保护，v1 旧条目按原字段集校验）
ALTER TABLE "security_audit_events"
    ADD COLUMN IF NOT EXISTS "query_string" varchar(1024),
    ADD COLUMN IF NOT EXISTS "client_ip" varchar(64),
    ADD COLUMN IF NOT EXISTS "user_agent" varchar(256);

CREATE INDEX IF NOT EXISTS "security_audit_events_client_ip_idx" ON "security_audit_events" ("client_ip");
