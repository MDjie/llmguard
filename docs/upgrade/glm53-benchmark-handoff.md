# GLM-5.3 基准测评交接

日期：2026-09-08；分支 main；修复前对照基线 082d09a。联合裁判、媒体变换和验收工具分别提交为 d9e7e62、74ea1d4、5398f37；测评时使用包含本交接文件的后续 main 提交。按用户最新要求停止扩展大型功能，先准备测评。

## 模型与接入

联合裁判目标固定为 glm-5.3。用户指定“智谱企业 Token Plan”；企业合同对应的 Base URL、可用模型与凭据引用尚未取得，模板中的 .invalid 地址故意不可调用。不要用本文件代替实际企业接入说明，也不要把 Coding 套餐端点自动替换成按量 API 端点。

2026-09-08 核对的官方资料：

- [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)：仅支持文本；必须启用思考；支持 reasoning_effort=low/high/max。此次配置 enabled + low。
- [套餐 FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq)：Coding Plan 的 OpenAI 兼容端点为 https://open.bigmodel.cn/api/coding/paas/v4；自建应用使用标准 API，不能据此宣称本服务会扣 Coding 额度。
- [团队版](https://docs.bigmodel.cn/cn/coding-plan/team)：企业套餐权益以该账户及合同为准。
- 标准 Chat Completion 端点为 https://open.bigmodel.cn/api/paas/v4；只有账户明确采用该服务时才填写。

现有 .env/.env.local 未发现 GLM/联合裁判配置键。未修改生产配置、未使用真实密钥调用、未发布策略。模板只含 secretRef 占位符，不能填写明文密钥。

## 已收尾的关键修复

1. 图文、音视频及 native_joint 任务接入 GLM-5.3 的派生证据联合裁判。
2. 来源摘要、上下文、UTF-16 命中位置与配置摘要绑定；旧来源或旧配置判定不能复用。
3. 拒绝替代模型、截断回复、元数据位置及不完整响应；SHADOW 不改变业务动作，ENFORCE 失败进入复核。
4. 禁用 GLM-5.3 的思考会在配置校验时拒绝。模型及联合提示词的正式质量批准必须重新取得。
5. 工程测试与目标模型质量分开记账。GLM 的文字证据判定不代替原始媒体全量检测。

当前媒体 worker 的原始 OCR/ASR 派生文本仍按 privateOnly 处理；云端配置不能自动突破该边界。先用允许外发的合成或公开文本开展隔离测评。客户媒体样本进入企业云前，需要明确授权及脱敏后的来源映射；这部分不在本轮快速收尾中放开。

## 开始测评的顺序

### 1. 冻结测试输入

准备独立测试目录，例如 .artifact-build/glm53-benchmark/<run-id>。记录 git commit、工作区补丁、模型与提示词配置摘要、原始数据摘要、样本分组、规则策略摘要、端点及预算。代码存在未提交改动时，必须保留补丁和源文件摘要；不能仅用 082d09a 代表本轮被测代码。

复制 examples/glm53-enterprise-profile.json，填入已存在的 tenant/application/provider、企业实际 Base URL、dataBoundaryPolicyId 和 scoped secretRef。先保持 SHADOW。正式评测需将独立测试副本 enabled=true，生产开关不变。不要带入旧版本 qualityEvidenceId/qualityValidUntil。

已有作用域配置可用以下命令生成迁移草案：

```powershell
pnpm joint:prepare-glm --profile <现有配置.json> --out .artifact-build/glm53-benchmark/profile-draft.json
```

### 2. 合成连通性检查

```powershell
pnpm detection:judge-selftest --profile <实际配置.json> --allow-network yes --out <新的selftest.json>
```

使用固定合成文本测试协议。只证明端点、鉴权、JSON 和模型协议可用，不证明金融或多模态识别质量。该命令会调用配置端点；当前尚未执行。

### 3. 小批量单裁判基线

profiles.json 为配置数组；cases.json 遵守 detectionCaseSchema。数据校验命令读取 JSONL；应从同一冻结数组导出 cases.jsonl 进行校验，模型测评仍读取原 JSON 数组。先用 20—100 条已获使用许可的样本，每个原始样本及其变体只属于一个 split。云端样本必须 authorizedExternalUse=true；不得为了运行而修改未授权客户样本的标记。

```powershell
pnpm detection:dataset-check --help
pnpm detection:evaluate-candidate --profiles <profiles.json> --cases <cases.json> --budget docs/upgrade/examples/glm53-benchmark-budget.json --allow-network yes --out <新的run.json>
```

预算模板限制 100 条、100 次调用、100 万预留 token、串行及 30 分钟。先确认套餐剩余额度，按实际风险范围减小预算；预留 token 不是已计费 token。

### 4. 规则与裁判的成对对照

沿用已有 detection:eval-compare，对同一冻结数据与策略运行 B0/B1/S1/H1，比较既有策略、候选规则、裁判（保留 mandatoryDeny 硬约束）及联合机制。先查看命令帮助；完整对照含 first/warm/concurrent 三轮、每轮四变体，预算须覆盖所有调用，不能沿用单模型 100 次预算后删掉耗尽样本。

```powershell
pnpm detection:eval-compare --help
```

记录各风险召回、精确率、误拦截率、未知/超时率、P50/P95、token 用量和调用失败。失败、未知及超时留在分母，不能当作安全。first 仅为首次观测，不宣称模型冷启动；warm 也不代表缓存命中已被验证。

### 5. 多模态与金融专项

普通文本评测不能代替联合媒体评测。联合专项须通过 native_joint 任务的实际 OCR/ASR/字幕来源与 GLM 证据映射，覆盖同模态、跨模态拆分、跨轮次、原件替换与信息隐藏；原生检测资格单独评估。独立金融金标沿用现有签名工作台，24 术语候选和 48 配对工程样本不作为正式质量证据。

## 本轮保留项

原生输出的一次性业务释放、客户媒体云端外发治理、真实模型质量、金融独立金标、目标存储恢复、HA/容量/24 小时长稳暂不扩展。输出变换服务与复检校验已有工程实现，但 Java 代理仍隔离原生输出。上述项目不计为完成验收。

验收清单使用 pnpm acceptance:v11。缺少签名证据或冻结 POC 权重时返回 INCOMPLETE 是预期结果，不能改成通过以便开始测评。
