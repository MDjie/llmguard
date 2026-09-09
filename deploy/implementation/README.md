# 实施测试模式：部署与验证方案

## 原因与技术结论

1. 原 IAM 预检将三类管理员齐备作为上线前置条件，阻塞只有系统管理员的测试现场。角色和职责账户不应成为实施联调的硬门槛。
2. Worker 注册表已包含 IAM，但 Dockerfile 的独立 worker 阶段漏拷入口。应用构建成功无法证明 Worker 镜像完整。
3. Next.js 的 NEXT_PUBLIC_* 在构建时固化，不能用于可切换的授权模式。这里使用服务端运行时变量，并通过已有 `/api/auth/me` 返回实际权限和模式；浏览器不能自行选择模式。

依据：[Docker 多阶段构建](https://docs.docker.com/build/building/multi-stage/)、[Next.js 环境变量](https://nextjs.org/docs/app/guides/environment-variables)，以及仓库当前 Next.js 本地文档。

## 方案与边界

| 行为 | implementation | strict（默认） |
| --- | --- | --- |
| 缺少安全/审计管理员 | 提示，已有系统管理员即可联调 | 预检失败 |
| 系统管理员功能权限 | 所有平台功能权限，仍限定已授应用 | 账户、应用及平台管理职责 |
| 高权限本地开户及他人账户变更 | 系统管理员直接保存生效 | 独立审批 |
| 模型上线 | 系统管理员可确认自己的申请 | 作者与审批人独立 |
| Keycloak/OIDC | 无需部署，本地密码可登录 | 企业登录开关按现场配置 |
| 登录、首次改密、会话撤销 | 保留 | 保留 |
| 应用/租户隔离、数据属性约束 | 保留 | 保留 |
| 策略发布签名、回归证据、原有业务审批 | 保留，按业务流程验证 | 保留 |
| 应急账户双人审批和过期清理 | 保留，日常测试使用普通本地管理员 | 保留 |

不会生成虚构的正式审批人员，不会开启匿名访问，不会跳过数据库迁移。界面展示实施模式提示，IAM 审计记录当前模式。切回 strict 后，新请求重新计算权限，不沿用实施模式权限。

## 执行顺序

本轮只修改源码并在全新本机隔离数据库、独立端口和临时服务中验证；不切换图片中的运行环境。

1. 备份目标数据库。对已有数据库先运行 IAM 预检，随后显式执行 `0073_iam_application_grants.sql` 和 `0074_provider_approval.sql`。Compose 的初始化挂载只对全新数据库生效；已有卷不会自动补迁移。
2. 在部署使用的环境文件中添加 `IAM_DEPLOYMENT_MODE=implementation`、`IAM_ENTERPRISE_LOGIN_REQUIRED=false`。Compose 已将模式传给应用和 Worker。无须 NEXT_PUBLIC 变量，无须重新编译前端配置。
3. 已有本地系统管理员继续使用原账户。全新安装仅引导一个系统管理员：配置 `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_PASSWORD`（强密码）和 `BOOTSTRAP_IAM_REASON` 后运行 `pnpm auth:bootstrap`；不覆盖已有账户。
4. 构建 Worker：`docker build --target worker -t guardllm-worker:iam-test .`。构建内自动核对所有注册入口；也可运行 `docker run --rm guardllm-worker:iam-test node scripts/run-worker.mjs --check`。
5. 构建应用并按既有 Compose 启动。已有环境在完成迁移后重建应用及 Worker 容器使变量生效。登录完成首次改密，确认顶部“实施测试模式”提示。
6. 用系统管理员完成开户、授权、模型配置和上线申请；到授权审批页核对并确认自己的模型申请。其余策略、白名单、导出等保留已有业务校验，不能把实施联调等同于正式安全验收。
7. 验收职责分离前，补齐真实安全和审计人员账户，切为 `IAM_DEPLOYMENT_MODE=strict` 并重建应用及 Worker 容器，运行 `pnpm iam:preflight`、检查现有会话权限收回。企业登录可另行接入。

## 验证设计

- 单元测试：默认严格、模式拼写错误失败、仅系统管理员获得扩展权限、首次改密/服务凭据不享受简化。
- 镜像测试：实际构建 worker 阶段并在镜像中执行入口检查；移除一个临时测试入口时检查必须失败。
- 隔离数据库：只存在一个系统管理员时预检可通过，其他角色缺失为提示；严格模式同样数据要求补齐角色。复用迁移回填和重复执行验证。
- API/浏览器：实施模式的开户/修改/模型自审批/菜单可用；越权应用、普通账户、会话撤销仍拒绝；切回严格后旧会话不再拥有实施权限。

最终运行结果记录在同目录 `validation.md`，未通过或未完成的检查单独列出。

在仓库根目录构建实际镜像并运行完整隔离验收：

```powershell
pnpm build
docker build --target worker -t guardllm-worker:iam-implementation-test .
docker build --target runner -t guardllm-app:iam-implementation-test .
docker run --rm guardllm-worker:iam-implementation-test node scripts/run-worker.mjs --check
pnpm test:integration:iam --browser --implementation --worker-image guardllm-worker:iam-implementation-test --app-image guardllm-app:iam-implementation-test
```

集成命令仅使用随机命名的临时 PostgreSQL 容器、55439 数据库端口和 58889 应用端口。报告位于 `输出/测试报告/2026-09-09/iam-implementation/`，保留原严格 IAM 验收记录。
