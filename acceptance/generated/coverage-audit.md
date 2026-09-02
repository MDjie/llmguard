# 附件 101 项功能与性能要求逐条自动核对

> 本报告由代码生成。路径存在只证明代码/测试映射有效，不代表功能或性能验收通过。

- 需求总数：101
- 最终验收通过：0
- 待签名验收：101
- 映射路径异常：0

| ID | 优先级 | 需求 | 验收标准 | 实现状态 | 核对结论 | 尚缺内容 | 路径证据 | 最终验收 |
|---|---|---|---|---|---|---|---|---|
| ACC-001 | MUST | 支持OpenAI兼容REST API、HTTPS及招标要求的gRPC；兼容流式/非流式响应。 | 分别完成同步、SSE/流式和gRPC调用，输入输出均产生同一Trace ID。 | IMPLEMENTED_PENDING_TARGET_NETWORK_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| ACC-002 | MUST | 支持按模型/应用配置路由前缀、目标节点、权重、请求与响应字段映射、思考字段和WebSocket。 | 通过控制台接入两种不同接口结构的模型，不修改业务代码即可调用。 | PARTIAL_STATIC_ROUTING_MAPPING_WS_IMPLEMENTED_DYNAMIC_CONSOLE_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| ACC-003 | MUST | API支持mTLS、OAuth2/JWT、API Key等认证方式，并与统一身份平台对接。 | 未授权、过期、越权凭证被拒绝；认证事件进入审计日志。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| ACC-004 | MUST | 支持租户/应用/用户/API维度限流、并发、Token、输入长度和文件大小控制。 | 超限请求按策略拒绝或排队，不影响其他租户和核心服务。 | IMPLEMENTED_PENDING_TARGET_REDIS_CONCURRENCY_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| ACC-005 | MUST | 支持代理、SDK/组件、旁路审计和批量检测接入；策略可逐应用切换。 | 至少演示代理、API直检和离线样本三种方式。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| ACC-006 | MUST | 围栏异常时按应用配置fail-close、fail-open-with-alert或安全代答，禁止全局硬编码。 | 模拟检测引擎故障，三个场景分别执行预期降级并保留审计证据。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| ACC-007 | SHOULD | 提供Java/Python/Go SDK、接口样例、错误码、版本与退役策略。 | SDK集成示例可运行，API文档覆盖全部请求/响应字段。 | IMPLEMENTED_PENDING_TARGET_SDK_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IN-001 | MUST | 语义识别角色扮演、目标劫持、对立响应、道德绑架、反向诱导、威逼利诱和提示词泄露。 | 专项攻击集逐类给出召回、误报和处置结果。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IN-002 | MUST | 识别问题切片、长文本稀释、XML/INI/JSON策略伪装、Base64/Unicode/URL编码、字符变体和组合隐藏。 | 原始及变形攻击均映射到统一归一化内容和攻击类别。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IN-003 | MUST | 支持英语、法语、德语等主流语种、罕见语种/方言及文言文混淆检测。 | 多语种对抗集检出率达到项目统一阈值，日志记录原语种。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IN-004 | MUST | 检测递归、超长、复杂计算和诱导超长输出等恶意算力消耗攻击，准确率≥90%。 | 压力场景不触发资源失控；攻击检测准确率达到阈值。 | PARTIAL_RESOURCE_ABUSE_BASELINE_IMPLEMENTED_ACCURACY_AND_STRESS_POC_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IN-005 | MUST | 支持跨轮递进诱导，默认至少关联6轮，检测与样本工具支持至少10轮并可配置扩展。 | 多轮攻击在最终有害意图形成前或形成时被识别，展示风险累积轨迹。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IN-006 | MUST | 识别上传文本、Office/WPS、PDF/OFD、图片及常用压缩文件内容，校验真实文件类型和伪造后缀。 | 混合文件集、后缀伪装和嵌套压缩样本均有解析结果；加密文件进入受控处置。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IN-007 | MUST | 检测客户隐私、保单/健康信息、内部制度、源代码、凭证和商业秘密，进入模型前脱敏或阻断。 | 敏感字段测试集逐类型验证掩码、阻断和审计。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| MM-001 | MUST | 文本模态覆盖所有输入/输出攻击手法和有害内容类型，提供毫秒级同步检测。 | 文本POC满足攻击和白样本目标。 | PARTIAL_BUILTIN_ANALYZER_TARGET_MODELS_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| MM-002 | MUST | 图片同时采用OCR文本安全检测和视觉模型内容判别，覆盖截图及无文字有害图片。 | OCR命中文字风险与视觉风险分别展示并联合决策。 | PARTIAL_BUILTIN_ANALYZER_TARGET_MODELS_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| MM-003 | MUST | 识别图片拆分重排、遮挡、旋转、马赛克、压缩、噪声点和对抗扰动。 | 同一风险图片经多种扰动后仍达到约定检出阈值。 | PARTIAL_BUILTIN_ANALYZER_TARGET_MODELS_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| MM-004 | MUST | 采用跨模态融合分析图文协同攻击，能够识别单模态无害但组合有害的请求。 | 构造图文拆分样本，单模态低风险、联合输入正确升级并拦截。 | PARTIAL_BUILTIN_ANALYZER_TARGET_MODELS_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| MM-005 | MUST | 音频支持MP3、WAV、AAC、FLAC、WMA，单文件支持至500MB；结合ASR和音频分类检测。 | 各格式可解析；有害语音和音频指令正确识别并定位时间段。 | PARTIAL_BUILTIN_ANALYZER_TARGET_MODELS_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| MM-006 | MUST | 视频支持MP4、AVI、MOV、WMV，单文件支持至3GB；执行抽帧/关键帧、OCR/视觉和音轨ASR联合检测。 | 画面、字幕、音轨分别出具风险及时间戳，形成统一结论。 | PARTIAL_BUILTIN_ANALYZER_TARGET_MODELS_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| MM-007 | SHOULD | 多模态模型支持批次、抽帧间隔、置信度和高风险复核策略配置。 | 不同业务策略下检测成本、时延和召回变化可评测。 | PARTIAL_BUILTIN_ANALYZER_TARGET_MODELS_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AGT-001 | MUST | 检测网页、文档、邮件、工具返回结果中的间接提示注入和操作诱导。 | RAG文档注入样本被识别，恶意内容不得升级为系统指令。 | IMPLEMENTED_PENDING_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AGT-002 | MUST | 知识入库前执行来源可信度、内容安全、敏感数据和注入扫描，记录来源和版本。 | 不可信文档被隔离；检索结果可回溯到原文档、片段和扫描结论。 | IMPLEMENTED_PENDING_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AGT-003 | MUST | 区分系统指令、用户输入、检索上下文和工具返回的信任边界，禁止低信任内容覆盖高优先级指令。 | 优先级冲突测试中系统安全策略不可被检索内容改写。 | IMPLEMENTED_PENDING_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AGT-004 | MUST | 工具调用实施工具白名单、参数Schema、资源范围、频率和最小权限校验。 | 越权工具、非法参数、跨租户对象和超频调用均被阻断。 | IMPLEMENTED_PENDING_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AGT-005 | MUST | 高风险操作支持人机确认、双人复核或工作流审批，检测数据外传和提示词/密钥泄露。 | 转账、外发、删除等模拟高风险动作未经批准不得执行。 | IMPLEMENTED_PENDING_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AGT-006 | MUST | 会话记忆、向量空间、工具凭证和执行结果按租户/用户隔离。 | 跨用户记忆探测与向量检索不能获得其他主体数据。 | IMPLEMENTED_PENDING_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AGT-007 | SHOULD | 对复杂推理链按步骤累计风险，避免看似无害的分步问题推导出有害结论。 | 多步骤推理攻击显示每步证据、累计分和最终阻断点。 | IMPLEMENTED_PENDING_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OUT-001 | MUST | 覆盖31类生成内容风险：核心价值观8类、歧视9类、商业违法5类、权益侵害7类、特定服务2类。 | 标准题库覆盖完整，生成内容抽样合格率≥95%。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OUT-002 | MUST | 增加保险行业销售误导、收益夸大、投资诱导、条款误读、虚假承诺、违规营销话术等专项规则。 | 保险行业独立题库逐类测试并提供判定依据。 | PARTIAL_INSURANCE_RULE_BASELINE_IMPLEMENTED_INDUSTRY_DATASET_AND_MODEL_CALIBRATION_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OUT-003 | MUST | 自动识别客户隐私、健康、保单、财产、内部涉密和商业秘密，支持掩码、部分隐藏和整体阻断。 | 敏感字段分类准确，脱敏结果不可逆还原且保留最小审计证据。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OUT-004 | MUST | 高风险金融回答支持依据/来源核验、置信度、冲突检测和转人工，降低幻觉与错误建议。 | 无依据或来源冲突的高风险回答不得直接作为确定性结论输出。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OUT-005 | MUST | 支持标准拒答、风险类型代答、正向引导及转人工；按应用配置语气和品牌表达。 | 应拒答题库拒答率≥95%，非拒答题库拒答率≤5%。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OUT-006 | MUST | 处置动作至少包含放行、记录、告警、脱敏、替换、阻断、代答和人工复核。 | 每种动作可由策略触发，并记录动作前后内容摘要。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OUT-007 | MUST | 支持完整输出后检测、逐Token/分片检测和并行检测；补充只审计不阻断模式作为第四模式候选。 | 三种招标明确模式全部演示；第四模式经需求澄清后固化。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OUT-008 | MUST | 按GB 45438和标识办法对适用的文本、图片、音频、视频生成内容添加显式和元数据隐式标识。 | 不同模态通过标识一致性与元数据检查；内部豁免场景有适用性记录。 | IMPLEMENTED_PENDING_TARGET_MEDIA_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| POL-001 | MUST | 内置国家通用、31类风险、保险行业和攻击手法库，支持新增、编辑、启停、导入导出和版本。 | 各库可追溯来源、版本、生效范围和变更人。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| POL-002 | MUST | 自定义检测库支持关键字、正则表达式，请求+回复/仅请求/仅回复方向及联动动作。 | POC自定义规则配置后实时生效并命中。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| POL-003 | MUST | 支持用自然语言定义语义话题规则，自动生成测试样例并允许人工确认。 | 对未出现固定关键词的同义表达稳定检出。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| POL-004 | MUST | 白名单支持词、实体、语义样本和业务上下文，避免仅凭字符串全局放行。 | 反洗钱等正常业务被放行，但恶意上下文中的同词仍可拦截。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| POL-005 | MUST | 策略生命周期包含草稿、测试、审批、灰度、发布、监控、回滚和归档。 | 高风险策略未经审批不得发布；可一键回滚到指定稳定版本。 | IMPLEMENTED_PENDING_TARGET_DATABASE_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| POL-006 | MUST | 支持按租户、部门、AI应用、模型、用户群和业务场景继承/覆盖策略。 | 多个应用同一请求产生符合各自策略的差异化处置。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| POL-007 | MUST | 阻断提示和代答库支持文本/图片、风险类型、业务场景、版本、预览和恢复默认。 | 不同应用命中同类风险返回各自配置的合规代答。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| POL-008 | SHOULD | 提供阈值校准、A/B测试、影子模式和策略影响分析。 | 发布前可量化比较召回、误报、时延和业务影响。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| EVAL-001 | MUST | 建设不少于2000题的生成内容标准题库，覆盖31类风险；A.1/A.2每类≥50题，其余每类≥20题。 | 题库覆盖、数量、来源、版本和月度更新记录完整。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| EVAL-002 | MUST | 应拒答题库≥500题、覆盖17类风险且每类≥20题；非拒答题库≥500题并覆盖规定正向/中立主题。 | 题库抽查满足分类和数量要求。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| EVAL-003 | MUST | 扩展攻击题库覆盖目标劫持、反面诱导、角色扮演、隐含不安全观点、前缀、提示泄露、不安全主题、拒绝词限制、Payload拆分和混淆。 | 抽测≥300条，攻击成功率≤10%；另含RAG/Agent/多模态专项。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| EVAL-004 | MUST | 支持对话、纯文本、批量文件三种样本检测；对话至少10轮并支持图片。 | 样本仅进入围栏检测，不转发招标方业务大模型。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| EVAL-005 | MUST | 自动评估模型与人工专家交叉研判，支持盲测、复核、争议仲裁和badcase。 | 抽样复核记录含人员、结论、理由和一致性指标。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| EVAL-006 | MUST | 计算召回率、精准率、误报率、合格率、拒答率、负责率、攻击成功率、时延和资源指标。 | 公式、分母、无效样本处理和置信区间在报告中明确。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| EVAL-007 | MUST | 每次模型/规则重要更新执行回归测试和发布门禁；题库至少每月更新。 | 未达到门禁指标的版本不得进入全量生产。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| EVAL-008 | MUST | 生成标准化测评报告，包含基本信息、样本分布、指标、结论、横纵向对比、badcase和优化建议。 | 报告可导出并关联策略/模型版本和原始测试记录。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AUD-001 | MUST | 全量记录请求ID、账号、租户、应用、会话、输入/输出、检测节点、模型/规则版本、风险、置信度、动作、时间和操作人。 | 任一请求可按Trace ID重建完整检测链。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AUD-002 | MUST | 普通交互与告警至少保留180天，金融业务及审计日志至少1年；支持生命周期和归档策略。 | 查询180天记录；验证1年配置、归档和恢复。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AUD-003 | MUST | 审计日志采用追加写、防删除、防篡改、哈希校验/可信时间和权限隔离。 | 篡改模拟可被检测；管理员不能直接删除审计记录。 | IMPLEMENTED_PENDING_ENTERPRISE_TSA_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AUD-004 | MUST | 按账号、时间、风险、应用、内容、ID、处置和研判结果组合检索并导出。 | POC在规定时间内完成近180天模拟数据检索。 | PARTIAL_METADATA_SEARCH_IMPLEMENTED_RAW_CONTENT_RESTRICTED | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AUD-005 | MUST | 还原AI应用、模型、RAG和工具调用时序链路，高危节点高亮并提供证据解释。 | 告警详情展示命中敏感词/语义证据和上下游调用。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AUD-006 | MUST | 按日/周/月/季度生成平台运行、风险拦截、合规和异常事件报告。 | 报表可定时生成、下载，并保留生成参数。 | IMPLEMENTED_PENDING_TARGET_DATABASE_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AUD-007 | MUST | 通过Syslog、Kafka向安全运营/日志平台外发，支持级别、类型过滤和失败重试。 | 断链后不丢失，恢复后按序补发；字段映射可配置。 | IMPLEMENTED_PENDING_SOC_INTEGRATION_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OPS-001 | MUST | 大屏展示检测、告警、阻断、放行、趋势、风险分布、业务分布和高危事件。 | 支持24小时、7/30/180天及自定义时间范围。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OPS-002 | MUST | 告警研判包含事件分析、攻击手法、攻击危害和回答举证四个模块。 | 单条告警自动生成四部分并支持人工修订。 | IMPLEMENTED_PENDING_TARGET_DATABASE_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OPS-003 | MUST | 误报标记进入白样本库，支持向量泛化、检索、取消和回归验证。 | 误报优化不得全局静默真实攻击，发布前有影响评估。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OPS-004 | MUST | 事件状态支持待研判、处理中、误报、已阻断、已整改、已关闭及责任人/SLA。 | 告警可形成完整处置闭环并统计超时。 | IMPLEMENTED_PENDING_TARGET_DATABASE_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IAM-001 | MUST | 采用RBAC并支持系统管理员、安全管理员、审计管理员三员分立，以及分析、处置、查询等角色。 | 三类管理员互不越权；审计管理员独立查看管理操作。 | PARTIAL_EXTERNAL_SSO | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IAM-002 | MUST | 生产环境不设置可绕过三员分立的常用超级账号；仅保留受封存、双人授权、全审计的应急账号。 | 常规管理员无法获得全权限；应急启用产生告警与审批记录。 | PARTIAL_EXTERNAL_SSO | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IAM-003 | MUST | 按总公司、分公司、子公司、部门、业务线和应用实施数据分权与页面权限。 | 不同范围用户只能查看和处置授权数据。 | PARTIAL_EXTERNAL_SSO | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IAM-004 | MUST | 本地密码策略至少支持8位、90天、5次失败锁定5分钟，并可按公司标准加严。 | 策略参数可配置并验证锁定、过期和历史密码限制。 | IMPLEMENTED_PENDING_ENTERPRISE_POLICY_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IAM-005 | MUST | 支持统一登录、双因素认证、唯一身份检查、闲置超时、远程登录限制和离职账号锁定。 | SSO/2FA和账号生命周期联调通过。 | PARTIAL_EXTERNAL_SSO | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IAM-006 | MUST | 租户间计算、存储、网络、向量库、密钥和日志隔离。 | 执行跨租户越权与侧信道测试，无数据泄露。 | PARTIAL_EXTERNAL_SSO | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| IAM-007 | MUST | 所有控制面操作记录操作者、IP、时间、对象、前后值和结果。 | 策略、账号、模型和系统配置变更均可审计回滚。 | PARTIAL_EXTERNAL_SSO | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| DAT-001 | MUST | 按GB/T 43697和JR/T 0197建立数据分类分级，覆盖客户、保单、健康、财产、模型、提示词、日志和密钥。 | 数据目录包含分类、级别、责任人、保留期和控制策略。 | IMPLEMENTED_PENDING_CATALOG_DATA_ONBOARDING | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| DAT-002 | MUST | 传输采用TLS 1.2及以上；存储支持SM4或AES-256，敏感字段可列级加密/令牌化。 | 协议扫描和数据库抽查证明加密生效。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| DAT-003 | MUST | 密钥集中管理、分权使用、定期轮换、备份恢复和访问审计，禁止明文写入配置/镜像。 | 密钥轮换不影响业务；仓库和镜像扫描无明文密钥。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| DAT-004 | MUST | 原始敏感数据不出域，传给业务大模型前完成脱敏；外部检测器不得留存客户原文。 | 数据流和网络抓包验证无未经授权外传。 | PARTIAL | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| DAT-005 | MUST | 支持采集、存储、使用、共享、归档、逻辑删除、物理销毁和备份副本处理策略。 | 删除请求能定位生产、日志和备份中的处理结果。 | PARTIAL_DATABASE_PURGE_PROOF_IMPLEMENTED_EXTERNAL_STORES_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| DAT-006 | MUST | 训练/评测数据具备来源、许可、去重、质量、敏感检测、标注和版本谱系。 | 任一样本可追溯来源、加工、标签和使用模型。 | PARTIAL_RUNTIME_LINEAGE_IMPLEMENTED_DATASET_LICENSE_LABEL_MODEL_USE_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| DAT-007 | MUST | 生成内容标识服务与输出检测协同，支持显式标识、文件元数据、标识校验和传播场景策略。 | 按GB 45438测试文本、图像、音频、视频标识。 | IMPLEMENTED_PENDING_TARGET_MEDIA_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| INT-001 | MUST | 与AI中台/AI网关集成，统一纳管模型API、应用和Agent调用。 | 至少完成两类模型、一个RAG和一个Agent端到端联调。 | PARTIAL_EXTERNAL_INTEGRATION | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| INT-002 | MUST | 与统一身份、短信/邮件、日志平台、监控告警和安全运营中心对接。 | 接口联调清单全部通过并提供失败补偿测试。 | PARTIAL_EXTERNAL_INTEGRATION | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| INT-003 | MUST | API全生命周期执行设计、认证、版本、文档、兼容、监控和退役管理。 | 旧版本在约定窗口可用，退役有通知和迁移证据。 | PARTIAL_EXTERNAL_INTEGRATION | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| INT-004 | MUST | 支持关系、向量、对象和文档存储；支持去重、分词、标准化和向量化。 | 不同数据类型按架构落库并验证权限与备份。 | PARTIAL_EXTERNAL_INTEGRATION | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| INT-005 | SHOULD | 提供策略、告警、审计、评测和报表开放API，避免控制台锁定。 | 外部系统可自动创建测试、查询结果和拉取报表。 | PARTIAL_EXTERNAL_INTEGRATION | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| PER-001 | MUST | 黑样本召回率≥95%、精准率≥95%；POC 2000条文本攻击拦截率按≥99%验收。 | 独立盲测；2000条中漏拦≤20条。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| PER-002 | MUST | 2000条白样本误拦截率≤1%。 | 独立盲测；误拦≤20条，报告分业务和类别结果。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| PER-003 | MUST | 快速分类模型响应≤200ms、准确率≥98%；主链路P99≤300ms（不含大模型推理）。 | 全量检测配置、目标信创环境压测。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| PER-004 | MUST | 单节点≥20QPS，集群≥200QPS；支持弹性扩容且不中断在线业务。 | 持续30分钟稳定压测，无错误率或资源超限。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| PER-005 | MUST | 支持≥3000并发会话和≥300管理控制台在线用户。 | 并发测试无明显UI卡顿、功能错误或会话串扰。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| PER-006 | MUST | 设计容量下CPU峰值≤80%、内存≤75%，资源可实时监控和回溯。 | 压测报告提供CPU、内存、GPU/NPU、磁盘、网络曲线。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AVA-001 | MUST | 7×24运行，全年整体可用性≥99.99%。 | 可用性统计口径、排除项和监控证据纳入SLA。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AVA-002 | MUST | 数据面多实例、控制面多副本，中间件高可用，无单点故障。 | 随机停止实例/节点，核心请求不中断或按策略快速恢复。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AVA-003 | MUST | 支持Kubernetes容器化、虚拟机和物理机部署；镜像、脚本和运维手册完整交付。 | 至少在目标K8s信创环境完成安装、扩缩和卸载。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AVA-004 | MUST | 业务、模型和依赖升级支持滚动/蓝绿/金丝雀、流量分流和快速回滚。 | 升级过程无损，客户配置与定制功能保留。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| AVA-005 | MUST | 支持全量/增量备份、异地副本、恢复演练、两地三中心；RPO/RTO由BIA最终确认。 | 按暂定RPO≤15分钟、平台RTO≤30分钟完成恢复演练。 | HARNESS_READY_EXTERNAL_RUN_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| SEC-001 | MUST | 满足等保二级建设和测评，完成身份、访问、审计、边界、主机、应用、数据和管理控制。 | 取得有资质机构的测评报告或完成合同约定整改闭环。 | HARNESS_READY_EXTERNAL_ASSESSMENT_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| SEC-002 | MUST | 软件供应链提供SBOM、依赖与镜像漏洞扫描、镜像签名、最小镜像和可信来源。 | 高危漏洞清零或有经批准的风险接受与补偿控制。 | HARNESS_READY_EXTERNAL_ASSESSMENT_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| SEC-003 | MUST | 实施SAST/DAST/SCA、渗透、API安全、容器/K8s基线和密钥扫描。 | 交付安全测试及渗透报告，问题全部闭环。 | HARNESS_READY_EXTERNAL_ASSESSMENT_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| SEC-004 | MUST | 支持国密算法与证书体系，密码能力与公司统一技术栈兼容。 | TLS/国密套件、密钥和密码应用配置通过检查。 | HARNESS_READY_EXTERNAL_ASSESSMENT_REQUIRED | HARNESS_ONLY | 仅具备自动化框架，必须在目标环境执行并提交签名结果 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| XIN-001 | MUST | 支持鲲鹏、飞腾、海光、兆芯CPU，昇腾910B/910C等国产算力，麒麟/UOS，达梦/金仓/神通/GaussDB及国产中间件。 | 提交兼容矩阵、互认证、同类案例和目标环境POC。 | PARTIAL_PORTABILITY_BUILD_AND_SCHEDULING_ABSTRACTION_IMPLEMENTED_TARGET_ADAPTER_POC_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| XIN-002 | MUST | 不强制绑定单一硬件品牌；采用容器化和抽象层屏蔽底层差异。 | 更换兼容硬件组合后核心功能和指标仍满足要求。 | PARTIAL_VENDOR_NEUTRAL_OCI_AND_RUNTIME_ABSTRACTION_IMPLEMENTED_TARGET_SWAP_POC_PENDING | PARTIAL | 只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成 | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OBS-001 | MUST | 统一仪表盘展示基础设施、GPU/NPU、响应、吞吐、错误率、队列、检测器和依赖状态。 | 告警阈值、趋势和历史查询可验证。 | IMPLEMENTED_PENDING_ENVIRONMENT_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
| OBS-002 | MUST | 集中日志和分布式追踪覆盖一次推理请求全链路，并区分业务错误与AI服务错误。 | Trace ID贯通网关、检测器、模型、RAG和工具。 | IMPLEMENTED_PENDING_ENVIRONMENT_POC | CODE_IMPLEMENTED_ACCEPTANCE_PENDING | 代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC | MAPPING_PATHS_VALID | NOT_ACCEPTED |
