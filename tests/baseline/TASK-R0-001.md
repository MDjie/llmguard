# TASK-R0-001 交付记录

## 任务

- 目标：建立可复现的 Node/pnpm 工具链、Vitest 单元测试和 TypeScript/ESLint 零错误门禁。
- 需求：UPG-ACC-004、SEC-002、SEC-003。
- 数据迁移：无。
- 运行行为变化：无护栏业务行为变化。

## 基线与门禁

| 工具 | 初始上限 | 当前值 | 结果 |
|---|---:|---:|---|
| TypeScript | 68 | 0 | 通过，R0 收口 |
| ESLint | 156 | 0 | 通过，R0 收口 |
| Vitest | 无 | 76/76 | 通过 |

`pnpm quality:ratchet` 只保留为历史基线验证且上限已设为 0；默认 `pnpm validate` 和 CI 均执行 `pnpm quality:full` 零错误严格门禁。

## 工具链

- Node.js：24.20.0 LTS，通过 `.node-version` 和 CI 固定。
- pnpm：11.19.0，通过 `packageManager`、`engines` 和 CI 固定。
- Vitest：4.1.11，精确依赖。
- shadcn CLI：从不可复现的 `latest` 固定为原 lockfile 使用的 3.7.0。
- pnpm 原生依赖安装脚本在 `pnpm-workspace.yaml` 中逐项批准或拒绝。
- Vitest 传递依赖 picomatch 4.x 通过窄范围 override 固定到 4.0.7（公告修复门槛为 4.0.4）。

## 验证证据

```text
pnpm install --frozen-lockfile --lockfile-only --offline  PASS
pnpm exec eslint <touched files>                          PASS
pnpm validate                                            PASS
  TypeScript 0
  ESLint 0
  Vitest 76/76
pnpm audit --prod --audit-level high                     PASS (0 critical/high)
pnpm build                                               PASS
  Next.js compiled successfully with strict types
  52 pages/routes generated
docker compose build/up                                  PASS
  Node 24.20.0 Alpine standalone; app/postgres healthy
```

## 已知后续项

1. 完整生产依赖审计仍报告 1 个 Low，按版本升级周期跟踪，不影响 High/Critical 门禁。
2. 性能、HA、信创与监管测评必须在目标环境提供外部证据，不能由单机结果替代。

## 回滚

删除 Vitest/ratchet/CI 配置并恢复 package scripts 即可回滚；本任务没有数据库或业务数据变更。
