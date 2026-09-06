# 数据库迁移说明

本目录存放**有序 SQL 迁移文件**，命名约定 `NNNN_描述.sql`（四位序号 + 下划线 + 语义名）。

## 迁移机制（重要）

本项目**不使用** `drizzle-kit migrate`，因此没有 `meta/_journal.json`（也无需要）。
实际的 schema 应用路径有两条，都依赖文件名排序：

1. **全新环境（Docker Compose）**：`docker-compose.yml` 把基础脚本与本目录迁移
   逐个挂载到 `/docker-entrypoint-initdb.d/`，由 Postgres 镜像在**首次初始化**空数据卷时
   按挂载序号执行。挂载序号规则：基础 schema 为 `00-`/`01-`，迁移为 `10-` 起步、
   每个迁移 +1（如 `drizzle/0044_xxx.sql` → `53-xxx.sql`）。
2. **CI / 集成测试**：`scripts/integration/run-database-tests.mjs` 读取
   `scripts/init-database-new.sql`、`scripts/init-database-supplement.sql` 与本目录全部
   `NNNN_*.sql`（按文件名排序）依次应用，然后做关系/约束/触发器的存在性断言。

## 新增迁移的检查清单

1. 在本目录新建 `NNNN_描述.sql`（序号 = 当前最大序号 + 1）；
2. **必须**在 `docker-compose.yml` 的 postgres 服务下追加对应挂载行（保持编号递增）；
3. 语句尽量幂等（`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`），
   便于对已存在的环境手工重放；
4. 同步更新 `src/storage/database/shared/schema.ts` 的 Drizzle 表定义——
   该文件是 ORM 的事实来源，`drizzle-kit generate` 生成新迁移时以它为基准；
5. 若新增了关键关系/约束，在 `run-database-tests.mjs` 的断言清单中补齐。

## 已存在环境的升级

`docker-entrypoint-initdb.d` 只在数据卷**首次**初始化时执行。对已有环境升级时，
需手工应用新增迁移：

```bash
psql "$PGDATABASE_URL" -f drizzle/NNNN_描述.sql
```

## `drizzle-kit` 的用途

`drizzle-kit`（devDependency）仅用于 `drizzle-kit generate` 从
`src/storage/database/shared/schema.ts` 生成差分迁移草稿；生成后需按上述清单
人工核对、重命名并接入两条应用路径。**不要**引入 `drizzle-kit migrate`，
那会要求 journal 并与现有两条路径冲突。
