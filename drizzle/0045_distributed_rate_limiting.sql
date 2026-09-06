-- 0045: 分布式限流桶（多副本共享计数）
-- 进程内限流器在 N 副本部署下实际限额 ×N（登录 5 次/15 分钟变 5N 次），
-- 改用 Postgres 固定窗口：INSERT ON CONFLICT 原子自增，所有副本共享计数。
-- bucket_key 存 sha256(policyId:subject)，定长且不泄漏主体标识符。
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
    "bucket_key" varchar(64) NOT NULL,
    "window_start" timestamptz NOT NULL,
    "count" integer NOT NULL DEFAULT 0,
    PRIMARY KEY ("bucket_key", "window_start")
);
