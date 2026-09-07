# 已验证文件引用与代码扫描适配

## 统一 Chat 文本文件引用

`POST /v1/chat/completions` 可增加 `guard_artifacts: [{artifactId, sha256}]`，最多 8 个，不接受 URL、调用者身份或客户端自报的可信标记。沿用 artifacts 上传、分片验证及所属主体；仅 accepted、未过期、同租户/应用且由当前主体持有的 TEXT 文件可同步进入模型。总文件读取上限 1 MiB，展开后仍受签名快照输入预算限制。

控制面读取前检查归属、摘要与分片清单，读取时核验实际字节数、分片和整体 SHA-256，读取后复核引用未变化。文件作为 `FILE / UNTRUSTED / FORBIDDEN` 来源参与统一输入检测。模型协议中呈现为带来源信息的 user 数据消息；授权签名同时绑定原始请求、准备后的请求及分段摘要。原文只随既有短期加密请求上下文保留。

文件可以和 `guard_rag` 一起使用。Java 在普通 HTTP、SSE 和 WebSocket 的同一执行服务中验证准备后的分段；后续输入变换复检保留 FILE/RAG 来源。每个发送/释放边界检查对象归属、有效期及元数据变化。已消费幂等键不再次读取文件或调用模型。

DOCUMENT、IMAGE、AUDIO、VIDEO 引用返回 `422 ARTIFACT_ASYNC_ANALYSIS_REQUIRED`，先使用既有 jobs 分析流程。同步 Chat 尚未支持把原始媒体直接传给视觉或音频模型，不能把文本检查算作整份媒体安全检测。文档/图片作业结果现保存分析器覆盖声明；既有页、帧、时间段、采样和资格逻辑继续生效，真实多模态质量必须独立验收。

工程证据：`scripts/integration/check-gateway-v2-artifact-model.mjs` 的 10 项真实 Java / Node / PostgreSQL / 合成模型测试通过。对象接收器仅为隔离夹具，不构成生产对象存储认证。

## CodeSentinel 适配契约 1.0

使用现有 `POST /api/v1/guard/jobs`，指定 `jobType: code_scan`、已验证的 TEXT 代码 artifactId 和批准的 bundleId。文件 metadata.language 必须处于批准语言清单内。`node --import tsx scripts/run-worker.mjs code-sentinel` 运行适配任务，支持既有取消、心跳、失败和回调流程。

运维以 `CODE_SENTINEL_ADAPTERS_FILE` 或 `CODE_SENTINEL_ADAPTERS_JSON`（二选一）配置作用域、固定 HTTPS 地址、mTLS 文件、服务证书指纹、adapterId、engineVersion、ruleSetDigest、languages、riskIds、allowedDataClasses、maximumSourceBytes、timeoutMs、maximumResponseBytes、expiresAt。完整字段见 `src/lib/connectors/code-sentinel-config.ts`。未配置时拒绝提交，代码只发送到批准的数据边界。

任务提交时固化配置和源文件绑定摘要。发送使用 `gateway-codesentinel-scan-v1` 域分离 Ed25519 签名；对端验证接口为 `verifyCodeScanAuthorization`。请求包含源代码及源摘要，禁止跳转与隐式网络重试。回执必须绑定任务、作用域、源摘要、配置摘要、引擎和规则版本；只保存规则、风险、严重度、行范围和证据摘要，不保存回执代码片段。

代码同时经过固定策略的通用文本安全检查。高危代码发现或通用检查禁止动作导致 BLOCK；失败、未支持、缺少批准风险或覆盖不足不得产生 ALLOW，进入失败或 REQUIRE_REVIEW。分析后再次检查归属及配置，取消后的任务不能完成。任务级重新尝试仅重新分析代码，不执行代码或业务动作；对端须按 jobId 去重计费。

迁移 `0053_guard_job_execution_binding.sql` 为既有 jobs 增加不可变执行绑定，适用于新旧接口混部。`scripts/integration/check-gateway-v2-code-sentinel.ts` 的 7 项隔离协议测试通过。此协议是本产品提供的适配边界；未获得外部产品接口及部署实例，尚未完成真实 CodeSentinel 联调和漏洞检测质量认证。
