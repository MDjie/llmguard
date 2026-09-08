# 全面自动化测试后的 Codex 精准修复方案

版本 V1.0｜2026-09-08｜基线：本地 main 工作区 / HEAD 13b36f8。

本方案已进入**修复实施及真实服务验收**，不再是待执行方案。逐项状态及证据见 [33_codex-repair.tasks.v1.json](./33_codex-repair.tasks.v1.json)。工程验证、真实模型资格、独立质量指标分别验收；存在未验收依赖时不标全部完成。

测试依据：[全面自动化测试报告](../测试报告/2026-09-08/comprehensive-13b36f8/全面自动化测试报告_V1.0_2026-09-08.md)；[机器结果](../测试报告/2026-09-08/comprehensive-13b36f8/execution-summary.json)。

## 1. 给 Codex 的执行约束

1. 在用户指定的 main 分支工作。先记录 `git branch --show-current`、`git rev-parse HEAD`、`git status --short`；若基线已变化，重新核对相关实现和缺陷，不覆盖用户改动，不 reset/clean，不强推。
2. 仅使用 pnpm。修改 Next/React 页面前读取项目 AGENTS.md 和本地 Next 文档。沿用 TypeScript strict、共享 schema、shadcn/ui；禁止 any 绕过契约。
3. 本轮报告中的环境和工程样本只用于开发验收；禁止把临时签名、合成分类器或过期资格转换为生产批准。
4. 每项任务先复现并保存失败证据，再修改，最后执行定向测试和相关真实服务回归。记录“失败原因→修改文件→命令/退出码→结果→遗留项”。
5. 作用域强制限制到 localhost 专用 `guardllm_integration*` 数据库和明确隔离服务。禁止对生产 58082 或不明数据库运行初始化/删除/清理测试。
6. 不向文档、提交或测试报告写入口令、Cookie、API key、带签名 URL。不要 `git add .`。生成文档/测试并不自动包含推送权限；按当前会话授权和实际工具审批完成 Git 操作。
7. 不降低误报/漏报/审批/SSRF/租户隔离标准。不能用捕获 500 返回空数组、移除断言、扩大白名单、提高限流阈值解决测试失败。
8. 如新证据表明某项已修好，可按同样断言复核后关闭；不可仅因单元测试通过、上传接受、接口 202 或页面存在就标完成。

## 2. 依赖与执行顺序

先执行 FX01，阻断数据继续被错误写入；再执行 FX02。随后按 FX03/FX04/FX05/FX06 完成治理与接口链，FX07/FX08 修复表单与布局。FX09 形成可靠的一次性全量回归，FX10 补完整服务依赖，FX11 验证所有此前阻塞的生命周期；最后 FX12 执行独立质量验收。

FX03、FX07、FX08 技术上可独立进行，但自动化操作与登录/退出、数据库夹具应串行或使用不同主体/独立作用域，避免本轮出现过的共享会话撤销。此处不要求额外创建任务或代理。

| 任务 | 优先级 | 目标 | 前置 |
|---|---|---|---|
| FX01 | P0 | 修复兼容数据库层写入分派并使策略写入原子化 | 无 |
| FX02 | P1 | 补齐 12 个缺失字段及新旧表结构兼容迁移 | FX01 |
| FX03 | P1 | 统一运行时 assurance 契约并恢复策略发布页面 | 无 |
| FX04 | P1 | 修复原生 SQL 日期与分布式限流回退 | FX02 |
| FX05 | P1 | 补齐白名单治理表单和受控审批流程 | FX01, FX03 |
| FX06 | P1 | 统一导出查询并完成双人审批与下载闭环 | FX02, FX04 |
| FX07 | P2 | 修复个人资料空白字段与权限语义 | 无 |
| FX08 | P2 | 修复验证集移动布局并补响应式操作回归 | 无 |
| FX09 | P1 | 固化可重复的全模块浏览器验收与可靠测试判定 | FX01, FX02, FX03, FX04, FX05, FX06, FX07, FX08 |
| FX10 | P1 | 完善运行环境预检、后台服务健康与可恢复夹具 | FX02, FX04 |
| FX11 | P1 | 补齐真实多模态、归档与治理生命周期的端到端矩阵 | FX05, FX06, FX09, FX10 |
| FX12 | P1 | 保留独立质量门槛，完成修复后再启动基准验收 | FX09, FX11 |

## FX01｜修复兼容数据库层写入分派并使策略写入原子化

优先级：P0；对应缺陷：D01；关联 32 号补充任务：R12。

修改范围：

- `src/lib/db.ts`
- `src/app/api/policies/route.ts`
- `src/app/api/policies/[id]/clone/route.ts`
- `src/app/api/policies/[id]/route.ts`
- `src/app/api/policies/[id]/keywords/route.ts`
- `src/app/api/policies/[id]/keyword-categories/route.ts`

实施步骤：

1. 为 QueryBuilder 增加唯一的 executeOperation 分派入口；then、single、maybeSingle 全部使用该入口。single 的读取数量语义与写入 returning 的唯一行语义分别规定，禁止调用执行器两次。
2. 覆盖 insert/update/delete + select + single/maybeSingle，保留 snake_case 映射、租户作用域和错误码。读取不存在时 single/maybeSingle 的差异需与现有调用点统一，不能默默改所有接口语义。
3. 审计报告列出的 17 个 single 调用；识别实际写链与只读链。策略创建/克隆/关键词分类及快照等有多个写步骤的路径改为同一事务，任一步出错即回滚并返回非 2xx；清缓存必须在提交后。
4. 新增只读数据核对脚本：按租户+应用+policy_id+dimension 枚举重复规则，关联创建时间/审计事件。先生成 dry-run 修复清单，保留人工差异；本轮 49 条规则只是隔离库证据，不得照抄到生产进行无差别删除。
5. 如果增加复合唯一约束，先处理历史冲突并在文档说明业务上确实只允许一行的维度；不可通过保留任意一条规则消除错误。

必须执行的验证：

- 新增 tests/database/compatibility-mutations.test.ts，验证写分派仅一次与 returning。
- 新增 scripts/integration/comprehensive/policy-mutations.ts，在隔离 PG 验证创建、克隆、类别、关键词、更新返回值与持久化一致；注入子步骤失败验证无残留。
- 重跑 J02，并断言返回 ID 不等于旧默认策略 ID、重载可见、新策略各维度最多一条、旧策略 hash/规则数不变。

完成标准：

- 创建成功必须产生新记录；失败不得污染既有策略。
- 同租户不同应用/异租户的读取及修改仍拒绝。
- 错误响应不含 SQL 凭据或内部参数。

## FX02｜补齐 12 个缺失字段及新旧表结构兼容迁移

优先级：P1；对应缺陷：D05；关联 32 号补充任务：R10, R12。

修改范围：

- `src/storage/database/shared/schema.ts`
- `scripts/init-database-new.sql`
- `scripts/init-database-supplement.sql`
- `drizzle/（新增下一序号迁移）`
- `docker-compose.yml`
- `scripts/integration/run-database-tests.mjs`
- `scripts/integration/comprehensive/schema-parity.ts`
- `src/app/api/agent-logs/route.ts`

实施步骤：

1. 以 schema-parity.json 为初始差异清单，核对 agent_traces 8 字段与 judge_model_invocations 4 字段。新增迁移前重新检查 drizzle 最大序号，本基线到 0064，不覆盖已有迁移。
2. 设计旧 agent_traces 的 session_id、trace_type、trace_data 兼容方案。旧数据可保留并映射可证明的属性；不能伪造 record/provider 关联。新字段 success 的历史未知语义要明确，不能默认全成功。
3. 补外键、索引、非空和默认值；新写路径不提供旧必填字段时仍能写入。基础初始化、已有库升级、Docker 挂载清单须一致。
4. 将“所有 ORM 表/列存在”加入标准数据库集成检查；再补相关列类型、nullability、约束和新旧样本读写检查，不能只统计数量。

必须执行的验证：

- 新空库应用全部脚本，schema-parity 输出 missing=[]；升级带旧 Agent 行的库后重复执行迁移不失败。
- Agent 列表/分页/详情在空库和有数据时返回 200；真实插入新 trace 成功。
- 裁判调用记录持久化包含 input_hash 与 token 统计；模型失败也可记录真实失败状态。

完成标准：

- 100 张表的 1,598 个当前预期字段对照无遗漏，新增字段后分母从实际源码生成。
- 旧数据不丢失，不能用 DROP TABLE 解决升级。

## FX03｜统一运行时 assurance 契约并恢复策略发布页面

优先级：P1；对应缺陷：D02；关联 32 号补充任务：R01, R12。

修改范围：

- `src/components/policy/policy-runtime-status.tsx`
- `src/app/api/policy-runtime/route.ts`
- `src/lib/policy-governance/`
- `src/contracts/http/（运行时 DTO）`
- `src/app/policy-releases/page.tsx`

实施步骤：

1. 为 API 与 UI 建立共享 Zod/TypeScript DTO，明确 assurance 对象与 null 情况；删除将未校验 JSON 强转 RuntimeSummary 的做法。
2. 分别展示 level、externalApproval 和可解释的 readiness 原因；development-only 就绪不能显示“可用于生产请求”。
3. 错误字段或未知版本显示可恢复错误，刷新可恢复，禁止 React 直接渲染 object 或整个页面白屏。
4. 追加发布页从草稿编译到测试/审批/影子/灰度/回滚的真实状态机浏览器入口，正式激活只在隔离作用域测试。

必须执行的验证：

- 覆盖 assurance 对象、null、未知 level、接口错误和恢复；页面没有 pageerror。
- 真实 /api/policy-runtime 的返回值直接驱动页面；不能仅 mock 成旧字符串。

完成标准：

- /policy-releases 可正常展示，实际 DTO 200 不再导致页面崩溃。
- 生产可用提示与外部资格/签名约束一致。

## FX04｜修复原生 SQL 日期与分布式限流回退

优先级：P1；对应缺陷：D03, D04；关联 32 号补充任务：R01, R12。

修改范围：

- `src/app/api/stats/route.ts`
- `src/lib/api-security/postgres-rate-limit.ts`
- `src/lib/api-security/`
- `src/app/dashboard/page.tsx`
- `scripts/integration/comprehensive/（新增真实 PG 日期与限流测试）`

实施步骤：

1. 区分带列 encoder 的 Drizzle 条件与原生 SQL 参数；聚合 filter 优先使用正确列绑定条件，或显式 ISO 值与 timestamptz cast。禁止靠数据库时区隐式解析本地字符串。
2. 修复限流插入和过期清理的日期参数。检查 executeSql 返回形状，使 count 与 resetAt 正确；保留数据库异常时的明确降级行为和可观测告警。
3. 界面区分数据 0、加载失败、上次成功数据；不要用捕获异常后返回零值伪装恢复。
4. 检索其他原生 sql 模板 Date/new Date 参数，按实际执行器确认，避免盲目把所有 Date 改字符串。

必须执行的验证：

- 实际 postgres 驱动执行当天/昨日/跨日边界统计、空库和有数据聚合。
- 两个独立限流器/应用实例共享同一 PG，交替请求：前 N 次允许，第 N+1 次被拒绝；窗口后恢复；清理不影响当前窗口。
- 数据库健康时不产生 fallback，rate_limit_buckets 有行；故障注入时日志明确标注降级。

完成标准：

- /api/stats 200 且数值可用 SQL 复算。
- 不能通过调高配额/接受 429/关闭限流使测试通过。

## FX05｜补齐白名单治理表单和受控审批流程

优先级：P1；对应缺陷：D06；关联 32 号补充任务：R09, R12。

修改范围：

- `src/app/whitelist/page.tsx`
- `src/app/api/whitelist-rules/route.ts`
- `src/contracts/http/（共享白名单 DTO）`
- `src/lib/policy-governance/`

实施步骤：

1. 表单增加目标规则选择、方向、validFrom、expiresAt；按 policy/application 获取可选项，避免自由输入其他应用规则 ID。
2. 新建与编辑生成 enabled=false 待审批草稿；展示待审批/有效期/目标范围，提供必要的独立审批入口，并遵循现有签名策略发布机制。
3. 将旧“命中后跳过全部检测”描述和无范围全局操作按实际受控例外能力更新；mandatory deny 不得被白名单覆盖。
4. 前后端共用 schema，支持校验错误逐字段展示。过期、目标消失、版本冲突、审批人等于创建人均有明确错误。

必须执行的验证：

- 真实 UI 创建→重载→独立审批→策略编译/隔离发布→目标规则受控影响。
- 到期/方向不符/非目标规则/红线规则仍检测；他人应用 ID 拒绝；审批不直接修改生产绑定。

完成标准：

- 填写完整合法表单可创建草稿；不出现缺 expiresAt 的 400。
- 不删除后端治理字段、独立审批和约束。

## FX06｜统一导出查询并完成双人审批与下载闭环

优先级：P1；对应缺陷：D07；关联 32 号补充任务：R09, R12。

修改范围：

- `src/app/export/page.tsx`
- `src/app/api/export/route.ts`
- `src/app/api/export/stats/route.ts`
- `src/contracts/http/history.ts`
- `src/lib/data-protection/export-approval.ts`
- `src/app/api/（已有导出审批路由）`

实施步骤：

1. 在共享契约中定义时间范围到 startDate/endDate 的转换和统计请求数值 days；明确 UTC/本地日边界，统计与实际导出使用相同动作和时间条件。
2. totalRecords 固定为数值类型；空结果、加载失败、审批等待分别展示。导出量上限不得静默截断成“全部”。
3. 接入申请用途说明→另一授权主体审批→返回审批标识→使用 x-export-approval-id 消费的现有后端流程；查询摘要、申请人、作用域和有效期变化后旧批准不可复用。
4. 按 Content-Type 读取 JSON、CSV、Markdown 与 Problem JSON；浏览器真实下载、文件名和编码正确；失败后恢复按钮，不显示成功。

必须执行的验证：

- 7/30/90 天与全部范围、allow/warn/block/mask/rewrite（按契约可用项）统计/导出一致。
- 无审批 428、同人审批拒绝、过期/查询变更/重复消费拒绝；合法审批下载三种格式，校验数据数、中文、CSV 公式转义和无越权原文。

完成标准：

- 浏览器不再发送 days=30d、dateRange=all 旧字段。
- 导出审批不能在前端伪造、不能为了测试而被跳过。

## FX07｜修复个人资料空白字段与权限语义

优先级：P2；对应缺陷：D08；关联 32 号补充任务：R12。

修改范围：

- `src/components/login/user-profile-modal.tsx`
- `src/app/api/users/[id]/route.ts`
- `src/app/api/users/route.ts`

实施步骤：

1. 统一 null/省略/空白语义：未修改可选字段不发送；用户明确清空时提交契约允许的 null。
2. 表单明确合法邮箱与错误提示，避免只修改部门也被空邮箱阻断。
3. 保持只能修改自己获准的资料字段，管理员编辑和只读角色自我资料权限定界一致。

必须执行的验证：

- 空邮箱仅改部门成功并重载；合法邮箱可更新；无效邮箱有字段提示且不提交；无法修改 role/status/他人资料。

完成标准：

- 资料保存行为与展示一致，没有默默覆盖其它字段。

## FX08｜修复验证集移动布局并补响应式操作回归

优先级：P2；对应缺陷：D09；关联 32 号补充任务：R12。

修改范围：

- `src/app/test-cases/page.tsx`
- `tests/e2e/（新增真实数据移动布局场景）`
- `scripts/integration/comprehensive/journeys.mjs`

实施步骤：

1. 排查页头批量操作、样本标题/徽标、编辑删除按钮的最小宽度；适当使用 min-w-0、flex-wrap、break-words、响应式堆叠。
2. 长内容不裁掉关键操作；表格局部滚动可保留，但 documentElement 不横向超出。
3. 在 320/390/768/1440 宽度用真实数据库样本检查，包含长中文、长英文、UUID 和多个徽标。

必须执行的验证：

- documentElement.scrollWidth <= innerWidth+1；所有按钮可见可点，键盘焦点不落到屏幕外。
- 对已巡检的其他模块复用布局断言防回归。

完成标准：

- 390×844 的 /test-cases 复现消失；无全局 overflow-x:hidden 掩盖内容。

## FX09｜固化可重复的全模块浏览器验收与可靠测试判定

优先级：P1；对应缺陷：覆盖缺口/环境复现；关联 32 号补充任务：R12。

修改范围：

- `scripts/integration/comprehensive/`
- `playwright.comprehensive.config.ts`
- `tests/e2e/app-connectivity.spec.ts`
- `tests/e2e/guardrail-policy-console.spec.ts`
- `package.json`

实施步骤：

1. 把分步脚本收敛成单入口，预检所有固定端口和专用 DB，按依赖执行并记录每个子命令退出码。命令失败不得因最后一个 Get-Content 成功而被误标通过。
2. 给注销测试、策略只读测试、创建/审批者配置独立合成账号。退出登录会撤销该用户全部会话，不能共享被注销主体的 storageState。
3. 对正常流程断言精确 2xx、落库事实、终态和内容；对负向流程断言精确 401/403/404/409/428，不能将 500/503 泛化为成功。
4. 每个等待的 response promise 在点击失败时妥善收尾；每例失败后清理对话框/上下文，检查登录前置条件后才能继续业务测试。
5. 建立 28 个 page、158 个 route 的动态清单；每个模块列出读/写/失败/恢复/权限/移动覆盖。无 UI 的 RAG/工具/回调等作为 API 集成层，不能虚称人工页面已覆盖。
6. 每轮独立结果目录，禁止覆盖初始失败。合并按稳定 testID+project，保留 attempts、classification、依赖阻塞和退出码；单次全部通过与跨重跑合并通过明确区别。

必须执行的验证：

- 一次冷启动完整运行，不依赖旧登录、旧对象、旧批准或已有数据；同一流程再跑一次无冲突。
- 强制某核心接口 500，应得到 FAIL；缺模型配置应得到 BLOCKED 而非 PASS。

完成标准：

- 报告能从机器结果重算；真实后端与 mock UI 各自统计。
- 所有业务成功项有可验证终态；测试失败不自动跳过。

## FX10｜完善运行环境预检、后台服务健康与可恢复夹具

优先级：P1；对应缺陷：覆盖缺口/环境复现；关联 32 号补充任务：R01, R10, R12。

修改范围：

- `scripts/integration/comprehensive/start.mjs`
- `scripts/integration/comprehensive/gateway-stack.mjs`
- `scripts/integration/with-gateway-v2-profile.ts`
- `src/lib/media/capabilities.ts`
- `src/lib/operations/inspection.ts`
- `src/lib/conversation-archive/object-store.ts`
- `src/app/api/health/`

实施步骤：

1. 分别预检 DB schema、对象版本化、解析器、制品校验/intake/evaluation/告警投影等所需 Worker 心跳；明示应用活着与业务链可用的区别。
2. 验证浏览器、控制面、容器之间签名对象 URL 实际可达；禁止把宿主机 localhost 原样交给容器当可达地址。
3. 对批准的模型端点做 DNS/TLS/路由/鉴权/协议诊断，不输出密钥；把 DNS_FAILURE、quota、model_not_found、schema_mismatch 分开。真实端点仍须使用已有配置授权。
4. 建立新的合成归档对象，核验 bucket/key/version/ciphertext hash 和密钥标识后再发起审批；把 HTTP 层失败转换成可区分且不泄密的错误，避免所有 read failure 都变 500。
5. 运行前验证原始流式资格及恢复目标有效；无可恢复有效配置时阻止测试进入变更阶段。finally 恢复失败保留整体失败并给出实际状态，不续签/伪造质量证据。
6. 生产 NODE_ENV 与开发 Worker 的环境显式区分；构建固定 production，记录实际 distDir/source hash。关闭时只停止本次 PID/带测试标识容器。

必须执行的验证：

- 分别停一个 Worker/解析器/对象版本，readiness/capabilities 返回具体受影响能力；正常恢复后能力恢复。
- 签名 URI 在实际网络边界可读且版本匹配；两人批准后原文可读一次、回放定位、关闭清除；旧对象缺失能解释。
- 配置过期、测试中断、恢复失败三条路径均保存证据且不给全绿结果。

完成标准：

- 主站全链状态可解释，不能只凭 DB 200 宣称全部功能已启动。
- 测试不会改变生产端口或真实发布资格。

## FX11｜补齐真实多模态、归档与治理生命周期的端到端矩阵

优先级：P1；对应缺陷：覆盖缺口/环境复现；关联 32 号补充任务：R04, R05, R06, R07, R08, R09, R10, R12。

修改范围：

- `scripts/integration/comprehensive/`
- `scripts/integration/multiformat/`
- `tests/fixtures/multiformat/`
- `scripts/integration/check-gateway-v11-ui.ts`
- `输出/代码分析与升级/32_supplemental-repair.tasks.v1.json`

实施步骤：

1. 沿用 45 有效格式+3 异常样本，从“上传接受”扩展到真实解析、每个轨/页/视图覆盖、实际判定、告警、证据和可释放状态。把缺少解码器或真实模型资格明确标为 BLOCKED。
2. 增加文档+图片、音频+字幕、视频+音轨、文本+多文件混合的正反例；录音入口与上传入口使用同一能力矩阵。恶意附件内容不得成为上层执行指令。
3. 对 R04/R05/R06/R07/R08 剩余研发依赖逐项核对：派生资产、混合聊天释放、多模态 RAG/manifest、隐藏内容、版本清理都必须独立验收，不能由 45 个上传成功替代。
4. 跑完原文申请→独立审批→一次读取→位置高亮→音视频跳转→关闭清除→反馈双人复核→候选下载；候选仍标需要审核，不自动回写检测策略。
5. 将策略/词典/模板全生命周期、异常恢复/取消/重试和权限边界补成实际服务驱动的用例；历史文档详情没有新创建路径时单独提供合法旧格式测试数据。

必须执行的验证：

- 媒体真实解码覆盖与合成模型协议验证分开；真实 ASR/VLM/裁判鉴定须附端点/模型/版本和失败原因。
- 大文件分片、隐藏工作表/备注、多页多帧、多轨、伪扩展名、缺尾数据、超限、取消与重复提交全部落机器结果。
- 归档 180 天边界以受控合成时间戳测试包含/排除，并证明去重分页无丢失；这不代替 180 天生产历史完整性审计。

完成标准：

- 每个入口/格式/处理阶段有 PASS/FAIL/BLOCKED，不存在仅文件扩展名支持的“伪完整”。
- 任何 INCOMPLETE/UNKNOWN 不得显示为安全或可无条件释放。

## FX12｜保留独立质量门槛，完成修复后再启动基准验收

优先级：P1；对应缺陷：覆盖缺口/环境复现；关联 32 号补充任务：R11, R12。

修改范围：

- `输出/代码分析与升级/32_supplemental-repair.tasks.v1.json`
- `scripts/content-safety/`
- `scripts/acceptance/`
- `输出/测试报告/（新增修复后报告）`

实施步骤：

1. 先关闭本报告 D01–D09，确保环境阻塞有明确结果；再按既有 32 号计划完成 R11 金融复核/消融/校准与 R12 G0–G5。
2. 冻结规则、策略包、模型、解析器、数据集、标签和运行身份 hash。真实裁判协议/资格不通过时明确 BLOCKED，不以 mock 结果替代。
3. 将正常样本误拦 FPR、阻断结果中误报占比 FDR 分开，给混淆矩阵、分母、缺失/拒答/技术失败数量及切片。
4. 保留 FPR≤1%、FDR≤10%、recall/accuracy≥95%、FNR≤5% 以及原方案其它更严门槛；质量集必须独立审定且与开发集隔离。
5. 质量不达标回到相应引擎/证据/策略修复，不通过增加大范围白名单或把技术失败算正常来降低误报。

必须执行的验证：

- 全入口工程回归一次完整通过后，以真实独立集执行基准并输出可复算结果。
- 无足够数据/独立标签/运行身份时必须 BLOCKED，不能输出虚构的达标百分比。

完成标准：

- 最终报告明确工程完成、质量通过、部署资格三种状态。
- 只有对应任务所有验收项有证据，才能把 32 号任务或本任务改为完成。

## 3. 推荐的验收命令与约定

在工作区根目录运行。下列 `$run` 为已经通过隔离校验、含私有配置与合成 fixture 的目录；初始化新库时不能盲目重复执行已有固定名字的 schema-check，该脚本当前为本次运行定制，FX09/FX10 要先改成独立每轮数据库。

```powershell
$run = '.artifact-build/comprehensive-20260908-13b36f8'
pnpm ts-check
pnpm lint
pnpm contracts:check
pnpm test:unit --run
pnpm test:gateway-java
pnpm test:sdk-java
pnpm test:sdk-go
$env:PYTHONPATH = (Resolve-Path packages/sdk-python).Path
python -m unittest discover -s packages/sdk-python/tests -p 'test_*.py'
```

每条命令独立检查退出码，避免 PowerShell 后续输出覆盖真正失败码。Python 解释器需为依赖已经就绪的环境，本轮实际使用 `E:/python/python.exe`。

真实主站构建和启动：

```powershell
node scripts/integration/comprehensive/run-with-env.mjs $run next build
node scripts/integration/comprehensive/start.mjs $run
```

`start.mjs` 会拒绝已占用的测试端口；不得自动停止占用端口的不明进程。schema、MinIO、必要密钥/资格与模型预检需先通过。

定向回归接口：

```powershell
pnpm exec tsx scripts/integration/comprehensive/schema-parity.ts $run
node scripts/integration/comprehensive/journeys.mjs $run
node scripts/integration/comprehensive/run-with-env.mjs $run tsx scripts/integration/multiformat/upload-matrix.ts $run
node scripts/integration/comprehensive/run-with-env.mjs $run tsx scripts/integration/comprehensive/security.ts $run
node scripts/integration/comprehensive/run-with-env.mjs $run node node_modules/@playwright/test/cli.js test --config=playwright.comprehensive.config.ts
```

**以上不是现成无依赖的一键流水线**：现有 journeys 默认末尾注销；extended/diagnostics/final 使用已保存会话。FX09 应建立独立测试账号与正确排序，在此之前按 README 的分阶段命令执行。不要直接复制整段命令并把全部退出码当最后一次。

UI 修复的最小定位回归：

- FX01：J02；FX03：`/policy-releases` 真实 DTO；FX04：`/dashboard` + 两进程 PG 限流。
- FX05：J05 + 新增审批/到期负向链；FX06：J16/J23 + 合法一次性导出三格式。
- FX07：J15；FX08：J17 + 宽度矩阵。
- FX10/FX11：J20/J28/J31/J32 + 原文浏览器 13 检查点全部完成，真实媒体模型测试另列。

实际解码专项使用分析器容器、限制网络/权限/资源，构建源码脚本后执行 `audio-processing-smoke.mjs`。即使 5 项通过，仍注明 synthetic model responses，不作为模型鉴定。

## 4. 修复后报告必须包含的字段

- 基线 HEAD、完整工作区差异清单、构建/镜像摘要、DB 迁移清单、模型与解析器版本。
- 每项 FX/D/R 的状态映射、复现证据、修改提交、测试 ID/命令/退出码、证据路径。
- 每组唯一用例的 PASS/FAIL/BLOCKED/SKIP 数量；区分单次执行与重跑合并。
- 真实前端+后端、真实 PG+替身存储、真实编解码+合成模型、真实生产模型四种范围。
- 原文访问/导出审批的实际失败类型、资格有效性与测试后恢复结果。
- 9 个缺陷全部关闭或有明确未完成项；32 号方案中剩余任务不能被隐式覆盖。
- 独立质量集的标签来源、隔离、混淆矩阵、各切片指标与保留的严门槛；证据不足应明确阻塞。

所有任务通过工程验收后，才进入用户要求的后续构建/部署或基准验收阶段；是否正式发布必须依据实际资格与授权，不能由测试脚本自动推定。
