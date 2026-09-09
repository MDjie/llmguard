# GuardLLM 企业身份接入

推荐 Keycloak，通过 OIDC 接入。本项目使用授权码 + PKCE、浏览器绑定、一次性 state、nonce、ID Token 签名/签发者/受众/有效期校验及强制 MFA ACR 校验。只绑定已开户用户的 issuer + subject，不根据邮箱、用户名或 IdP 角色自动提升权限。

当前没有企业身份平台，因此仓库提供部署配置和接入说明。业务域名、证书、三名职责人员及企业账户绑定完成前，企业登录按钮保持隐藏，不能将此状态视为生产身份验收通过。

## 1. 部署身份平台

模板固定 Keycloak 26.7.3。部署前按官方安全公告审查版本，并在正式发布锁定镜像摘要。参考：
- [Keycloak 容器部署](https://www.keycloak.org/server/containers)
- [Keycloak 生产配置](https://www.keycloak.org/server/configuration-production)
- [Keycloak 管理手册](https://www.keycloak.org/docs/latest/server_admin/)

向部署环境注入 KEYCLOAK_DB_PASSWORD、KEYCLOAK_ADMIN_USERNAME、KEYCLOAK_ADMIN_PASSWORD、KEYCLOAK_HOSTNAME 四个变量，运行：

```powershell
docker compose -f deploy/identity/compose.yaml up -d
```

模板只暴露回环地址 58090。需在同机 HTTPS 反向代理后使用，代理必须覆盖 X-Forwarded-* 头，不接受外部任意传入值。限制管理控制台来源，配置持久卷备份和恢复演练。首次启动后创建具名管理账户并撤销临时 bootstrap 管理账户；随后移除 bootstrap 密码配置。生产不得使用 start-dev。

## 2. Realm 与客户端

1. 创建独立 realm：guardllm，关闭公开注册。
2. 创建 OIDC confidential 客户端 guardllm-console，启用 Standard Flow，关闭 Implicit Flow 和 Direct Access Grants，要求 PKCE S256。
3. Valid Redirect URIs 精确设置为业务域名 /api/auth/oidc/callback，禁止通配符。客户端密钥仅注入应用服务端。
4. 配置 browser flow，要求口令 + OTP 或经组织批准的双因素 WebAuthn 流。配置 Step-up Authentication，将 ACR guardllm-mfa 映射到 LoA 2，且 LoA 2 的认证子流程强制完成两因素。
5. 不要通过静态 protocol mapper 无条件写入 MFA ACR。必须验证只输入密码时不会得到 guardllm-mfa；平台会拒绝低强度 token。
6. 应用仅申请 openid scope，不需要下发 email、groups 或 realm roles。三个管理员分别预先开户并将 Keycloak 用户 ID（subject）绑定到对应用户，应用授权仍由本系统管理。
7. 按 guardllm-oidc.env.example 配置应用。Issuer 必须与发现文档、ID Token iss 完全相同。应用服务器需能访问发现文档、token 和 JWKS 端点，三者必须同源。
8. 逐个验证系统管理员、安全管理员、审计管理员登录与权限，再启用 IAM_ENTERPRISE_LOGIN_REQUIRED=true。此开关要求普通管理账户企业 MFA 登录；应急账户仍走限时双人启用流程。

上游仅支持 SAML 时，可由 Keycloak 进行身份代理，应用侧保持 OIDC。需要明确上游认证强度映射，不能把一次普通 SAML 登录视为 MFA。

## 3. 平台迁移及职责引导

先备份数据库并运行 pnpm iam:preflight（数据库连接通过环境变量显式提供）。报告列出无有效默认应用、未知角色和缺失的管理职责。先修复异常数据，然后依次应用 drizzle/0073_iam_application_grants.sql 与 0074_provider_approval.sql。

0073 只回填各成员原有默认应用，不把同租户全部应用授予用户。应用切换功能上线前核对需要的额外应用，采用受控授权逐项补充。生产切换前完成缺失管理职责的引导，避免旧系统管理员降权后无人操作策略或审批。

对每个缺失职责运行一次 pnpm auth:bootstrap。必填环境变量：

| 变量 | 含义 |
| --- | --- |
| PGDATABASE_URL | 目标数据库连接，显式指定 |
| AUDIT_CHAIN_KEY | 已有审计链密钥，不可替换为临时密钥 |
| BOOTSTRAP_ADMIN_ROLE | SYSTEM_ADMIN / SECURITY_ADMIN / AUDIT_ADMIN |
| BOOTSTRAP_ADMIN_USERNAME | 不同人员的具名账户 |
| BOOTSTRAP_ADMIN_PASSWORD | 通过密钥管理注入的强密码 |
| BOOTSTRAP_IAM_REASON | 引导工单或迁移说明，至少 10 字符 |
| BOOTSTRAP_TENANT_CODE | 默认 legacy |
| BOOTSTRAP_APPLICATION_CODE | 默认 default |

命令只创建该租户尚缺失的管理职责，不覆盖已有账户；用户、应用授权、首次改密和审计链在同一事务提交。引导账户首次登录必须改密。正式企业账号绑定和激活由独立审批流程执行。不得让一人兼用多个职责账户。

再次运行预检，确认三个职责齐备后构建并切换应用。旧应用与新数据库模型回退可能恢复旧的宽权限语义，因此回滚须保持访问入口关闭，恢复已验证的代码/数据库配对版本，而不能直接启用旧的全权限管理员。

## 4. 应急访问和维护

应急账户创建时停用。独立申请人提交理由及 5–60 分钟窗口，另外两名不同角色人员审批，两名审批人都不能是申请人或目标账户。审批期间申请人或先前审批人的会话版本发生变化即拒绝执行，需重新申请。

认证层每次请求检查到期时间，到期立即拒绝；pnpm iam:maintenance 同时把数据库账户状态改为停用、递增会话版本、过期待办和清理 OIDC 交换记录，并写入审计链。主 docker-compose.yml 已增加 iam-worker，每分钟执行维护；其他部署平台需配置同等维护作业。即使调度延迟也不会延长实际访问窗口。应急密码离线保管，使用后轮换并进行审计复核。

## 5. 验证

- pnpm ts-check
- pnpm test:unit --run tests/auth tests/tenancy tests/api-security
- pnpm test:integration:iam

集成测试新建本机临时 PostgreSQL 容器，端口 55439，完整应用迁移并验证真实数据库事务、权限撤销和由隔离 OIDC 签发者签名的 token。测试结束只删除自行创建的临时容器，不操作运行中的业务数据库。真实 Keycloak、TLS 代理和组织 MFA 流还须按第 2 节进行部署验收。
