# CODEX 大模型内容安全词库建设与执行计划

> 版本：V1.0  
> 日期：2026-09-04  
> 执行主体：Codex  
> 执行状态：已启动  
> 核心词库：data/content-safety/lexicon/content-safety-lexicon.v1.jsonl  
> 目标：建设可审计、可评测、低误杀、可由平台检测引擎热加载的独立内容安全词库

## 1. 目标与完成定义

本计划不是一次性收集网络敏感词，而是建立持续运行的词库生产线。

完成 V1 需要同时满足：

- GB/T 45654—2025 的 5 类 31 种风险全部建立稳定 ID 和映射；
- 关键词库不少于 10,000 个有效条目；
- A.1 的 8 类每类不少于 200 个关键词，A.2 的 9 类每类不少于 100 个关键词；
- 每个生产条目具有来源、风险映射、匹配方式、严重度、动作建议、版本和测试；
- 建成白名单、良性硬负例、应拒答和非拒答资产；
- 生成测试题库不少于 2,000 题，应拒答和非拒答题库各不少于 500 题；
- 词库可编译为平台检测引擎可加载的不可变版本包；
- 新词包支持校验、签名、影子、灰度、回滚、审计和上一稳定版本降级；
- 非拒答题拒答率不高于 5%，内部目标不高于 1%；
- 自动硬拦截精确率达到 99.5% 后，相关规则才允许启用硬拦截；
- 全部质量指标按风险、场景、语言、模态和输入/输出方向拆分。

## 2. Codex 自主执行授权边界

用户已明确授权 Codex 自主下载建设词库所需的公开资料和数据。

Codex 可以自主执行：

- 下载公开法律、标准说明、开源词库、公开评测集和 Unicode 安全数据；
- 使用 git、HTTPS 下载或公开 API 获取资料；
- 核验许可证、生成哈希和来源清单；
- 在项目内创建词库、候选区、测试集、脚本、文档和报告；
- 使用 pnpm 安装完成任务所必需的依赖；
- 运行格式检查、类型检查、单元测试、数据质量检查和评测；
- 对候选词做规范化、去重、映射、打分、生成良性硬负例和白名单候选；
- 在不影响生产服务的情况下进行影子评测和本地回归。

以下行为仍不得自动执行：

- 将来源不明或许可证不清的数据直接标记为 active；
- 未经测试把候选词配置为硬拦截；
- 建立无作用域、无期限、可跳过全部检测的全局白名单；
- 上传、发布或对外共享项目私有数据；
- 将真实个人信息、凭证、商业秘密写入测试样本；
- 未经明确授权操作生产环境、外部账号或真实用户数据；
- 为扩大词库而下载明显非法、非自愿私密或未成年人性剥削原始媒体；此类检测使用合法的哈希服务、合成样本和受控分类器。

## 3. 目录与资产规划

    data/content-safety/
    ├── lexicon/
    │   ├── content-safety-lexicon.v1.jsonl       # 权威机器可读词库
    │   ├── content-safety-lexicon.schema.json    # JSON Schema
    │   └── releases/                             # 已编译、不可变、签名的词包
    ├── sources/
    │   ├── sources.lock.json                     # URL、许可证、提交号、SHA-256
    │   ├── NOTICE.md                             # 归属和许可证说明
    │   ├── raw/                                  # 原始下载，只读保留
    │   └── staged/                               # 解析、去重后的候选
    ├── evaluations/
    │   ├── generation-risk/
    │   ├── should-refuse/
    │   ├── should-answer/
    │   ├── hard-negatives/
    │   └── adversarial/
    ├── policies/
    │   ├── action-policy.v1.json
    │   └── protected-invariants.v1.json
    └── reports/
        ├── coverage.json
        ├── quality.json
        └── release-diff.json

    scripts/content-safety/
    ├── fetch-sources.mjs
    ├── verify-sources.mjs
    ├── import-candidates.mjs
    ├── lib.mjs
    ├── verify-source-lock.mjs
    ├── validate-lexicon.mjs
    ├── import-candidates.mjs
    ├── compile-shadow-bundle.mjs
    ├── normalize-lexicon.mjs（待建）
    ├── generate-hard-negatives.mjs
    ├── compile-lexicon.mjs
    └── evaluate-lexicon.mjs

原始下载、候选、生产词库、评测集和编译产物必须分层，禁止直接从 raw 目录加载到运行时。

## 4. 已执行状态

- [x] 创建独立机器可读词库文件；
- [x] 登记 GB/T 45654—2025、生成式人工智能服务管理暂行办法、深度合成规定、个人信息保护法和未成年人网络保护条例；
- [x] 定义 GB/T 45654—2025 全部 31 种风险；
- [x] 增加自残自杀、未成年人性剥削、暴力/非暴力犯罪、PII、秘密、提示注入、越狱和系统提示泄露等产品扩展风险；
- [x] 建立首批 63 个候选词或检测模式；
- [x] 建立首批 12 个“仅抑制指定词法信号”的候选白名单规则；
- [x] 核验 MLCommons AILuminate Demo 可按 CC-BY-4.0 用作评测，且官方建议不要将该评测集直接用于训练；
- [x] 核验 fwwdn/sensitive-stop-words 仓库声明 Apache-2.0，限定为候选导入源；
- [x] 登记 Unicode UTS #39 为视觉混淆检测来源；
- [x] 下载并锁定首批外部数据的具体提交/文件版本和 SHA-256，共 3 个来源、9 个文件；
- [x] 创建来源校验、词库校验、候选导入和影子编译脚本；
- [x] 完成首批公开候选词导入和质量报告，共 1,156 条隔离候选；
- [x] 生成 155 条规则和 10 条目标规则级例外的未签名影子包；2 条支持性响应规则保持为动作策略，不编译成豁免；
- [ ] 创建正式编译、评测和签名发布脚本；
- [ ] 扩充至 10,000 个通过审核的有效条目；
- [ ] 建成三类标准要求的测试题库；
- [ ] 与检测引擎完成接口和热加载集成；
- [ ] 完成影子、灰度和 V1 正式发布。

## 5. 数据源计划

### 5.1 第一批：已核验，可下载

| 来源 | 用途 | 许可证/依据 | 进入区域 | 自动生效 |
|---|---|---|---|---|
| GB/T 45654—2025 及官方信息 | 31 类风险、规模和更新基线 | 国家标准公开引用 | taxonomy | 否 |
| 生成式人工智能服务管理暂行办法 | 法规映射 | 公开法规 | taxonomy | 否 |
| 深度合成管理规定 | 特征库、审核和日志要求 | 公开部门规章 | taxonomy | 否 |
| 个人信息保护法 | PII 和敏感个人信息分类 | 公开法律 | taxonomy/pattern | 否 |
| 未成年人网络保护条例 | 未成年人内容安全 | 公开法规 | taxonomy/test | 否 |
| fwwdn/sensitive-stop-words | 中文候选词 | Apache-2.0；原始词条仍需复核 | raw → staged | 绝不 |
| MLCommons AILuminate Demo | 安全评测提示 | CC-BY-4.0 | evaluations | 绝不用于生产匹配或训练 |
| Unicode UTS #39 / confusables | 视觉混淆检测 | Unicode License/Terms | normalization data | 作为算法数据，经版本锁定 |

### 5.2 第二批：发现后必须先核验

- 具有明确许可证、维护记录和分类说明的中文安全词库；
- 政府和监管机构公开的反诈、禁毒、未成年人、网络暴力风险术语；
- OWASP、MLCommons 等大模型安全分类和攻击机制；
- 业务方提供且具有合法来源的企业词库；
- 用户申诉、人工改判和红队结果形成的内部候选。

排除规则：

- 无许可证或声称“来源网络”的词表不得直接并入生产；
- 仅按政治、色情等粗分类但没有上下文与来源的词，只能做候选发现；
- 域名黑名单不得与内容安全关键词混成同一风险，需进入 URL/威胁情报检测器；
- 停用词不属于敏感词库；
- 过时人物、事件、暗语必须设置复审日期；
- 单字、常见姓氏、普通地名和高频日常词默认不得用于硬拦截。

## 6. 下载与来源锁定任务

### 6.1 下载目标

1. fwwdn/sensitive-stop-words：完整浅克隆，用提交哈希锁定；
2. MLCommons AILuminate：只下载 README、许可证和公开 Demo CSV；
3. Unicode confusables.txt：下载 latest 版本，同时记录响应头、日期和 SHA-256；
4. 保存法规与标准来源 URL，不批量复制受版权限制的全文；
5. 生成 sources.lock.json 和 NOTICE.md。

### 6.2 推荐执行命令

在项目根目录执行，下载目录必须先校验位于 data/content-safety/sources/raw 内：

    git clone --depth 1 https://github.com/fwwdn/sensitive-stop-words.git data/content-safety/sources/raw/fwwdn-sensitive-stop-words

    git clone --depth 1 https://github.com/mlcommons/ailuminate.git data/content-safety/sources/raw/mlcommons-ailuminate

Unicode 使用 HTTPS 下载：

    Invoke-WebRequest -Uri https://www.unicode.org/Public/security/latest/confusables.txt -OutFile data/content-safety/sources/raw/unicode-confusables.txt

执行后必须：

- 记录仓库 origin、HEAD commit、下载时间；
- 对每个实际导入文件计算 SHA-256；
- 保存 LICENSE/NOTICE；
- 运行恶意文件、超大文件、二进制和路径穿越检查；
- 将原始文件设置为只读工作资产，后续不在其上修改；
- 不使用 git submodule 直接参与生产构建，避免上游无审查漂移。

## 7. 候选导入与规范化

### 7.1 导入流程

    raw source
      → 文件和编码检查
      → 许可证与哈希验证
      → 解析为统一 candidate schema
      → Unicode/全半角/大小写/简繁体规范化
      → 精确去重与规范词合并
      → 近重复、子串和冲突检测
      → 风险分类候选映射
      → 自动质量评分
      → 人工/规则复核
      → staged candidate

### 7.2 规范化要求

- 同时保留 original、canonical 和 match_view，绝不覆盖原词；
- 使用 Unicode NFKC 作为一个匹配视图，不把它作为审计原文；
- 简繁体、拼音、形近字和同音字作为 variants，不复制成互不关联的新主词；
- 视觉混淆骨架只做风险特征，不用于向用户展示；
- 移除首尾空白，保留词内有意义空格；
- 检查控制字符、零宽字符、双向文本控制符和不可打印字符；
- 限制正则长度、嵌套和回溯，阻止 ReDoS；
- URL、邮箱、证件、银行卡、密钥等进入 pattern，不以海量实例枚举；
- 短于两个中文字符的候选默认 quality_score 为低；
- 与白名单冲突、常用词频过高或多义性强的词默认 action_hint 为 score_only。

### 7.3 自动质量评分

建议候选评分：

    quality_score =
      0.25 × source_quality
      + 0.20 × category_confidence
      + 0.20 × positive_precision
      + 0.15 × hard_negative_pass_rate
      + 0.10 × boundary_quality
      + 0.10 × freshness

门槛：

- 低于 0.60：保留候选或废弃；
- 0.60–0.80：只能 score_only；
- 0.80–0.95：可参与语义融合；
- 高于 0.95 且硬负例通过：才可申请强动作；
- 是否硬拦截还必须满足风险级别、语义确认和策略审批，不由 quality_score 单独决定。

## 8. 分类映射与扩充到 10,000 条

### 8.1 数量不是唯一目标

10,000 是标准参考基线，不应靠复制大小写、空格和简繁体虚增。计数使用 canonical term 数量，variants 单独统计。

每个 A.1/A.2 类别扩充顺序：

1. 法规和官方术语；
2. 核心概念及规范短语；
3. 常见别名、缩写和网络表达；
4. 动作、对象和意图组合模板；
5. 多语言对应词；
6. 形近、同音、分隔和编码变体；
7. 与每个词配对的良性硬负例；
8. 时效性词语和事件词，带 expires_at。

### 8.2 计数规则

- canonical term 计入关键词总规模；
- variants 不重复计入 10,000；
- pattern 按独立、可解释的检测规则计数，不按匹配实例计数；
- allow_rule 不计入风险关键词规模；
- deprecated 和 emergency_expired 不计入有效规模；
- 同一 canonical 映射多个风险只计一个总词条，但计入各风险覆盖时需标记 primary_risk；
- 每周报告各类目标、候选、有效、已测试和 active 数量。

### 8.3 平衡约束

- 不允许用单一色情或广告词库填满总数；
- A.1/A.2 先满足标准最低数量，再按真实风险和流量扩展；
- A.3–A.5 必须有测试和非词法检测能力，不能因为标准未规定最低词数而空缺；
- 自残求助、新闻教育、反诈宣传等良性场景的硬负例数量至少与对应风险正例相当；
- 每个支持语言和模态单独报告覆盖，不能用中文文本总数代表全产品。

## 9. 白名单建设任务

### 9.1 白名单资产

建设：

- 完整短语白名单；
- 良性实体白名单；
- 否定/反对/预防/举报上下文规则；
- 新闻、研究、教育、医疗求助场景规则；
- 可信模板哈希规则；
- 租户和产品专有白名单；
- 临时、自动过期白名单；
- 隔离测试环境白名单。

### 9.2 白名单不变量

- effect 只能是 suppress_lexical_only、reduce_score、route_to_supportive_context 或 require_review；
- 禁止 effect 为 bypass_all；
- 白名单不得关闭 PII/DLP、真实凭证、未成年人性剥削、工具权限和智能体执行检查；
- 全局白名单必须双人审批；
- 必须有 expires_at 或季度复审记录；
- 每条至少包含良性命中用例、危险后缀/前缀反例和跨句反例；
- 命中量异常、覆盖高风险或作用域缺失时自动熔断。

## 10. 测试题库建设任务

### 10.1 生成内容风险题库

- 总数不少于 2,000；
- 覆盖全部支持语言和模态；
- 覆盖全部 31 种风险；
- A.1/A.2 每类不少于 50 题；
- A.3–A.5 每类不少于 20 题；
- 包含直接、隐晦、多轮、引用、否定、翻译、变形、编码、角色扮演和间接注入；
- 建立公开开发集和独立隐藏验收集。

### 10.2 应拒答题库

- 总数不少于 500；
- A.1/A.2 每类不少于 20 题；
- 记录期望动作，区分拒答、安全完成、澄清、人工审核；
- 不将“出现敏感主题”自动标成应拒答。

### 10.3 非拒答与硬负例题库

- 总数不少于 500，内部目标不少于 2,000；
- 覆盖制度、信仰、形象、文化、习俗、民族、地理、历史、英烈、性别、年龄、职业和健康；
- 加入新闻报道、法律条文、教育、研究、反诈、风险防范、自残求助和隐私保护；
- 每个高频词至少有一个最小对：相同关键词，仅改变意图或上下文；
- 评测时把机械拒答、无帮助的空泛回答和错误安全警告分别计数。

### 10.4 MLCommons 数据的使用约束

MLCommons AILuminate Demo 仅用于：

- 检查产品扩展分类覆盖；
- 建立国际化评测适配器；
- 验证评测工具；
- 比较公开基准类别表现。

不得：

- 直接把公开 Demo 题训练进模型；
- 把 Prompt_text 拆词后直接变成生产敏感词；
- 把公开开发集当隐藏验收集；
- 忽略 CC-BY-4.0 归属说明。

## 11. 工具脚本实施顺序

### 11.1 fetch-sources.mjs

功能：

- 仅允许 sources.lock.json 中批准的 HTTPS/GitHub 来源；
- 下载到临时目录，成功验证后移动到 raw；
- 限制响应大小、重定向次数和超时；
- 记录 URL、ETag、Last-Modified、commit、文件大小和 SHA-256；
- 重试使用相同目标和幂等逻辑；
- 下载失败不覆盖上一份可用原始数据。

### 11.2 verify-sources.mjs

功能：

- 验证哈希、许可证文件、路径、编码和文件大小；
- 拒绝符号链接、路径穿越、可执行文件和异常二进制；
- 生成 NOTICE.md 和来源质量报告；
- 上游内容变化必须以新版本导入。

### 11.3 import-candidates.mjs

功能：

- 适配逗号分隔、逐行、CSV 和 JSONL；
- 原始条目进入 candidate，绝不直接 active；
- 保留 source_id、source_path、source_line 和 source_hash；
- 根据源分类给出候选 risk_ids，但置信度不足时标记 needs_review。

### 11.4 normalize-lexicon.mjs

功能：

- 生成 canonical、variants、match_view 和 confusable features；
- 精确/近似去重；
- 发现子串、白名单、正则和跨类别冲突；
- 生成变更报告，不静默删除。

### 11.5 validate-lexicon.mjs

功能：

- 逐行 JSON 解析和 Schema 验证；
- term_id、risk_id、allow_id 唯一；
- 所有引用存在；
- 数值、状态、动作和作用域合法；
- 白名单均有过期/复审和测试；
- 正则安全；
- GB/T 数量和测试覆盖检查；
- 生成 coverage.json，任一关键门禁失败返回非零退出码。

### 11.6 compile-lexicon.mjs

功能：

- 按 locale、tenant、scene 和 direction 编译；
- 生成精确匹配、短语、正则、模式和白名单分区；
- 输出不可变 manifest、数据文件、SHA-256 和签名；
- 不把 source evidence、审核意见和敏感原文全部下发到运行节点；
- 保留上一稳定版本。

### 11.7 evaluate-lexicon.mjs

功能：

- 分别评估风险正例、硬负例、应拒答、非拒答和对抗集；
- 输出每类 TP/FP/TN/FN、Precision、Recall、FPR、FNR 和置信区间；
- 输出新增拦截、放行和动作变化；
- 验收失败阻止 active/release 标记。

## 12. 与检测引擎的集成任务

### 12.1 代码和数据边界

词库独立于业务代码；平台代码只实现：

- LexiconProvider 接口；
- 词包拉取/推送、验签和本地缓存；
- 规范化和匹配运行时；
- 白名单条件求值；
- 语义/PII/注入等信号融合；
- Policy Engine 决策；
- 版本、证据和审计输出；
- 热更新失败时回退上一稳定版本。

### 12.2 运行方式

采用控制面独立、数据面就近：

    词库管理/编译控制面
          ↓ 签名不可变词包
    检测节点本地缓存和内存索引
          ↓
    关键词 + 白名单 + 语义 + PII + 注入
          ↓
    策略决策与审计

不得在每次检测请求中同步查询词库数据库。词库发布通过推送或短周期拉取，检测节点在本地完成热路径匹配。

### 12.3 接入点

- 用户输入；
- 模型流式和最终输出；
- 上传文件的解析、OCR 和 ASR 结果；
- RAG 入库和召回；
- 工具调用参数及工具输出；
- 训练与微调语料；
- 申诉和审核回流。

### 12.4 失败策略

- 新词包下载或验签失败：继续使用上一稳定版本并告警；
- 内存编译失败：拒绝切换版本；
- 语义模型超时：按场景 fail-open、review 或 fail-closed，不能统一处理；
- PII/秘密和真实工具执行等高风险场景优先 fail-closed；
- 普通聊天低风险场景可在词法与本地策略保护下受控降级；
- 所有降级写入 decision、reason_code 和版本审计。

## 13. 质量门禁

### 13.1 单条词门禁

- 有稳定 ID；
- 有来源和允许用途；
- 有主风险和必要的次风险；
- 有匹配边界；
- 有正例和硬负例；
- 多义词有上下文规则；
- 有默认动作但不直接绑定用户处罚；
- 高风险词经过双人审核；
- 白名单冲突已处理；
- 无明显隐私、版权或恶意数据问题。

### 13.2 版本门禁

- JSONL 和 Schema 全部通过；
- 31 类风险无空缺；
- A.1/A.2 数量达到要求；
- 无重复 ID、悬空引用和失效来源；
- 无危险正则；
- 硬负例通过；
- 自动硬拦截精确率达到 99.5%；
- 应拒答率不低于 95%，非拒答率不高于 5%；
- 延迟和内存不超预算；
- release diff 经审核；
- 回滚演练成功。

## 14. 发布计划

版本状态：

    candidate → reviewed → shadow → canary → active → deprecated

灰度：

1. shadow：只记录，不改变用户结果；
2. 1%：内部和低风险租户；
3. 5%：观察一个高峰周期；
4. 20%：检查类别与语言分层指标；
5. 50%：进行故障和回滚演练；
6. 100%：满足全部门禁后正式切换。

自动停止条件：

- 出现极高风险漏放；
- 误杀率超过基线 50% 或内部 SLO；
- 白名单覆盖极高风险；
- P95 延迟超过预算；
- 错误率、超时或内存异常；
- 无法复现决策版本；
- 用户申诉改判异常上升。

## 15. 当前批次执行步骤

### Batch 0：结构和种子（已完成）

- [x] 创建独立 JSONL 词库；
- [x] 建立来源记录；
- [x] 建立 31 类标准风险；
- [x] 建立 9 类产品扩展风险；
- [x] 建立 63 个候选词/模式；
- [x] 建立 12 条候选白名单。

### Batch 1：下载与锁定（已完成）

- [x] 网络调研并确认第一批来源及许可证声明；
- [x] 下载 fwwdn/sensitive-stop-words；
- [x] 下载 MLCommons AILuminate Demo；
- [x] 下载 Unicode confusables.txt；
- [x] 生成提交号/文件版本、SHA-256、NOTICE 和 sources.lock.json；
- [x] 使用提交号固定 URL 对 GitHub 8 个文件重新取字节核验，哈希全部一致；Unicode 记录文件头版本 17.0.0 并以本地 SHA-256 锁定；
- [x] 记录 git clone 连接重置失败，并改用提交固定的 HTTPS 原始文件下载。

### Batch 2：工具和校验（主体完成）

- [x] 创建 JSON Schema；
- [x] 实现 sources 字节数、SHA-256、用途、许可和版本验证；
- [x] 实现 JSONL 结构、引用、重复、正则和白名单边界校验；
- [x] 实现候选导入；
- [x] 实现 NFKC 规范化、跨文件去重和主库冲突排除；
- [x] 添加 package.json 的 pnpm 脚本；
- [x] 建立 5 项词库产物测试，并完成引擎、动态缓存和目标规则策略包回归；损坏数据夹具待补。

### Batch 3：候选导入（执行中）

- [x] 导入 1,156 条公开候选到 staged，全部为 needs_review 且 production_eligible=false；
- [x] 生成来源、类别、重复、拒绝和质量分布；
- [ ] 丢弃明显停止词、域名和无效条目；
- [ ] 标记全部常见词、短词和多义词；已发现并修正 4 条永不生效的候选白名单；
- [x] 建立首批 44 条良性、第二次危险命中、过期和方向越界硬负例；
- [ ] 只将通过门禁的条目合并到权威 JSONL。

### Batch 4：规模和覆盖

- [ ] A.1 每类达到 200 个通过复核的 canonical；
- [ ] A.2 每类达到 100 个通过复核的 canonical；
- [ ] 全库达到 10,000 个有效 canonical；
- [ ] A.3–A.5 建立词法之外的检测映射；
- [ ] 完成简繁、英文、拼音和变形覆盖；
- [x] 输出 development 模式 coverage.json；生产门禁已验证会因 0 个 active 和未达到 10,000 条而失败。

### Batch 5：评测资产

- [x] 建立首批 44 条白名单边界集，并使用真实 GuardEngine V2 达到 44/44；
- [ ] 建立 2,000 题生成风险题库；
- [ ] 建立 500 题应拒答题库；
- [ ] 建立至少 500 题非拒答题库，内部目标 2,000；
- [ ] 建立对抗、跨轮、RAG 注入和多模态集；
- [ ] 隐藏验收集与开发集隔离。

### Batch 6：引擎融合

- [x] 核对现有 RuleSpec、RuleExceptionSpec 和 SignedPolicyBundle 契约；
- [x] 生成 155 条 RuleSpec 兼容记录的未签名影子包，enforcementAllowed=false；
- [x] RuleExceptionSpec 增加 targetRuleIds、directions 和 expiresAtEpochMs，按局部命中生效且不可豁免 mandatoryDeny；
- [x] 新增数据库迁移 0037，并贯通白名单管理 API、动态策略缓存、签名策略包编译和运行时校验；
- [ ] 实现 LexiconProvider；
- [ ] 加载签名词包并构建内存索引；
- [x] 接入目标规则、风险维度、方向、有效期和完整短语范围白名单条件；
- [ ] 接入信号融合和策略引擎；
- [ ] 返回 lexicon_version、allowlist_version、model_version 和 policy_version；
- [ ] 接入输入、输出、流式、RAG 和工具边界；
- [ ] 完成降级、热更新和回滚测试。

### Batch 7：上线

- [ ] 完成影子；
- [ ] 完成 1%/5%/20%/50%/100% 灰度；
- [ ] 发布 V1.0 稳定词包；
- [ ] 建立每周词库更新、每月题库更新和季度治理审计。

## 16. 下一步执行顺序

Codex 后续连续执行时按以下优先级：

1. 为校验器、导入器和影子编译器补齐损坏数据夹具；
2. 处理误杀风险最高的短词、多义词、人物/组织名称和子串冲突；
3. 补齐引用、新闻、教学、跨轮、RAG 和流式输出测试；
4. 对 1,156 条 staged 候选分批复核，只有评测通过的条目才能进入主库；
5. 实现 LexiconProvider、签名词包加载和内存索引；
6. 达到可评测的小规模词包后接入引擎影子流量；
7. 再扩充规模，不以未测试的 10,000 条作为虚假完成；
8. 完成标准题库和全链路检测；
9. 由现有 Ed25519 策略包通道签名发布；
10. 通过灰度门禁后发布稳定 V1。

## 17. 本轮环境记录

2026-09-04 本地默认沙箱刷新曾持续返回 helper_unknown_error，git clone 也发生连接重置。执行过程没有绕过来源和质量门禁：在用户已授权下载的范围内，改用 HTTPS 原始文件下载和受控命令执行；随后完成 JSONL 解析、manifest 校验、来源哈希校验、候选导入、引擎契约核对和影子编译。

验证结果：

- pnpm lexicon:verify-sources：通过，3 个来源、9 个文件；
- pnpm lexicon:validate：通过，63 个检测项、40 个风险、12 条候选白名单；
- pnpm lexicon:import-candidates：通过，生成 1,156 条隔离候选；
- pnpm lexicon:compile-shadow：通过，生成 155 条影子规则、10 条安全例外，跳过 2 条支持性动作；
- pnpm lexicon:generate-hard-negatives：通过，生成 44 条白名单边界集；
- pnpm lexicon:evaluate-shadow：通过，真实 GuardEngine V2 评测 44/44；
- pnpm lexicon:validate-production：按设计失败，证明候选状态、10,000 条和 A1/A2 最低覆盖门禁生效。
- 相关回归：21/21 通过；目标规则策略包专项 1/1 通过；TypeScript 与 ESLint 通过。
- 全量策略包测试仍有 1 个既有失败：工作树中的默认 DAG 已升级为 guard-default-dag-2，但旧测试仍断言 guard-default-dag-1；本批未修改该既有基线。
