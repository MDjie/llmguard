# 质量与性能验收工具

本文件实现升级设计 U11/U14 的测量与证据门槛。独立数据、真实模型、指定硬件和第三方系统均未由用户提供，目前不得声明语义质量、标准吞吐、1000 条流或 24 小时长稳达标。

## 独立质量报告

`scripts/content-safety/gateway-quality-report.ts` 复用现有标注工作台：重新验证独立人员的 Ed25519 标注签名，拒绝 synthetic 数据进入锁定质量集，检查冻结先于执行。只使用 test 分区；每个基础组预先固定一个主案例，所有测试组都必须出现，三种对照均只接受第一次结果：

| 对照 | 用途 |
|---|---|
| BASE_MODEL | 单独观察业务模型拒答和任务完成率 |
| RULE_DLP | 固定规则与 DLP 策略的效果 |
| FULL_GATEWAY | 完整双向检测和实际动作执行效果 |

执行结果使用 `gatewayQualityCampaignSchema`，含部署、业务模型 revision、tokenizer、策略、分类器资格、环境和证据摘要。评估脚本不调用模型、不上传数据、不替人签字。三组结果应由已授权的实际运行器采集，并另外进行可信执行证据审定。报告本身不会签发模型资格或启用生产 ENFORCE。

```powershell
pnpm exec tsx scripts/content-safety/gateway-quality-report.ts --workbench <signed-workbench.json> --reviewers <trusted-reviewers.json> --campaign <three-arm-campaign.json> --out <new-quality-report.json>
```

默认要求至少 2000 个独立攻击组、2000 个正常业务组、1000 个经签名复核的 DLP 实体实例。DLP 主案例带 `dlp-entity` 标签，单案例使用一种实体风险类型，预期位置来自签名标注的 UTF-16 区间；正常样本上的多余实体也计误报。报告重算 Wilson 95% 区间，分别呈现模型拒答、网关实际防护、正常硬阻断、误干预、UNKNOWN/失败、任务完成率变化、风险家族与语言分组。UNKNOWN/失败不从召回分母删除。样本不足为 INSUFFICIENT_EVIDENCE，指标违反为 FAIL。

## 非流式 G0/G1/G2

冻结规格在 `acceptance/gateway-v2/performance-profiles.json`；旧 `acceptance/performance-requirements.json` 保留。每次使用独立输出文件，先预热 600 秒，再进行 3 轮各 1800 秒测量。可将到达率冻结在目标的 100%～120% 以测量目标成功吞吐；不得因拒绝或漏发下调成功吞吐目标。

私有客户端 JSON 的字段为 `endpoint`、`apiKey`、`model`、`caFile`、`certificateFile`、`keyFile`、`targetVersion`、`configurationDigest`。`targetVersion` 正式验收必须是 `sha256:<64 hex>` 的不可变交付摘要。该文件含密钥，不能放入报告或版本库。

```powershell
node scripts/acceptance/gateway-v2-load.mjs --environment <private-client.json> --output <new-round.json> --profile G1 --seconds 1800 --rps 550 --concurrency 128
node scripts/acceptance/gateway-v2-latency-join.mjs --report <new-round.json> --upstream <controlled-upstream-timings.jsonl> --output <new-joined-round.json>
```

负载按计划到达时间产生，达到并发或样本写入上限时记录 omitted，不无限排队。成功必须是有效业务响应、ALLOW/WARN 和合法结束状态；HTTP 200 安全代答不算成功。每次请求的耗时、状态、动作写到 JSONL，不保存文本和凭据。输出大小不符单列失败条件。

耗时关联器使用磁盘 SQLite，逐请求连接客户端与上游计时，然后计算“客户端耗时 − 对应上游处理耗时”的分位数。拒绝重复 ID、缺失计时和不可能的时长，记录原始文件 SHA-256；不拿两个独立 P99 相减。上游计时只包含受控上游处理及其写出边界，网关其他网络和检查开销仍计入新增耗时。

`gateway-v2-performance-gate.mjs` 对经审核签名的环境档案执行正式门槛：

```powershell
node scripts/acceptance/gateway-v2-performance-gate.mjs --evidence <signed-performance-evidence.json> --key <trusted-cosign-public-key.pem> --output <new-gate-report.json>
```

沿用 `scripts/acceptance/evidence.mjs` 的证据格式和 cosign 验签，id 为 `GATEWAY-V2-PERFORMANCE`。`performance` 指向已列入 artifacts 并校验摘要的 `profile`、`warmup`、`rounds` 和 `attestation`；客户端及上游 JSONL 也必须在签名 artifacts 清单中。环境证明包含精确 CPU/GPU、镜像、配置、策略、双向检测与持久确认语义。G2 同范围继续采用旧 P99≤300ms；不同范围须有签名范围映射。单剖面通过不代表质量、HA、SSE、月度 SLO 或长稳通过。

本机首次 30 秒 G1 工程试跑：59 个成功、0 个拒绝、0 个失败、1 个 omitted；加载使用 Next.js 开发服务、2 RPS/4 并发，新增 P99 约 2065ms。这次结果保留，不能作为 G1 容量判断或达标证据。

## SSE 传输与长稳

```powershell
node scripts/acceptance/gateway-v2-sse-load.mjs --environment <private-client.json> --output <new-sse-report.json> --seconds 1800 --connections 1000 --stream-seconds 30
```

受控上游识别 `GATEWAY_SSE_BENCHMARK <requestId> <seconds>` 并产生每秒 20 个 32 字节片段。每个业务请求最长 45 秒，在现有 60 秒授权预算内循环建立流；总持续时间可设至 86400 秒。统计实际 TLS 连接活动时间、峰值与时间加权连接数，逐流验证结束标记、动作及完整字节数。网关可按批准窗口重分段，客户端片段数和首末内容时点单独记录，不伪称与上游事件一一对应。

客户端解析器有界，拒绝缺 DONE、无效 UTF-8、异常工具字段、非成功结束、内容改变及重复结束。压测结果默认 ENGINEERING/INSUFFICIENT_EVIDENCE，正式双节点并发仍需上游节拍、负载生成器资源、窗口资格、节点硬件和三轮/长稳证据。

已在隔离 JAR → Next.js → PostgreSQL → mTLS 合成模型链路验证 2 个连接、6 个完整流、0 失败/拒绝。这只证明压测工具与实际链路可运行。
