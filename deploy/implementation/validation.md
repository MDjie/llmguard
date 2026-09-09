# 实施测试模式验收记录

日期：2026-09-09。状态：代码、本机隔离数据库、应用镜像、Worker 镜像及浏览器验收全部通过。

| 检查 | 结果 |
| --- | --- |
| 全量 Vitest | 1809 / 1809 通过，0 失败 |
| pnpm build（含 TypeScript） | 通过；应用 Docker 构建也通过 |
| pnpm lint | 0 错误，65 条现有警告 |
| 修改文件 ESLint / pnpm ts-check | 通过 |
| Worker 注册入口 | 实际镜像中全部 16 个入口通过；缺失 IAM 入口的负例能够失败 |
| 实际 docker build --target worker / runner | 均通过 |
| 隔离数据库、镜像运行及浏览器 | 29 / 29 场景通过 |
| IAM Worker 生命周期 | 完成维护，正常停止，退出码 0 |
| 目标运行环境切换 | 未执行；本轮按用户要求仅完成代码及本机隔离测试 |

原始记录：[单元测试](../../输出/测试报告/2026-09-09/iam-implementation/unit-tests.json)、[集成测试](../../输出/测试报告/2026-09-09/iam-implementation/integration.json)、[汇总](../../输出/测试报告/2026-09-09/iam-implementation/validation-summary.json)。仓库没有 `generate:docs` 脚本，本次部署方案与验收文档直接维护。

## 已实施的行为

- `IAM_DEPLOYMENT_MODE=implementation`：系统管理员获得平台功能权限；安全及审计角色缺失不再阻塞 IAM 预检。
- 同一系统管理员可直接创建/修改其他普通管理员，并可确认自己的模型上线申请、处理此前提交的非应急 IAM 申请。
- 默认 `strict`，无效模式值报错。服务端每次请求计算当前权限，通过 `/api/auth/me` 给界面提供模式和实际权限。
- 首次改密、登录校验、应用授予、租户隔离、最后管理员保护、版本检查、会话撤销和审计保留。原有业务发布审批/签名、出网控制以及双人应急访问未简化。
- Worker 镜像加入 IAM Worker、预检、维护及引导命令；构建阶段执行全部注册 Worker 的入口自检。

## 实际交付镜像

| 本机镜像 | 镜像 ID |
| --- | --- |
| `guardllm-worker:iam-implementation-test` | `sha256:cb654bdd06952e28d15bd3052d91d47f4f386e728ff47bd7781f025c94e6747f` |
| `guardllm-app:iam-implementation-test` | `sha256:2bf35418be05b141a0d78158178937d34a49ad0ff586a29be2bff19efbc0090a` |

验收使用随机命名的临时 PostgreSQL 容器，全新数据库执行迁移。IAM Worker 与应用分别从上述真实镜像启动；浏览器访问应用镜像的正式启动入口。测试结束后删除本轮临时容器，镜像保留供本机复验。

覆盖迁移回填、授权隔离、开户改密、会话撤销、OIDC 签名与 MFA、独立审批与应急流程、实施模式单管理员操作、模型自审批及重放拒绝、切回严格后旧会话权限收回。六类账户均完成页面和菜单边界检查。

截图：[系统管理员](../../输出/测试报告/2026-09-09/iam-implementation/browser-SYSTEM_ADMIN.png)、[实施模式模型审批](../../输出/测试报告/2026-09-09/iam-implementation/browser-implementation-approval.png)、[审计审批](../../输出/测试报告/2026-09-09/iam-implementation/browser-approvals.png)。

## Docker 本机恢复记录

已确认 `%LOCALAPPDATA%/Docker/wsl` 正确映射至 `E:/DockerData/wsl`。启动失败来自运行目录的残留本地 socket；参考 Docker 项目的同类问题记录：[启动故障](https://github.com/docker/desktop-feedback/issues/460)、[目录恢复与 Docker AI 相关反馈](https://github.com/docker/desktop-feedback/issues/531)。这些是问题反馈，具体恢复效果以本机验证为准。

在 Docker 停止时备份并重命名 `Docker/run` 和 `docker-secrets-engine` 运行目录，由 Docker 启动时重新生成；备份 `settings-store.json` 后关闭可选 `EnableDockerAI`。旧目录及配置备份以 `.iam-recovery-*` 保留。之后 Docker Engine 29.7.2 启动成功。

未手工修改 E 盘虚拟磁盘，未执行工厂重置、卷清理或业务容器删除。首次镜像验收遇到临时数据库发布端口缺失，重启该临时容器后恢复，后续完整复验正常。构建访问 Docker Hub 时使用已有本机代理 `127.0.0.1:7897`，仅设置构建进程环境变量，未改全局网络配置。
