# P1-2：L3 候选到 L4 Judge 最小契约

日期：2026-09-10

## 交付范围

本交付只提供可选的本地 DAG 路由和离线夹具，不修改现有生产策略装配，也没有启用或调用任何线上 Judge。

- `withCandidateJudgeDetectorDag(dag, candidateNodeIds, profiles)` 新增 L4 节点，并只依赖明确指定的候选生产节点。
- 新运行条件 `WHEN_PARENT_CANDIDATES`：直接父节点存在 `decisionRole: CANDIDATE` 才运行；同时检查本次已完成节点中的 `MANDATORY_DENY` / `HARD_DENY`，存在时必定跳过 Judge，即使 L3 也产出了候选。
- `judgeCandidateFunnel: { enabled: true }` 是显式策略开关。无候选时 L4 被跳过，不把“有意跳过”误判为 Judge 覆盖缺失；有候选时仍强制要求精判结果完整。
- Judge 调用/解析失败保持节点 `failurePolicy: DEGRADE`，并写入 `failMode: DEGRADED` 与 DAG 降级原因。候选未被清除时聚合结果为 `REQUIRE_REVIEW`，不会放行为 `ALLOW`。
- `GuardEvaluationTrace.nodes` 增加结构化审计字段：`tier`、`runCondition`、`candidateInput`、`failurePolicy`、`status`、`attempts`、`reason`。Judge 已有的模型版本、配置摘要、风险、证据字段保持不变。

## 验证

离线夹具覆盖四条边界：

1. 无候选：不调用 Judge，结果 `ALLOW`，L4 trace 为 `SKIPPED`。
2. L3 候选：仅此时调用一次 Judge；完整 `SAFE` 清除候选。
3. 强制拒绝与 L3 候选并存：不调用 Judge，结果 `BLOCK`。
4. Judge 抛错：结果 `REQUIRE_REVIEW`，包含 `configurable-judge:unavailable` 降级原因。

执行命令：

```powershell
pnpm exec vitest run tests/guard-engine-v2/candidate-judge-funnel.test.ts tests/guard-engine-v2/configurable-judge.test.ts --maxWorkers=2
pnpm exec tsc --noEmit --pretty false
```

结果：2 个测试文件、19 项测试全部通过；TypeScript 检查通过。

## 在线验证状态

本回合没有调用 DeepSeek 或任何远程 Judge，也没有读取或输出 API Key。因此本交付只证明本地契约与降级路径。真实连通性应在明确选定已审批的 Judge profile 后，以一条脱敏候选夹具单独执行，并将 provider、模型版本、响应摘要和调用计数写入独立审计工件。

## 未覆盖边界

- 未测量真实 provider 的延迟、限流、重试及费用。
- 未进行人工金标 Judge 一致性评估，不能据此将 L4 结果提升为生产放行依据。
- 多个候选风险与 Judge profile 风险集合部分重叠时，未覆盖的候选仍将保留为 `REQUIRE_REVIEW`；该行为符合保守降级，但需要后续策略配置评审。