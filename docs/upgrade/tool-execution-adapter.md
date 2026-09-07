# 工具执行器适配协议 1.0

新增 POST /api/v1/guard/tools/execute；沿用 guard:use、租户认证和控制台 CSRF。请求只接收 invocationId、permitToken、parameters，不接收调用者自报的用户、目的地址或执行器身份。

1. 登记工具并完成供应链准入。服务端 TOOL_EXECUTORS_FILE（或 TOOL_EXECUTORS_JSON，二选一）配置与目录中相同的 tenantId、applicationId、toolId、toolVersion、definitionDigest、endpoint、executorId。
2. 每项配置包含 serverCertificateSha256、caFile、certificateFile、keyFile；要求 HTTPS、CA 校验、主机名校验和服务端证书指纹校验，使用独立客户端证书。可配置 timeoutMs（100～60000）和 maximumResponseBytes（1024～2097152）。目录 serverIdentity 必须等于 executorId，networkDomains 必须包含目标主机。
3. authorize 返回的 v2 许可新增可选 executorConfigurationHash。受控执行必须具有该绑定。配置、工具版本、参数或目标变化后原许可失效。
4. 发送前在现有 tool_invocations 原子写入 executing、消费时间、请求摘要和截止时间。只有一个竞争调用获得许可。提交后通过固定 mTLS 地址 POST；禁止自动重试、重定向或跟随工具返回的地址。
5. 请求与回执字段见 src/lib/tools/executor.ts。请求正文为 guard-canonical-v2；HTTP Idempotency-Key 为 invocationId，X-Guard-Request-Digest 为正文 SHA-256。X-Guard-Execution-Key-Id / X-Guard-Execution-Signature 提供 gateway-tool-execution-v1 域分离 Ed25519 授权签名，执行器使用控制面公钥验证；Node 适配器可复用 verifyToolExecutionAuthorization。parametersHash 保留现有工具许可的 policy canonical 算法，与请求正文摘要分开。
6. 执行器必须验证网关客户端证书、请求摘要、工具定义版本与截止时间；以作用域和 invocationId 原子记录消费和实际副作用。重复到达只能查既有结果，不能重复执行。接入端必须对其许可消费存储和副作用边界提供联合验收证据。
7. 回执必须绑定 invocationId、scope、tool/version、executorId、requestDigest、resultDigest 和完成时间，状态为 SUCCEEDED / REJECTED / UNKNOWN。只有 SUCCEEDED 且原批准策略的 TOOL_RESULT 检测允许时返回正文。结果始终作为不可信数据。
8. 连接丢失、摘要不符或回执不明记为 execution_unknown，原许可不再可用。gateway:reconcile 将逾期无回执请求标记未知，不重放外部操作。已提供只读结果查询及独立审批的补偿流程，见下文；不自动重放或补偿未知操作。
9. 持久化回执移除结果原文，用 AUDIT_CHAIN_KEY 或其 _FILE 计算证据 HMAC；不记录参数原文。数据库触发器禁止恢复已消费许可或替换已保存回执。

旧 /tools/result 继续用于外部工具结果的内容检测，不能消费受控执行许可，也不构成实际执行证明。TOOL_PERMIT_KEY 与既有部署名 TOOL_PERMIT_SIGNING_KEY 兼容；冲突值或环境变量/文件双重定义均拒绝。

验证：scripts/integration/check-gateway-v2-tool-execution.ts 使用真实隔离 PostgreSQL、真实检测引擎和合成 mTLS 执行器，覆盖 18 项执行 / 对账 / 写操作与补偿测试。此证据不是 AgentGuard 产品认证。部署 0049 后须验证历史作用域外键和状态约束；扩展迁移保留旧字段与状态，不删除旧记录。

## 只读结果查询

新增 `POST /api/v1/guard/tools/reconcile`，参数只有 invocationId、queryId。调用主体须与原操作相同，沿用作用域、CSRF 和权限校验。运维在最初配置执行器时提供 statusEndpoint，必须位于执行地址相同 origin 且路径不同；后来改变配置不能使旧许可突然获得新目的地址。

查询请求签名域为 `gateway-tool-execution-query-v1`，只含原执行摘要、执行器身份和时间绑定，没有 action 或 parameters。只有 UNKNOWN 可对外查询，32 次记录为上限，同一 queryId 持久去重。回执仍绑定原执行摘要；成功时结果经过原批准策略复检，查询 API 返回最小状态及追加证据，不返回工具原文。原 UNKNOWN 回执不可改写，查询证据形成追加 HMAC 链；旧许可永久保持已消费。

## 高风险写操作与补偿

受控高风险工具的 supportingEnvelopeIds 必须采用 `gw/<businessRequestId>/<segmentId>`。服务端查验同一主体、作用域、固定策略及尚有效的签名上下文，并要求原 INPUT 完整检测为 ALLOW/WARN。只有 USER/user 分段可作为来源，模型、系统、FILE、RAG 或工具内容不构成授权。高风险来源最多 32 个且不能重复。发许可及实际执行前都复核；短期上下文过期后需重新发起确认。

审批仍须与请求人不同，绑定工具版本、参数、资源及动作意图；改变参数必须重新审批。持久动作意图、来源及预算字段不可改写，执行器只在许可被原子消费后接到请求。

补偿复用 authorize，额外传 `compensatesInvocationId`。必须已经确认原副作用成功，且为相同主体、应用、Agent run 和资源；未查询确认的 UNKNOWN 不可补偿。补偿是新的受控副作用，独立审批、独立许可、再次扣 Agent 生命周期预算，执行请求携带原执行编号和摘要。补偿参数由有权用户明确提供，系统不推断撤销动作；一项原操作最多存在一个未取消/未拒绝的补偿链路，不对补偿再次自动补偿。

迁移顺序：0049 → 0051 → 0052。18 项隔离测试包含模型链路生成的真实授权来源、写入一次、查询恢复、补偿一次、禁止重复及数据库不可变约束。尚未验证真实 AgentGuard 的持久消费与业务副作用原子性。
