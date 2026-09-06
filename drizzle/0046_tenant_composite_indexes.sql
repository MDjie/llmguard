-- 0046: 租户复合索引
-- 兼容层（src/lib/db.ts）对所有查询强制追加 tenant_id + application_id 过滤，
-- 但热表索引均为单列（如 created_at），多租户下过滤+排序需回表过滤。
-- 复合索引让 (租户过滤, 排序/关联) 走单次索引扫描。
CREATE INDEX IF NOT EXISTS "detection_sessions_scope_created_idx"
    ON "detection_sessions" ("tenant_id", "application_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "detection_records_scope_session_idx"
    ON "detection_records" ("tenant_id", "application_id", "session_id");
CREATE INDEX IF NOT EXISTS "risk_findings_scope_record_idx"
    ON "risk_findings" ("tenant_id", "application_id", "record_id");
