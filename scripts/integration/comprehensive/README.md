# 全面自动化修复验收

单入口在新数据库、对象桶、合成账号和独立结果目录中执行真实浏览器、HTTP、PostgreSQL、对象存储和解析器验收。需已安装 pnpm、Node、Python、Playwright Chromium，并启动专用 PostgreSQL（5438）和 MinIO（59000）。生产端口 58082 不参与。

## 运行

```powershell
$env:COMPREHENSIVE_ANALYZER_IMAGE = '已准备的解析器镜像标签'
$env:COMPREHENSIVE_PYTHON = 'python'
pnpm test:comprehensive .artifact-build/已有私有配置目录 .artifact-build/新的独立结果目录
```

第一个目录提供 environment.private.json，包含专用测试数据库和对象存储配置；不得提供生产配置。initialize 创建 guardllm_integration_full_时间戳 数据库，生成新测试令牌。第二个目录必须不存在且位于 .artifact-build 下。58089/59090 被占用时立即失败。构建使用 .next-comprehensive-build，主站 production、Worker 测试环境分别记录。

执行顺序：初始化与全部迁移 → 合成账号 → 解析器与应用构建 → 单元测试 → 9 个 Worker → schema/事务/轨迹 → 45 格式夹具 → 页面和业务流程 → 原文与反馈审批 → 安全边界 → 上传与解析终态 → 大文件分层证据 → 180 天查询 → 独立主体注销 → 故障恢复 → 发布门槛 → 清理与汇总。

注销使用专用合成主体；业务主体会话不被撤销。认证和导出测试保留产品限流，收到限流时按 Retry-After 等待并输出进度。不得调高配额使验收通过。

## 结果与退出码

- 0：本轮全部验收通过；1：有执行或业务失败；2：无执行失败但存在依赖阻塞。
- commands.json 保存每个命令的退出码；run-result.json 保存本轮总体结果；source-identity.json 冻结源码、配置和测试指纹。
- 各阶段 JSON 记录真实断言。aggregate.json 保留稳定 testID/project 的尝试；可合并多个独立目录，但跨重跑成功不能替代单次完整成功。
- 解析器可用、上传接受、语义检测完整、生产模型资格和质量指标分别判断。缺少真实 ASR/VLM 等适配器必须 BLOCKED；INCOMPLETE 不算安全。
- archive-boundaries 只证明合成时间戳的 180 天查询和分页，不证明生产历史内容完整性。合成归档元数据标 GAPPED，关联撤销且无效的快照，从不激活。
- 质量门槛保留 FPR≤1%、FDR≤10% 及召回等约束；缺少独立双人标签或真实模型资格时不得输出达标结论。

## 证据和清理

所有 *.private.json、*.private.env、*.private.log、浏览器会话、下载和原始 trace 都留在忽略目录，不提交。公开报告仅复制经字段筛选的汇总。

stop.mjs 校验 PID 的创建时间、命令行及解析器容器标签，只停止本次启动的服务。保留专用数据库、对象桶和原始失败证据。停止或恢复失败必须导致整体失败，不批量删除数据库、Docker 容器或旧结果。

gateway-stack.mjs 是既有独立 gateway-v2 环境的辅助工具，不属于本入口的生产主站验收。J29/J30 为观察项，不列为通过。mock Playwright 测试与真实服务结果分开统计。
