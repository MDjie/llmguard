# Guard Gateway V2

Java 21 / Spring Boot 4.1.1 WebFlux 承担模型代理；Next.js 控制面负责身份授权、固定策略快照、GuardEngine 检测和执行证据。

## 接口与执行约束

- `POST /v1/chat/completions` 同一路径支持普通 JSON 与 `stream=true`。
- `POST /v1/chat/completions/stream` 保留兼容别名，调用同一执行服务。
- `wss://…/v1/chat/completions/ws` 每连接一次业务请求，结果帧来自同一输出审核服务。
- 控制台 `POST /api/chat` 使用当前登录用户签名断言调用代理，不能从请求体指定角色或租户。
- 应用使用 Bearer 或 X-Guard-Api-Key；两种凭据冲突时拒绝。客户端需同时满足部署的 TLS 身份要求。

一次授权固定 AuthContext 和签名运行快照。输入/输出均覆盖结构化文本、工具名称及参数；MASK、REWRITE 和 SAFE_RESPONSE 必须实际应用并通过一次复检。REQUIRE_REVIEW 创建审核事件，禁止作为正常答案返回。

当前流式实现为 FULL_BUFFER：在模型结束、完整检测和持久 RELEASE_INTENT 后释放；截断、不完整覆盖、撤销及未知字段均拒绝。WINDOW 资格路径仍在开发中，不能声称低延迟逐窗口释放已交付。服务器写操作成功不等于用户实际收到；客户端取消及发送后状态未知保留执行证据，不自动重放模型调用。

## 本机隔离验证

仓库根目录使用 pnpm：

```powershell
pnpm test:gateway-java
pnpm test:unit --run tests/gateway-runtime
pnpm exec node scripts/integration/check-gateway-v2-deployment.mjs
pnpm test:integration:gateway-v2
```

集成测试依赖单独的 PostgreSQL、真实控制面、真实 Java 代理和合成模型采集器。准备脚本位于 scripts/integration/gateway-v2-*；环境和临时证书留在被 Git 忽略的 .artifact-build 中。禁止把这些短期测试密钥用于交付。当前测试结果以 acceptance/gateway-v2/evidence 下的报告为准。

## 强制双向 TLS（mutual TLS）配置

独立的 `gateway-v2` Spring profile 强制 TLS 1.3 和 `client-auth: need`。证书必须包含服务器 DNS SAN：Compose 控制面为 app，Java 为 gateway；开发证书另包含 localhost/127.0.0.1。外部应用、BFF 和代理工作负载分别配置客户端证书。CA 文件可包含业务所需的可信 CA 链。

Java 的 `/actuator/health/readiness` 管理监听仅在容器回环地址 127.0.0.1:8081 开放，不能将该端口映射到外部。生产控制面内部网关接口还校验真实 TLS 对端指纹、请求 HMAC、时间戳和 nonce；单独伪造反向代理头或仅声明启用 service-mesh 不满足此校验。

仓库根目录的 `docker-compose.gateway-v2.yml` 为可选覆盖配置：

```powershell
docker compose -p guardllm -f docker-compose.yml -f docker-compose.gateway-v2.yml config --quiet
```

准备并审核证书、秘密文件、模型路由和数据库备份后，再按交付流程启动。当前开发仅验证配置，没有执行生产部署。凭据与密钥不应写进 Compose、镜像、日志或普通仓库文件。

| 用途 | 控制面 | Java 代理 |
|---|---|---|
| AuthContext / 快照签名 | GATEWAY_AUTH_SIGNING_PRIVATE_KEY_FILE | 不挂载私钥 |
| 验签公钥 JSON：keyId → PEM | GATEWAY_AUTH_PUBLIC_KEYS_FILE | GATEWAY_AUTH_PUBLIC_KEYS_FILE |
| 工作负载注册 JSON：nodeId → secret/role/certificateSha256 | GATEWAY_WORKLOAD_KEYS_FILE | 仅 GATEWAY_WORKLOAD_SECRET_FILE |
| 模型路由 | GUARD_MODEL_ROUTES_FILE，与逻辑路由共同签入快照 | 相同 GUARD_MODEL_ROUTES_FILE，ACK 与调用前验签比对 |
| 数据等级允许列表 JSON：routeId → 等级数组 | GATEWAY_MODEL_ROUTE_BOUNDARIES_FILE，与应用 dataClass 共同校验 | 相同 GATEWAY_MODEL_ROUTE_BOUNDARIES_FILE |
| BFF 客户端 TLS | GATEWAY_CONSOLE_TLS_CERT/KEY/CA | 服务器要求受信任客户端证书 |
| 代理到控制面/模型 TLS | 控制面证书 GATEWAY_CONTROL_TLS_CERT/KEY/CA | GATEWAY_TRUST_CERTIFICATE、GATEWAY_CLIENT_CERTIFICATE、GATEWAY_CLIENT_PRIVATE_KEY |

文件和对应内联环境变量不能同时设置。签名与 TLS 证书轮换须先分发信任公钥/CA，再切换签发与客户端，最后在最长请求和回执保留期结束后移除旧信任。Java 当前在启动时加载验签密钥和工作负载秘密，采用滚动重启更新；控制面文件缓存可识别原子替换。历史回执的解密密钥通过 SECRET_MASTER_KEY_RING_FILE 保留，不能只更换主密钥便删除旧密钥。

每个代理实例使用独立 GATEWAY_NODE_ID，并在控制面注册其工作负载密钥和证书指纹；不能以一个共享节点编号冒充多个实例 ACK。Compose 覆盖配置为单实例，集群需按节点配置独立身份。

Redis 仅供内部配额和分布式并发使用，须配置 ACL 与带认证的 GATEWAY_REDIS_URI，无公网端口；配额和并发依赖故障时关闭放行。生产容量与延迟须按固定硬件剖面压测，默认资源限制不是性能承诺。

旧的 evaluate/gRPC 路径仍保留原 context HMAC / guard service credential / active bundle 设置，仅用于兼容依赖，不能代替 V2 的每应用授权。Compose 新 profile 默认不开放 gRPC。模型路由可以通过 bearerTokenEnv 引用独立模型密钥；按部署环境将该名称注入 Java，不能把模型密钥直接写进路由 JSON。