"""Write the execution handoff from recomputed evidence; never publish a policy."""
import collections, datetime, hashlib, json, shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
WORK=ROOT/".artifact-build/detection-repair-20260908"
OUT=ROOT/"输出/测试报告/2026-09-08/detection-repair-v1"
DOCS=ROOT/"输出/代码分析与升级"
def read(p):return json.loads(p.read_text(encoding="utf-8"))
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2),encoding="utf-8")
def link(rel,label=None):
    p=ROOT/rel
    return "["+(label or Path(rel).name)+"](<"+p.as_posix()+">)"
def percent(x):return "—" if x is None else f"{x*100:.2f}%"
def metric(row):return f"{row['tp']}/{row['positive']}（{percent(row['recall'])}）"
def main():
    data=read(OUT/"paired-analysis.json");release=read(WORK/"release-manifest.json")
    fallback=read(WORK/"candidate-final/batch-fallback-summary.json")
    audit=read(WORK/"candidate-final/rule-audit.json")
    kinds=collections.Counter(item["disposition"] for item in audit["audit"])
    evidence=OUT/"工程验收证据";evidence.mkdir(exist_ok=True)
    for filename in ["unit-release.log","type-release.log","type-integration.log","lint-release.log","lint-integration.log",
                     "contracts.log","docker-app-build.log","docker-worker-build.log","release-manifest.json",
                     "network-fence-probe.json","capacity-probe.json","app-smoke.json","release-effects.json"]:
        if (WORK/filename).exists():shutil.copy2(WORK/filename,evidence/filename)
    shutil.copy2(WORK/"worker-receiver/release-effects.json",evidence/"worker-image-release-effects.json")
    shutil.copy2(WORK/"media-transforms/verification.json",evidence/"actual-media-transform-verification.json")
    save(evidence/"fallback-139-summary.json",fallback)
    implementation={
      "D00":("PASS","代码、镜像、签名载荷、45 文件的数据清单及威胁矩阵已冻结；记录并保留其他工作区修改。"),
      "D01":("PASS","候选/确认/硬拒绝角色统一；当前与历史合并证据和动作约束，历史变换文本与历史坐标不释放。"),
      "D02":("PASS","输出变换后建立新来源摘要与父谱系；复检不携带失效的原工具来源引用，原动作授权仍校验。"),
      "D03":("PASS","引入有注册生产者的类型化 DLP 实体、范围校验及故障分类；139 条旧故障候选回放为零故障。"),
      "D04":("PASS","按每次命中及来源局部解释引号、否定、预防、研究和执行意图；不再用整段安全词统一豁免。"),
      "D05":("PASS","Unicode 词边界、受限复合规则、规范化方式校验与治理导入贯通；规则命中数量在上下文筛选后限额。"),
      "D06":("PASS","按来源分段规范化并显式返回覆盖与停止原因；保留跨片段原文中的签名硬拒绝；预算不放宽。"),
      "D07":("PASS","必要检测控制不可条件跳过，预留预算，终止判定与最终动作一致，变换类命中不等同最终 BLOCK。"),
      "D08":("OFFLINE_PASS","完成 81 条旧规则的自动审计迁移和 56 条候选规则；正反例通过，独立金融专业审阅和开放域质量未通过。"),
      "D09":("OFFLINE_PASS","来源—行为—受保护目标的有界关系检测接入执行图；明确指代可追溯，工具权限与副作用仍独立强制校验。"),
      "D10":("PASS","会话跨轮链路绑定租户/应用/会话及目标；故障与攻击行为分账；无关阶段词和超时不累积成恶意锁定。"),
      "D11":("OFFLINE_PASS","多模态协同标识要求对象/引用/时序关系，保留单路阻断；真实编解码通过，原生多模态语义质量未验收。"),
      "D12":("PASS","正式离线 CLI、断网防护、每样本检测节点/覆盖/干预漏斗、断点身份校验和可复算报告已落地。"),
      "D13":("PASS","编译/运行/发布能力契约贯通；拒绝未知检测器、缺失必要节点、不兼容版本与不足预算；兼容性不充当质量合格。"),
      "D14":("IN_PROGRESS","全量三批、诊断消融、139 专项及接收端组件验证已完成；G1 失败，独立留出/原因复核/完整生产代理链及语义模态验证未完成。"),
      "D15":("IN_PROGRESS","候选应用与 Worker 镜像已构建并隔离验证；按既定质量门禁停止生产发布，未执行灰度与切换。"),
    }
    task_path=DOCS/"26_detection-architecture-repair.tasks.v1.json";plan=read(task_path)
    for task in plan["tasks"]:
        state,notes=implementation[task["id"]]
        task["engineeringStatus"]=state
        task["qualityStatus"]="NOT_QUALIFIED" if task["id"] in ["D04","D05","D08","D09","D11","D14","D15"] else "G0_VALIDATED_ONLY"
        task["deploymentStatus"]="BLOCKED_QUALITY_GATE" if task["id"]=="D15" else "NOT_DEPLOYED"
        task["executionNotes"]=notes
        task["evidence"]=["输出/测试报告/2026-09-08/detection-repair-v1/paired-analysis.json",
                          "输出/测试报告/2026-09-08/detection-repair-v1/工程验收证据",
                          "输出/代码分析与升级/28_检测架构增量修复执行与回归报告_2026-09-08.md"]
    plan["execution"]={"updatedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"mainHeadAtImageBuild":release["mainHead"],
       "replayCodeHash":data["codeHash"],"candidatePayloadHash":data["policyHash"],
       "G0":"PASS_DETERMINISTIC_REGRESSIONS","G1":"FAIL_QUALITY_AND_INDEPENDENCE","G2":"PARTIAL_COMPONENT_TRANSPORT_AND_CODEC",
       "production":"UNCHANGED","productionPolicyPublished":False,"allTasksComplete":False,
       "reason":"Follow the agreed gates: do not claim full acceptance or publish a candidate that has not qualified.",
       "existingWorkspaceChangesPreserved":True}
    save(task_path,plan)
    native=data["groups"]["native_test_dedup_train_disjoint"];old=native["baseline"];new=native["candidate"]
    batch_table="\n".join(f"| {s['batch']} | {s['totalCases']:,} | {s['errors']} | {s['degraded']} | {s['network']['externalModelCalls']} |" for s in data["batchSummaries"])
    task_table="\n".join(f"| {key} | {state} | {notes} |" for key,(state,notes) in implementation.items())
    dataset_table=[]
    for key,values in data["groups"].items():
        if key.startswith("dataset:") and ("/test/" in key or "/unspecified/" in key) and values["candidate"]["scored"]:
            a,b=values["baseline"],values["candidate"]
            dataset_table.append(f"| {key[8:]} | {b['positive']:,}/{b['negative']:,} | {a['tp']} → {b['tp']} | {percent(a['recall'])} → {percent(b['recall'])} | {a['fp']} → {b['fp']} | {percent(a['falsePositiveRate'])} → {percent(b['falsePositiveRate'])} |")
    ablation_table="\n".join(f"| {name} | {item['diagnosticMetrics']['faults']} | {item['diagnosticMetrics']['scored']:,} | {item['diagnosticMetrics']['tp']} | {item['diagnosticMetrics']['fp']} |" for name,item in data["ablations"].items())
    confidence=", ".join(percent(v) for v in new["recallWilson95"])
    report=f"""# 大模型护栏检测架构增量修复执行与回归报告
日期：2026-09-08。对应原 D00–D15 计划；工作分支 main。裁判模型与外部模型均未参与本轮回放。

## 1. 执行结论

已在 main 工作区实施检测链路的工程增量，完成 250 个测试文件、1,633 项单测，类型、静态与契约检查；三批 360,380 条全部完成回放。原 139 条 DLP 输出故障在候选方案中全部消除，真实 HTTP 接收端组件、Worker 镜像内同组测试及媒体编解码专项通过。

**候选方案不具备上线资格。** 在去重并排除同数据集训练文本重复的原生 test 子集中，共同可评分样本 {new['scored']:,} 条：严格拦截召回率由 {percent(old['recall'])} 降至 {percent(new['recall'])}，误拦截率由 {percent(old['falsePositiveRate'])} 降至 {percent(new['falsePositiveRate'])}。误拦截减少伴随检出减少，不能认定总体检测能力已提升。G1 未通过，G2 仅部分验证；D14、D15 仍有明确未完成项，未提交虚假的全项完成结论。

本轮没有发布、签名激活或灰度候选规则包，也没有替换生产应用。代码修改与候选镜像均已形成可审阅结果；本轮未提交或推送 Git。

## 2. 冻结基线及证据边界

- 原测试代码版本 db4a31b0037d4c1a1646cd32421bac1434a957da；原包代次 3、81 条规则、guard-default-dag-2 的 7 个节点。
- 本轮开始审查 HEAD 为 8cfcc9441a879346c0abe2159679a976aadab5f9，构建时 main HEAD 为 {release['mainHead']}。期间其他修改已进入 main，原有改动全部保留。
- 回放代码指纹：{data['codeHash']}。该指纹覆盖 src、scripts/content-safety 与生成契约，完整构建还依赖锁文件、构建配置等；它不是 Git 提交号或整个镜像摘要。
- 候选载荷指纹：{data['policyHash']}；126 条规则、guard-default-dag-5 的 16 个节点、最大执行成本 19。载荷状态为未发布候选，不冒充生产签名包。
- 冻结后 src/lib/policy-governance/runtime.ts 出现独立的运行摘要容错修改。该文件不在本次固定引擎回放及已构建镜像的相同版本集合中；保留此修改，并在 manifest 中记录差异，不将镜像称为最新整个工作区。
- 数据集、每条文本、标签、原包、候选载荷、结果和源代码指纹均可复核。原始数据/私有策略快照保留在原目录；公开报告不复制密钥和原始对话正文。

{link('输出/测试报告/2026-09-08/detection-repair-v1/code-index.json','代码指纹索引')}；
{link('输出/测试报告/2026-09-08/detection-repair-v1/工程验收证据/release-manifest.json','构建及运行清单')}。

## 3. D00–D15 逐项执行状态

PASS 表示对应工程实现与已列的确定性回归通过；OFFLINE_PASS 表示实现及局部/离线验证通过，仍未获得完整质量验收。二者都不等同生产可发布。

| 任务 | 工程状态 | 已执行工作及剩余边界 |
|---|---|---|
{task_table}

机器可读状态已回写 {link('输出/代码分析与升级/26_detection-architecture-repair.tasks.v1.json','任务清单')}。原始设计见 {link('输出/代码分析与升级/26_大模型护栏检测架构深度评审与可执行修复方案_V1.0_2026-09-08.md','设计方案')}。

## 4. 已落地的检测架构与详细行为

### 4.1 证据角色、执行图与动作约束

所有显式 CANDIDATE、CLEARED、UNKNOWN 证据都不会因为 score 较高而自动变成确认风险。旧版未显式给角色的证据继续兼容。未解决候选按现有 v1/v2 策略分别进入 WARN/REQUIRE_REVIEW；没有批量切换已签名旧包的决策版本。

会话与 RAG 合并复用动作约束，并保留当前、历史双方证据。历史证据的坐标不冒充当前文本坐标，历史变换文本不作为当前回复。REQUIRE_REVIEW 不被 SAFE_RESPONSE 覆盖。

调度器和最终聚合共用终止语义：可以 MASK/REWRITE 的高分输出命中不是最终拦截；必要 DLP、受保护上下文与关系控制必须 ALWAYS/FAIL_CLOSED。调度预留必要节点预算，记录执行/跳过/故障的节点原因，旧签名 DAG 按原声明执行而非悄悄加节点。

入口：{link('src/lib/guard-engine-v2/observation-policy.ts')}、{link('src/lib/guard-engine-v2/dag.ts')}、{link('src/lib/guard-engine-v2/session-context.ts')}。

### 4.2 类型化 DLP、输出派生和复检

新增 guard-dlp-entity-1 实体契约。仅注册的结构化 DLP/输出 DLP 生产者且证据角色已确认时，才可进入变换；实体类别、置信度、UTF-16 范围、重复及数量均校验。普通词法命中不能伪装成可脱敏实体。

输出变换后重新计算摘要、范围、派生来源和父来源关系。原动作意图先对原来源完成校验，复检请求只检测新输出内容，不把旧工具授权引用移接给 AGENT 内容。变换的剩余真实风险、复检不可用、证据缺失/无效分别记录；故障不会当作攻击检出。复检命中证据指向派生视图，取消容易误导的原文坐标。

原 139 条故障复测：ALLOW 19、MASK 113、WARN 5、BLOCK 2，执行错误/降级均为 0。两条 BLOCK 分别命中凭据泄露和复检后的来源关系约束；其源输出没有原生风险标签，不能据此宣布两条都是正确拦截。当前剩余规则命中依据已保留。

入口：{link('src/lib/dlp/entity-contract.ts')}、{link('src/lib/output-control/intervention.ts')}、{link('src/lib/output-control/security-event.ts')}。

### 4.3 每次命中的上下文、复合规则和词库治理

上下文判断从整段泛化改为每次命中的同来源局部窗口，考虑句界、转折、引号、否定、预防目的及执行要求；同文的良性前缀不会遮蔽后面的真实风险命中。Unicode 词边界阻止 DAN 命中 dangers/standard 等子串。规范化方式必须来自登记表，拼写错误直接拒绝。

复合规则限定为同子句最多 8 个必要/任选原子、最多 160 个 UTF-16 单元距离以及受限 RE2 表达式，保留关系证据。规则可明确声明 SIGNAL 或 DETERMINISTIC_RISK，约束跟随字典导入、编译、签名载荷和运行时验证，不靠一条大白名单取消安全检测。

对原 81 条规则生成逐条处置清单，分布为：{dict(kinds)}。去重、退役旧类型不明的 PII 规则及信号降级后保留 70 条，再加入 56 条候选，总计 126 条。新增规则含 32 条双语领域规则与 24 条金融规则；每条有正反例，共 112 条工程样例通过。这是候选开发样例，不是独立金融测评集，也不代表完整金融行业覆盖或专家双人复核已完成。

入口：{link('src/lib/guard-engine-v2/intent-context.ts')}、{link('src/lib/guard-engine-v2/rule-constraints.ts')}、
{link('src/lib/guard-engine-v2/lexical-matcher.ts')}、{link('data/content-safety/lexicon/detection-repair-v1.candidate.json')}、
{link('输出/测试报告/2026-09-08/detection-repair-v1/rule-audit.json','81 条规则审计')}。

### 4.4 有界规范化与来源关系

按来源分别建立原文及解码视图，防止把两个来源拼接后“解码出”并不存在的指令。原始拼接正文中的签名硬拒绝仍跨分段扫描并绑定双方来源，RAG 回归已通过。

默认 3 轮/3 层、24 个单来源视图、每视图 16 个分支、4 MiB 累计文本字节、16 倍扩展约束。多来源基础原文单独预留，最多 256 个来源，派生视图共享预算。250 ms 限额是实际使用 performance.now 计算的墙钟耗时，并非独占 CPU 计量。4 MiB 指文本累计字节，不是 JavaScript 堆内存上限。COMPLETE 只代表声明的探索范围内完整。

新增有限关系检测器，绑定来源、行为、受保护目标及对象/时间证据。跨来源的明确指代、对象绑定和受约束时序关系可以确认协同；仅时间接近、文本并列或分数相加不确认协同。该检测器主要消费原文视图及提取文字，不宣称解决任意编码、开放域行为推理或原生视听语义。分类结果不会授予工具权限，原有工具参数、目标、权限、批准与执行凭证约束继续生效。

入口：{link('src/lib/guard-engine-v2/normalization.ts')}、{link('src/lib/guard-engine-v2/risk-relations.ts')}、
{link('src/lib/guard-engine-v2/relation-detector.ts')}、{link('src/lib/tools/action-firewall.ts')}。

### 4.5 会话与多模态

会话关联绑定租户/应用/会话范围与受保护目标指纹；目标延续和有限时间窗有证据时才形成攻击链。一般“先铺垫、再角色、再执行”等词序不再足以锁定会话；检测超时与历史控制动作不反馈累积成恶意行为。

多模态分数升高和 cooperativeAttack 分开：后者要求明确的多来源关系证据。单路 BLOCK 保留，缺失关系/预算证据会返回覆盖不足。现存拼接启发式仍可能独立触发 BLOCK，本轮没有把全部旧多模态启发式替换为完整关系语义模型。

真实编解码仅验证了图片黑区、双声道静音、裁剪时间映射、解码后视频黑帧、源摘要替换拒绝。工程生成的图片/音频/视频不是原生攻击语料，ASR、OCR、视觉语义、缺帧漏检及真实混合攻击质量仍未获得本轮验收。

入口：{link('src/lib/secure-memory/session-risk-state.ts')}、{link('src/lib/multimodal/fusion.ts')}、{link('src/lib/media/timeline-fusion.ts')}。

### 4.6 可审计回放与发布契约

正式 CLI 复用完整生产引擎、输出干预及复检，默认禁止 fetch 和 Socket 连接，拒绝含启用模型的载荷；两种网络调用方式均经反向探针验证被拦截。每样本保存节点轨迹、覆盖、证据角色、动作、变换/复检摘要和执行状态，不写生产事件。

恢复执行必须同代码、同载荷、同输入文件摘要；案例 ID 重复和身份变化会失败。报告重算区分 NO_RAW_MATCH、SIGNAL_UNRESOLVED、CONTEXT_SUPPRESSED、确认拦截、干预故障和检测降级。离线动作不能冒充 HTTP/工具/媒体接收端效果。

新增已签名能力声明区分文本能力与多模态提取能力，验证规范化版本、登记检测器、必要节点及预算；兼容性报告明确不颁发质量合格结论。新发布路径接入能力门禁，旧包执行及回滚保持兼容。

入口：{link('scripts/content-safety/replay-offline.ts')}、{link('src/lib/guard-engine-v2/decision-funnel.ts')}、
{link('src/lib/policy-bundle/detection-capabilities.ts')}。

## 5. 三批全量回放与统计口径

| 批次 | 任务数 | 执行错误 | 降级/覆盖不足 | 外部模型调用 |
|---|---:|---:|---:|---:|
{batch_table}
| 总计 | 360,380 | 1 | 2 | 0 |

第三批及全量对账已完成。两条覆盖不足分别为 ChineseSafe:test:13850:input 与 SafetyBench:test:1069:input，达到视图上限后仍返回原文及已探索视图，明确标 PARTIAL；当前候选最终动作均为 ALLOW 且 degraded，不应被视为完整安全放行证明。一条执行错误为 ToxicChat:test:2178:output 的 RESOURCE_BUDGET_EXCEEDED；原错误没有记录 budgetName，单例三次重放均恢复正常，原因不能仅凭此认定为 CPU 竞争或 GC，原错误保留计数。

完整数据含 252,061 条无风险标签任务、4 条空白、按 dataset/split/role/规范化文本摘要计算的 52,616 次重复出现。12 个冲突组在原始任务中共出现 81 次，均属 PKU 训练输出；按完整任务权重排除整组，不能只排除一个代表条目。训练重复、冲突、空白及故障的统计维度可重叠，表中的排除字段按明示顺序计数，不能任意相加。

主配对指标使用两个版本都无执行故障的共同分母，排除未标注、空白和标签冲突；另报原始标签全分母保守召回，故障绝不作为 TP。STRICT BLOCK 需正常执行、至少一个确认风险且最终 BLOCK；MASK/REWRITE/SAFE_RESPONSE/REQUIRE_REVIEW 的保护动作另计，不混称拦截。

原生 test、训练集、split 不明的 ToxiCN、数据集意图弱标签、无标签和人工探针分别保留。PKU 只给输出评分，ToxicChat 不把输入标签挪给输出，SafetyBench 不伪造多选题正确率。

### 5.1 去重且与训练文本不重复的原生 test 诊断子集

| 指标 | 原冻结结果 | 候选方案 |
|---|---:|---:|
| 共同有效正/负例 | {old['positive']:,}/{old['negative']:,} | {new['positive']:,}/{new['negative']:,} |
| 确认严格拦截 TP | {old['tp']} | {new['tp']} |
| 错误严格拦截 FP | {old['fp']} | {new['fp']} |
| 严格拦截召回率 | {percent(old['recall'])} | {percent(new['recall'])} |
| 误拦截率 | {percent(old['falsePositiveRate'])} | {percent(new['falsePositiveRate'])} |
| 确认检测召回率（不限动作） | {percent(old['confirmedRecall'])} | {percent(new['confirmedRecall'])} |
| 准确率 | {percent(old['accuracy'])} | {percent(new['accuracy'])} |
| 原始标签全分母保守严格召回 | {percent(old['operationalStrictRecall'])} | {percent(new['operationalStrictRecall'])} |

候选召回率的 Wilson 95% 区间为 [{confidence}]。区间是给定样本口径下的比例不确定性描述，不消除来源/模板相关性。这些数据在设计阶段已看过，因此即使是原生 test 或训练文本不重复，也不是独立留出认证。

### 5.2 原生数据集逐项配对结果（原任务权重）

| 数据集/划分/方向 | 有效正/负例 | TP 原→新 | 召回 原→新 | FP 原→新 | 误拦截 原→新 |
|---|---:|---:|---:|---:|---:|
{chr(10).join(dataset_table)}

ChineseSafe 和 ToxiCN 的误拦截仍增加；PKU 和英文上下文样本的误拦截显著下降，同时 TP 下降。不能用跨数据集合并均值掩盖这些退步。固定 POC 的攻击 2,000 条由 45 条严格拦截降为 38 条，安全 2,000 条误拦截由 15 降为 11，同样未达到发布要求。

### 5.3 固定诊断集的策略消融

12,815 条诊断输入包含 12,800 条原回放样本和 15 条人工探针。下面仅比较原样本，并将任一变体中的故障/冲突并入共同排除集；所有行评分分母相同。人工探针结果在 JSON 中另列。

| 变体 | 原样本故障数 | 共同可评分分母 | TP | FP |
|---|---:|---:|---:|---:|
{ablation_table}

原冻结结果是旧代码旧包；signed-baseline 为当前冻结代码执行原签名包；dag-upgrade 只升级显式 DAG（不含来源关系）；boundary 在前者上迁移旧规则；no-relations 再加 56 条候选规则；candidate 最后加入来源关系。

所有当前变体共用同一代码指纹，只有载荷维度受控变化；“旧代码→新代码”包含多项共同代码变化，不能称为单一修复的因果消融。诊断集经过富集选择，不代表全业务分布。

关键观察：新词库在此固定共同样本中仅增加 4 个 TP；来源关系没有新增该子集的有标签 TP，改变的是额外输出复检约束。修复 DAG 可显著减少执行故障，但不会凭空增加缺失的领域判断能力。规则边界校正同时移除了错误命中和此前偶然命中的风险样本；只有重新建立与真实风险行为对齐的证据，才能补足召回。

## 6. 工程测试、真实效果及其限制

| 验证 | 结果 | 说明 |
|---|---|---|
| 单测 | 250 文件 / 1,633 项 PASS | 角色、边界、预算、RAG、派生来源、实体、会话、关系、能力契约等 |
| 类型/静态/契约 | PASS | 包括新增接收端测试脚本；历史生成输出目录不参与 TS 生产代码检查 |
| Next 生产构建 + Worker 构建 | PASS | 新标签保留旧镜像，不替换生产 |
| 原 139 故障专项 | 零执行错误/降级 | 113 MASK；输出无标签部分不报准确率 |
| 真实媒体变换 | 5 项 PASS | 合成媒体，非原生语义攻击质量 |
| HTTP 接收端组件 | 6 项 PASS | 脱敏实际到达客户端、凭据阻断、跨片 SSE、正常 SSE、无权限工具零副作用 |
| Worker 镜像内相同组件测试 | 6 项复测 PASS | 同组测试重复验证，不报成 12 个独立场景 |
| 隔离应用存活 | /api/health/live 200 | /api/health/db 503，因测试容器断网且没有数据库；未冒充业务就绪 |
| 外连反向探针 | fetch 与 Socket 均被阻断 | 探针 2 次“尝试”皆失败；正式回放外连尝试 0 |
| 完整生产代理、认证/限流、持久化 permit 消费 | 本轮未验收 | 组件 HTTP 不等于完整生产代理 E2E |
| 原生音视频及多模态语义质量 | 本轮未验收 | 需要真实带时间/区域标注的攻击及良性配对样本 |

证据目录：{link('输出/测试报告/2026-09-08/detection-repair-v1/工程验收证据','工程验收证据')}。
测试入口：{link('scripts/integration/check-detection-release-effects.ts')}、{link('scripts/integration/check-media-transforms.ts')}。

## 7. 未通过项及后续准入条件

G0 的确定性工程回归通过。G1 继续采用原有效门槛：样本至少 2,000、准确率/召回率至少 95%、误拦截率不超过 1%、漏检率不超过 5%；本轮不降低门槛。当前共同诊断子集只满足样本量与误拦截率，准确率、召回、漏检及独立性不合格。G2 只完成组件接收端与编解码验证。

| 剩余项 | 下一项具体工作 | 验收证据/责任角色 |
|---|---|---|
| 开放域召回与新增误拦截 | 根据 changed-cases、candidate-failures、ablation-deltas 按来源/模板族聚类；逐条复核“旧 TP 丢失、新 FP 增加”的行为/对象/上下文，再补领域判定能力，不追补危险子串 | 检测工程 + 内容安全；各域原因对齐、正反配对回归与固定旧基线对比 |
| 独立留出及金融专业复核 | 未接触的来源/模板族单独封存；由独立审阅角色给出风险、方向、实体范围、处置动作和争议裁定；不得用 112 条开发正反例替代 | 评测负责人 + 金融合规审阅；来源许可、分组隔离及双人记录 |
| 资源预算与 PARTIAL 的业务策略 | 对原单例及同编码族做专用环境压测，保留触发 budgetName/负载证据；由现有策略明确覆盖不足应 WARN、REQUIRE_REVIEW 或 fail closed 的场景 | 性能/平台安全；固定预算与完整故障分母。当前没有擅自放宽预算 |
| 原生多模态质量 | 真实 OCR/ASR/视觉提取与攻击源绑定，覆盖缺帧、漏音、字幕冲突、区域遮挡、跨模态指代及实际接收端 | 媒体/评测；区域/时间真值、提取错误率、攻击召回与良性误拦截分别报告 |
| 完整生产链回归 | 在独立测试数据库、真实代理和短期测试身份下，验证 HTTP/SSE、认证限流、工具批准/凭证消费及真实执行回执 | 平台/测试；不能由本轮组件脚本代签完整 G2 |
| D15 生产灰度 | G1/G2 与业务复核合格后，先重建当前冻结完整工作区，核对签名包能力与镜像，再走现有签名/审批/灰度流程 | 发布负责人；保留原镜像、原签名包和回滚记录 |

这些是尚未完成的验收与能力缺口，不是已经成功发布后的观察事项。当前规则与结构化关系方法覆盖不到大多数开放域内容风险；本轮明确排除了新神经分类器训练与裁判调整，不能通过继续堆叠少量词条承诺 95% 召回。

## 8. 候选交付物与生产状态

候选应用：{release['images']['app']['tag']}，镜像摘要 {release['images']['app']['imageId']}。
候选 Worker：{release['images']['worker']['tag']}，镜像摘要 {release['images']['worker']['imageId']}。

原 17 个生产容器保持原部署配置；应用仍是原 db4a31b 构建。隔离烟测容器已停止。镜像只用于固定版本验收，生产环境未切换；冻结之后的独立运行摘要修改已经记录为版本差异。

发布之前必须重新核对整个工作区的代码、锁文件、构建配置、镜像与候选载荷。禁止覆盖本轮结果的代码/载荷摘要来伪造“同版本重跑”，禁止为了新包激活去补假审批或降低既有阈值。

## 9. 复现、审阅与数据复核

在准备好的工作区中，用新输出目录执行以下命令，依次把 batch 改为 1、2、3。若源码摘要不同，必须产生新结果目录，不能续写本轮候选目录。

    pnpm detection:replay-offline --run-dir .artifact-build/eval-three-db4a31b-20260908-104343 --output-dir .artifact-build/repair-replay-new --variant candidate --batch 1

139 专项通过相同入口指定 batch fallback 与 fallback-input.jsonl。诊断变体支持 signed-baseline、dag-upgrade、boundary、no-relations、candidate；其共同输入为原 diagnostic-input.jsonl。

报告重算程序：{link('scripts/qa/analyze_detection_repair.py')}；报告与任务清单生成程序：{link('scripts/qa/write_detection_repair_report.py')}。
全量指标：{link('输出/测试报告/2026-09-08/detection-repair-v1/paired-analysis.json')}；
核验记录：{link('输出/测试报告/2026-09-08/detection-repair-v1/validation.json')}；
变化案例：{link('输出/测试报告/2026-09-08/detection-repair-v1/changed-cases.jsonl')}；
待复核案例：{link('输出/测试报告/2026-09-08/detection-repair-v1/candidate-failures.jsonl')}；
逐步消融差异：{link('输出/测试报告/2026-09-08/detection-repair-v1/ablation-deltas.jsonl')}。

三份 candidate-batch-N.jsonl.gz 含全部结果及节点轨迹，不含原始文本。原文按 sourcePath/sourceRow 回到用户本地数据集审阅。完整结果与共同分母已经按代码与数据指纹重算，比例不是模型估算。

附加核验：{link('输出/测试报告/2026-09-08/detection-repair-v1/independent-sql-verification.json','独立 SQLite 对账')}
使用不同实现重算 29,859 条共同样本及 TP/FP，结果完全一致；
{link('输出/测试报告/2026-09-08/detection-repair-v1/verify-paired-sql.py','SQL 对账脚本')} 可直接复现。
{link('输出/测试报告/2026-09-08/detection-repair-v1/candidate-capabilities.json','候选能力检查')} 的运行兼容结果为 true、质量合格为 null；
{link('输出/测试报告/2026-09-08/detection-repair-v1/resume-guard-verification.json','跨版本续写保护')} 已实际拒绝代码变化后的续写，原结果摘要不变。
"""
    path=DOCS/"28_检测架构增量修复执行与回归报告_2026-09-08.md";path.write_text(report,encoding="utf-8")
    save(OUT/"release-readiness.json",{"G0":"PASS_DETERMINISTIC_REGRESSIONS","G1":data["qualityGate"],"G2":"PARTIAL",
       "productionActivationPermitted":False,"independentHoldout":False,"reasonAlignmentReviewed":False,"realMediaSemanticQualityVerified":False,
       "fullProductionProxyE2EVerified":False,"productionChanged":False,"candidatePolicyPublished":False,"allTasksComplete":False,
       "report":str(path.relative_to(ROOT))})
    print(str(path))
if __name__=="__main__":main()
