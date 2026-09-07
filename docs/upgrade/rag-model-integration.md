# RAG 检索与实际模型调用

统一 Java Chat 入口支持 `guard_rag` 扩展。客户端只提交已登记来源 ID 和检索限制，不提交主体、角色、密级、信任标记或已批准上下文。

```json
{
  "model": "configured-route",
  "messages": [{ "role": "user", "content": "请查询已授权资料中的服务时间" }],
  "stream": false,
  "guard_rag": {
    "sourceIds": ["registered-source-uuid"],
    "maximumCandidates": 5,
    "minimumTrustLevel": 20
  }
}
```

`sourceIds` 必须为真实登记的 UUID，最多 20 个；`maximumCandidates` 默认 5、最多 20；`minimumTrustLevel` 范围 0–100。查询由最后一条用户消息提取，最大 32768 个字符。展开后的全部输入仍受网关输入总预算和消息数量限制，超限拒绝，不截断为“已覆盖”。

控制端在读取对象前使用当前身份执行租户、应用、主体、角色、密级和来源状态过滤。对象须已接受、分片完整、未过期，分片和整体大小及摘要必须匹配。引用经过 RAG 检测，并复核来源签名、版本及对象与 ACL 绑定后，才可构造发往模型的请求。

来源以单独的 user 消息传入，其内容为包含来源 ID、块 ID、版本及原文的 JSON 数据，标记 `instructionCapability: FORBIDDEN`。在内部检测协议中对应 `sourceType: RAG` 和 UNTRUSTED/FORBIDDEN 来源封套，不提升为 system 或 developer 指令。`guard_rag` 控制字段不会发给模型。

原始客户端请求摘要与展开后的请求摘要分别绑定 AuthContext。Java 核对服务端签名、展开请求摘要、完整输入段摘要及各段文本/角色/路径后，才进入共用输入检测和模型调用路径。输入复检保留 RAG 来源属性。整个请求使用首次选定的同一制品，派生检索通过指定制品 ID 验签加载，不重新随机选包。

每个特权边界重新检查当前主体、来源与对象绑定。来源 ACL、版本、状态或对象有效期在调用中改变，会阻止后续检测、发送或输出释放。独立 `/api/v1/guard/rag/retrieve` 的返回证明可用于验证检索结果，但不能作为绕过统一网关的模型调用许可。

RAG 检索审计的 requestId 与 gateway_requests 的业务 ID 对应，证明包含主体、制品、上下文 HMAC、来源/对象 ID、绑定摘要、签名与有效期；不包含来源正文。业务请求的处理上下文采用现有加密回执保存，遵守已有清理策略。网关发送记录证明实际模型调用发生，不能把仅有检索证明的请求标为已调用模型。

当前接口按明确来源集合检索已登记的块，不声称具备外部向量数据库或搜索产品的联合认证。查询或上下文需要转换、审核或阻断时会拒绝这次 RAG 调用；不会原样转发要求修改的内容。真实语义召回质量、答案事实一致性及第三方系统验收须分别提供证据。

本机隔离证据包括 11 项检索测试和 7 项真实 Java → Node → PostgreSQL → 对象接收器 → 合成模型测试。后者验证真实收到的消息、签名绑定、ACL 零读取、注入零模型调用、对象篡改、身份伪造拒绝、运行中撤销和幂等重试。对象接收器和模型均为合成夹具，不代表真实模型质量或生产 S3 认证。

证据：`acceptance/gateway-v2/evidence/2026-09-07/rag-model-evidence.json`。
