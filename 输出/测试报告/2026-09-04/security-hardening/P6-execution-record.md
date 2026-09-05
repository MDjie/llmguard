# GuardLLM 安全检测能力增强 P6 执行记录

## 阶段结论

- 状态：内部可执行项完成；外部验收项保持阻塞。
- 基线提交：`1f6178a`（P5 完成提交）。
- 完成提交：见包含本记录的 P6 阶段提交。
- 执行日期：2026-09-05（Asia/Shanghai）。
- 发布判定：允许进入独立 QA 与目标环境验收；在外部证据签收前不允许建议生产发布。

## 完成范围

1. 按计划顺序执行合同、计划、质量、全量单元、覆盖率、数据库集成、浏览器 E2E、Python/Go/Java SDK、兼容性、appliance、生产构建和 Java Gateway 门禁，并保存逐命令日志。
2. 从原 DOCX/XLSX 的结构化清单重新验证来源哈希、DOCX 286 段/36 表、XLSX 7 个工作表，以及 TC-0001 至 TC-0158 的连续性、唯一性和完整性。
3. 在专用 `guardllm_integration_p6` 数据库、随机临时管理员和临时应用容器中执行 32 条 16 维在线请求；32/32 HTTP 200、32/32 断言通过，匿名边界返回 401。
4. 在同一隔离环境完成桌面/移动认证 E2E 10/10，以及服务、数据库、签名策略、会话、RAG、Agent、扫描、运营、词典、模板和文档能力冒烟 15/15。
5. 增加真实合成 PDF 上传、解析和检测检查。该检查发现并关闭 standalone 镜像遗漏 Canvas 顶层链接与 PDF.js worker 的生产打包缺陷。
6. 执行 16 个文件、88 项受控故障注入，覆盖策略篡改、错误公钥、数据库不可用、无绑定、模板失败、解码炸弹、租户公平、Worker 堆积、OCR/ASR/Judge 超时、流式取消、任务竞态和只读缓存。
7. 执行 1K、8K、32K、128K 代理负载和并发测试；保留 128K 精确目标 Tokenizer 与 30 分钟目标拓扑压测的外部边界。
8. 重新部署应用镜像并验证 13/13 服务运行、应用/数据库/策略健康、策略 generation 3、只读根文件系统、限定 tmpfs、匿名鉴权边界、最近日志与审计链。
9. 生成 158 项 CSV、机器可读摘要和详细验收报告；147 条通过、0 条失败、0 条部分覆盖、11 条外部阻塞，内部 P0/P1 失败为 0。

## 关键设计决定

- 将附件 32 条正反例认定为“功能符合性样本”，不把结果扩张为生产 Precision/Recall/FPR/FNR；独立 2000 ATTACK + 2000 BENIGN 盲测仍由独立 QA 持有和签名。
- 运行时验收使用专用数据库与临时账号，避免修改生产账号或业务数据；日志和结果仅保存样本 SHA-256，不保存密码、Cookie 或原始敏感内容。
- PDF 解析依赖只在 PDF 路径延迟加载；Next.js standalone 显式追踪 `@napi-rs/canvas` 平台包和 `pdf.worker.mjs`，避免普通文档列表请求触发原生运行时，同时确保容器内真实 PDF 可解析。
- 158 条矩阵只把计划明确列出的 11 条目标环境/第三方/硬件事项标为外部阻塞；不以本地代理或模拟证据虚构通过。
- 总体发布状态保持 `HOLD_PRODUCTION_RELEASE`，即使内部工程门禁全部通过，也不跨越外部签收边界。

## 测试命令与结果

- `pnpm security-hardening:gates`：全仓门禁通过；完整日志位于 `P6-logs/01-contracts.log` 至 `P6-logs/14-gateway-java.log`。
- `node scripts/acceptance/run-isolated-attachment-acceptance.mjs`：32/32 API、10/10 认证 E2E、15/15 部署冒烟通过。
- `pnpm test:unit --run tests/document/pdf-loader.test.ts tests/deployment/document-runtime-dependencies.test.mjs`：4/4 通过。
- `node scripts/acceptance/run-security-hardening-fault-injection.mjs`：16 个文件、88 项通过。
- `tsx scripts/benchmarks/security-fast-path.ts`：本地性能证据通过，128K 明确标记为代理口径。
- `pnpm security-hardening:deployment-evidence`：13 个服务、健康/权限/只读文件系统/日志/审计链通过。
- `pnpm security-hardening:matrix`：生成 158 条矩阵与报告。
- `pnpm security-hardening:verify-deliverables`：158 行、连续 ID、147/0/0/11、阻塞清单、SHA-256、发布 HOLD 和秘密扫描全部通过。

## 部署验证

- 地址：`http://127.0.0.1:58082`。
- Compose：`guardllm-r0`，13/13 服务运行。
- 应用镜像：`sha256:462f4cca0cdcfa28fabd8decd84ea58a42e3350bf79f054e5e1a0ff26714ff92`。
- 健康：应用、存活、数据库和策略端点均为 HTTP 200；策略 ready，generation 3。
- 安全配置：应用根文件系统只读，仅 `/tmp` 与 `/app/.next/cache` 为受限 tmpfs。
- 审计：两个分区的链式记录验证有效；具体条数和去标识化分区摘要见 `P6-deployment-verification.json`。

## 缺陷关闭

- DEF-001 / P0：部署无签名策略包——已通过策略 bootstrap、签名校验、应用绑定和 32/32 运行时请求关闭。
- DEF-002 / P2：只读容器缺少 Next 缓存写入面——已通过限定 tmpfs 和无高严重度启动日志关闭。
- DEF-003 / P1：PDF standalone 依赖不完整——先复现 `@napi-rs/canvas` 无法解析，再复现 PDF.js worker 缺失；最终由镜像内直接解析和 API 上传解析双重证据关闭。

## 证据目录

- 阶段证据：`输出/测试报告/2026-09-04/security-hardening/`。
- 最终矩阵、摘要与 Markdown 报告：`输出/测试报告/2026-09-05/security-hardening/`。
- DOCX/XLSX 可交付件：`outputs/01a06a81-15b8-7530-9fb5-c920e72f6539/`。

## 外部阻塞

不得虚构通过的用例：TC-0122、TC-0131、TC-0134、TC-0135、TC-0142、TC-0153、TC-0154、TC-0155、TC-0156、TC-0157、TC-0158。

另需外部签收：独立 2000+2000 盲测、批准的生产词库/白名单与许可、生产视觉/ASR/音频/TTS 资产、完整业务周期影子流量和分阶段灰度。每项责任人与唯一下一步已写入最终 158 项矩阵。

## 回滚方法

1. 应用优先回切上一已验证镜像 `sha256:2758d1a3b62fd9aa53f570261d5ac1ed2c692d9a70653ce55a975ded07bbfdad`。
2. 策略按 Bundle generation 回滚至 last-known-good，必须填写原因并重新执行签名、绑定、readiness、Guard、RAG/Agent、文档与审计校验。
3. 0036 至 0041 为扩展式迁移；0038/0040 有专项回滚说明。应急回滚不得未经审批删除列、表或业务数据。
4. 回滚后重新执行核心部署冒烟和审计链验证，不能只观察容器启动状态。

## 下一阶段准入结论

- 内部工程阶段：完成。
- 独立 QA/目标环境验收：允许进入。
- 生产发布：不允许，直至全部外部阻塞和附加外部门禁具名签收。
