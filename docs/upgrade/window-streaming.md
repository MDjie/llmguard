# 受控 WINDOW 流式输出

默认模式为 FULL_BUFFER。WINDOW 仅由运维配置的资格条目启用，不接受客户端声明“已检测”或“有资格”。白皮书中的聚合时延和吞吐目标仍需冻结硬件后测量。

## 资格与适用范围

控制服务读取 `GATEWAY_STREAM_QUALIFICATIONS_JSON` 或 `GATEWAY_STREAM_QUALIFICATIONS_FILE`，两者不能同时设置。值为数组；每个条目包含租户、应用、整个策略制品的 `bundleDigest`、资格 ID、到期时间、窗口参数、风险集合、数据集摘要、评审引用、`prefixSafe: true` 与 `gateResult: PASS`。条目的规范化 SHA-256 绑定签名运行快照。任何字段改变或条目被移除，都会阻止在途窗口再次检测或释放。

窗口参数为 `contextChars`（512–16000）、`chunkChars`（1024–4096）、`holdbackChars`（256–4096）。资格必须按这组参数验证；聚合步长与保留尾部是不同指标。UTF-16 代理对边界允许一个字符单元的调整。

仅 public/internal 数据边界可以配置 WINDOW。confidential 等高敏边界使用完整缓冲。生产环境还要求 `evidenceClass: INDEPENDENT` 和 coverage-v1 策略；所有必检风险必须在资格风险集合内。检测器及裁判自身的模型、版本、语言、范围和有效期资格继续由原有引擎校验。资格审批条目应来自独立质量评审，不应以本目录合成测试报告替代。

`evidenceClass: ENGINEERING` 只允许非生产环境。隔离夹具通过 `prepare-gateway-v2-window.ts` 创建这类条目，并明确标识为工程测试。

## 释放与终止

标准 `/v1/chat/completions` 的 `stream=true` 可使用 WINDOW。当前窗口路径仅处理单候选的纯文本输出。声明 tools、多候选或 WebSocket 使用完整缓冲路径。运行中出现工具调用、refusal、未知结构或非法 SSE 会终止，不释放这些字段。

每段处理顺序：

1. 有界聚合上游事件，提取滚动上下文和待释放尾部；保留绝对 UTF-16 偏移。
2. 使用同一 AuthContext、制品和只读会话快照检测。检测步骤按 streamSeq 单独幂等；后一个窗口核对前一窗口的重叠正文及写出记录。
3. 检测端只批准已检查且满足 holdback 的区间。代理持久化 RELEASE_INTENT 后才执行 socket 写出。
4. Netty 的 `writeAndFlush` 完成后发送 WRITE_ACCEPTED。它表示服务端写出接受，不表示客户端应用已收到或处理。
5. 最终窗口须在上游完整结束后检查，并持久确认写出；随后提交 COMPLETED。未知或不完整结束不发送正常 `[DONE]`。

WINDOW 逐段放行 ALLOW/WARN，保留流内已发现的警告和最高风险以及不含失真位置的证据引用。BLOCK、REQUIRE_REVIEW、MASK、REWRITE、SAFE_RESPONSE 都停止尚未释放的内容。需要完整替换、改写或代答的业务应配置 FULL_BUFFER；已经释放的前缀无法撤回。

响应开始后的错误使用 `event: guard.terminated`，包含错误代码和 `deliveryConfirmed: false`；不发送 `[DONE]`。响应前错误仍使用明确的 HTTP 状态。客户端不能把连接结束等同成功完成。

## 审计、取消与会话

RELEASE_INTENT 和 WRITE_ACCEPTED 绑定同一检测步骤、动作、摘要及绝对区间。已写区间必须连续；保留尾部不能借用前一决定释放。COMPLETED 必须引用最终窗口的写出记录。

客户端中断可能发生在数据库提交后、代理收到确认前。内部契约 `terminalReconciliation` 仅允许单条 TERMINATED；数据库在请求行锁内读取真实序号并完成终止，禁止用此通道发送内容、释放内容或补造 WRITE_ACCEPTED。对已终结请求的终止重试不会改变原结果。

会话历史按业务请求每方向提交一次。输出正文从 WRITE_ACCEPTED 对应的已批准区间重建；重叠上下文不会重复进入历史，重复风险引用不会逐段累加。仅有 RELEASE_INTENT 而未确认写出的区间属于不确定状态，不能伪称客户端接收成功。

## 工程验证

`scripts/integration/check-gateway-v2-window.mjs` 使用真实 Java、Next.js、PostgreSQL、双向 TLS 与可暂停的合成上游，覆盖实际结束前写出、跨段阻断、脱敏要求终止、上游截断、工具字段、资格撤销、取消确认竞态、检测重放、异文冲突、旧区间重放、提前完成与终止权限扩大。

证据保存在 `acceptance/gateway-v2/evidence/2026-09-07/window-evidence.json`。这不构成真实模型独立质量、生产硬件性能或长期可用性认证。
