# GuardLLM 安全增强 P1 执行记录

> 阶段：P1——统一风险合同、词典、模板和审计底座
> 执行日期：2026-09-04
> 分支：`codex/security-hardening-v1`
> 基线提交：`b6643c5`
> 结论：**内部工程门禁通过；生产词库准入按设计保持阻断。**

## 1. 阶段结论

P1 已完成风险请求/响应合同扩展、词典与模板治理数据模型、签名策略包融合、精确作用域白名单、最小化证据和高优先级完整性事件。合同保持向后兼容，TypeScript、Python、Go、Java、OpenAPI、Proto 生成物一致；本地 PostgreSQL 已应用增量迁移。

候选内容安全词库仅用于开发和 SHADOW 评估。它没有被提升为 ACTIVE，也没有进入在线生产策略：当前只有 63 个候选词条，生产有效词条为 0，缺少正式签名审批且未达到不少于 10,000 条及 A.1/A.2 分项规模门槛。生产校验返回 21 个预期错误，证明门禁有效。

## 2. 计划条目完成情况

### P1-01 统一输入输出合同

- 请求 context 已覆盖追踪、租户/应用/会话、方向、来源类型、语言、法域、行业、截止时间、策略包和 Tokenizer 信息；新增字段保持 optional。
- 内容 envelope 已覆盖来源与信任、指令能力、父级关系、模态、制品、页码、时间区间、区域和内容摘要。
- Finding/Observation 已增加风险类别、置信度、规则/词典追踪和规范化偏移；Decision 已增加降级信息、原因码、策略路径和延迟分解。
- TypeScript、Python、Go、Java、OpenAPI、Proto 已由生成器同步，未手工编辑 generated 文件。
- 兼容性检查确认 Guard v1 与已接受基线向后兼容。

### P1-02 词典、模板和反馈数据模型

- `keyword_rules` 增加 release、规范词、变体、语言、方向、行业、上下文、严重度、mandatory deny、有效期、owner 和证据要求。
- 新增不可变 `dictionary_releases`、append-only `dictionary_release_transitions`、审批后内容不可变的 `response_templates`、`detector_calibrations` 和不含原文列的 `badcase_feedback`。
- `guard_session_risk_states` 增加风险向量、近期风险、升级等级和最后请求标识。
- 新增治理表全部绑定租户—应用组合外键；词典迁移、回滚和关键词 release 引用只能指向同一租户与应用。
- 集成用例对 7 类跨租户组合/引用执行负向断言，并检查 8 个关键作用域约束存在。
- `0037`、`0038` 支持重复执行；在修复 `0030` 的既有重复约束问题后，全部 40 个初始化/迁移脚本也可连续完整重放。
- 仓库声明的持久化实现为 PostgreSQL/Drizzle；未引入并不存在于项目中的 Prisma/SQLite 双轨模型。

### P1-03 策略包统一治理

- 词典 manifest、受治理规则、检测器阈值、响应模板、模型摘要、Tokenizer 摘要和失败策略进入 canonical payload。
- 保留旧签名载荷的字节级行为：解析旧 payload 时不会注入无签名默认字段，旧格式重新签名后仍可验签。
- 编译阶段拒绝非法/高风险正则、重复项、选择器冲突、缺少 owner/证据、无效或过期规则、未审批模板和摘要不一致。
- 普通白名单必须具备审批、目标规则、方向、具体维度和有效期；只豁免被覆盖的精确命中片段。平台 mandatory deny 永不被白名单压制。
- 在线加载固定已验签 Bundle generation；schema 或签名错误先记录最小化完整性事件，再 fail closed。
- 策略发布继续使用 PostgreSQL advisory transaction lock、生命周期版本和 application binding generation，避免并发编译/切换混版；管理 API 与灰度操作按计划在 P5 完成。

### P1-04 审计与最小化证据

- 新增完整性安全事件映射：审计链断裂为 CRITICAL/QUARANTINE，策略摘要不一致为 CRITICAL/FAIL_CLOSED，模板复检失败为 HIGH/SAFE_RESPONSE fallback。
- 事件属性只保存失败码、对象标识、generation 和证据摘要，显式标记 `rawContentStored=false`，不保存客户原始正文。
- `badcase_feedback` 仅保存请求摘要和 evidence HMAC；集成测试拒绝出现 `raw_content`、`raw_text`、`input_text`、`payload` 等原文列。
- 词典 release、状态迁移和已审批模板由触发器保护为不可删除/不可篡改；API 请求级审计继续进入现有 HMAC append-only 审计链。

## 3. 自动化验证结果

| 门禁 | 结果 | 关键证据 |
|---|---:|---|
| `pnpm contracts:check` | PASS | source hash `2da2dcd7e08805684ff47b35f29d160f2d583db74671af14c64f4a86b7911962`；向后兼容 |
| P1 目标单测 | PASS | 25 个测试文件，95/95 |
| 全量单测 | PASS | 131 个测试文件，561/561 |
| `pnpm ts-check` | PASS | 0 个 TypeScript 错误 |
| `pnpm lint:build` | PASS | 全仓 ESLint error 数为 0 |
| 空库完整迁移 | PASS | 40 个脚本；17 个关键关系；8 个治理作用域约束 |
| P1 迁移重复执行 | PASS | `0037`/`0038` 连续执行 2 次，均通过全部隔离/治理断言 |
| 全历史重复执行 | PASS | 修复 `0030` 后，40 个脚本连续完整重放 2 次通过 |
| 当前本地数据库升级 | PASS | `0038` 已增量应用；只读查询确认 8/8 作用域约束 |
| 词库来源完整性 | PASS | 3 个来源、9 个文件，大小与 SHA-256 全匹配 |
| 候选导入 | PASS | 1,156 个外部候选；全部保持非生产候选状态 |
| 开发词库校验 | PASS | 40 个风险定义、63 个候选条目、12 个例外规则；31/31 GB/T 风险已定义 |
| SHADOW 编译 | PASS | 155 条影子规则、10 条目标作用域例外；2 条非词法控制未错误编译 |
| 难负样本评估 | PASS | 44/44；覆盖精确豁免、第二处危险命中、过期和方向边界 |
| 生产词库校验 | EXPECTED BLOCK | 21 个准入错误；0 个生产有效条目、无正式签名审批、规模不足 |
| `git diff --check` | PASS | 无空白错误 |

## 4. 关键制品摘要

| 制品 | SHA-256 |
|---|---|
| `drizzle/0037_targeted_whitelist_rules.sql` | `a63fe2e72d11117ed3602f02c0d6bb3b5b6324003338147185ee164502f3eefd` |
| `drizzle/0038_policy_governance.sql` | `beb242c4e1fdc0290537cb772b157339899855c23dc3c6d8aa041c6472c04194` |
| `packages/contracts/model/guard-v1.schema.json` | `2da2dcd7e08805684ff47b35f29d160f2d583db74671af14c64f4a86b7911962` |
| SHADOW Bundle 文件 | `4ad954769f73a7294f901e9b37c81fd97fb4179d8b97ae57ceba867bce764999` |
| 难负样本集 | `1ed456bd2d0f86d54681301de920e36bdf77afdcbdd8abd3201e01acc4aa1741` |

SHADOW 报告记录的 canonical bundle content hash 为 `c91c3ec0ea25667f87a6b411d7207eb8ad0cca021ee89efe8af4302b664c064b`。

## 5. 真实阻塞与后续阶段边界

以下不是内部代码失败，不得通过修改状态或伪造签名绕过：

1. 生产词库仍需内容安全、法务和数据治理人员完成逐条审核、来源许可确认和双人审批。
2. 生产基线需达到不少于 10,000 个 ACTIVE/EMERGENCY 条目，并满足 A.1 每类至少 200、A.2 每类至少 100 的分项门槛。
3. 生产 release 需生成正式 `content_sha256`、Ed25519 签名、签名 key id 和具名审批记录。
4. P2 将增强多视图规范化、混淆还原和文本攻击检测；P4 完成模板渲染、DLP 和变换后二次复检；P5 完成词典/模板管理 API、页面、权限、灰度和回滚操作面。

## 6. 阶段判定

P1 内部代码、合同、数据库、词库供应链和回归门禁全部通过，可以进入 P2。生产词库维持 fail-closed 准入阻断，不能据此宣称 10,000 条正式内容库已经完成或上线。
