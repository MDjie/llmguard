# 网关 2.0 Helm 与离线恢复

新图表位于 `deploy/helm/guard-gateway-v2`，用于部署统一代理及控制面；旧 `guardllm` 图表继续承担既有分析器等组件。迁移时必须避免旧代理入口仍对外提供业务流量。模型、PostgreSQL、Redis、对象存储、已签名策略和密钥服务为受管理依赖，不在该图表中创建空白生产数据库或模拟模型。

标准拓扑为 3 个代理序号、2 个控制面实例和 1 个请求/审计对账 worker。代理 StatefulSet 按序启动、滚动升级且不 surge；每个序号使用独立证书和 HMAC 密钥。节点异常恢复后仍需实际加载 ACK；替换 Pod 复用序号时只算同一逻辑节点，不把残留旧 ACK 算作额外副本。历史实例级统计仍以现有 ACK 有效期和加载状态为准。

以 release `guard` 为例，代理 Pod 为 `guard-v2-proxy-0..2`。`proxyIdentitiesSecret` 应包含每个 Pod 的 `.crt`、`.key`、`.secret` 文件。Pod 只通过 subPathExpr 挂载自身三份文件，不挂载整份身份目录；控制面 workloadRegistrySecret 的 keys.json 将每个 Pod 名绑定 role=proxy、相同 HMAC 密钥及该 Pod 证书 SHA-256。所有代理不得共用一个 HMAC 密钥或证书。扩容前先增加独立身份并更新控制面注册表，再提高 provisionedProxyIdentities/proxyReplicas。subPath 挂载不会自动刷新已挂载文件，证书轮换必须执行受控滚动重启。

需要预置的 Secret：

| Secret 配置 | 必需内容与范围 |
|---|---|
| controlRuntimeSecret | PostgreSQL 连接、主密钥/信封、CONTENT_HASH_KEY、AUDIT_CHAIN_KEY 等既有控制面配置；禁止复制给代理 |
| proxyRuntimeSecret | Redis 配额/并发连接，以及既有配置绑定所需的 GATEWAY_CONTEXT_HMAC_SECRET、GUARD_APP_KEY、MODEL_BASE_URL 等；不得包含控制面签名私钥或数据库凭据 |
| signingSecret | private.pem，仅控制面及审计签名 worker 挂载 |
| publicKeysSecret | keys.json（keyId→PEM 公钥），ca.crt（可信 CA 链） |
| workloadRegistrySecret | keys.json，仅控制面/对账 worker 可读取完整节点注册表 |
| controlTlsSecret | tls.crt、tls.key；SAN 覆盖 `<release>-v2-control` 服务名称 |
| consoleTlsSecret | tls.crt、tls.key；用于控制台访问强制 mTLS 代理 |
| proxyIdentitiesSecret | 每个序号独立的证书/私钥/HMAC 文件；证书包含客户端和服务端用途，SAN 覆盖代理服务和该序号地址 |
| modelRoutesSecret | routes.json 与 boundaries.json；必须和签名快照捕获的配置一致 |
| modelCredentialsSecret | 路由引用的实际秘密文件，只由代理挂载 `/run/guard/models` |

镜像必须使用不可变 digest。配置 ingressPeers 和各角色 egress 中的数据库、Redis、模型及对象存储地址；默认不允许隐式外部出口。至少准备 3 个可调度节点，反亲和不通过时 Pod 保持 Pending，不偷偷降为单节点。图表没有自动扩容器，以免生成没有独立身份的代理。

代理只公开 8443 mTLS，旧 gRPC 入口关闭；管理端口 8081 只绑定回环，Java 自带的 GatewayReadinessProbe 通过容器内管理端点探测，不依赖 curl/wget。控制面 5000 使用 HTTPS 并在服务器端认证真实 TLS 对端，Next 内部服务器仅绑定回环。

先 `helm template`、核验身份与镜像清单，再做隔离集群安装和故障演练。当前已通过 Helm 3.17.3 渲染及 6 项结构检查；尚未在真实 Kubernetes 集群安装，不将静态渲染作为 HA 或网络策略实际生效证明。

Java 制品使用 `node scripts/release/build-gateway-v2-java.mjs --online` 准备缺失公共构建依赖，随后 `--offline` 在 Docker `--network none` 下重复 verify 和打包。缓存保存在工作区构建目录，不改写用户 Maven 种子库。两次构建均通过 41 项测试，产出可执行 JAR 与独立管理探测 class；还需最终镜像/BOM/签名归档。

`scripts/integration/check-gateway-v2-restore.mjs` 只允许命名的隔离数据库：生成 pg_dump、恢复到独立新库、比对 10 张关键表、重复 0047～0054 迁移、验证旧查询和防篡改触发器。生产升级仍需先备份，按有序 SQL 执行扩展迁移；Compose 首次初始化挂载不会自动升级既有库。恢复报告属于小规模工程演练，不能作为生产 RTO 达标证明。
