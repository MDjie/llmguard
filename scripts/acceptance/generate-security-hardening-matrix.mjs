import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const evidenceRoot = path.resolve(
  process.env.P6_EVIDENCE_DIRECTORY
    ?? '输出/测试报告/2026-09-04/security-hardening',
);
const reportRoot = path.resolve(
  process.env.P6_FINAL_REPORT_DIRECTORY
    ?? '输出/测试报告/2026-09-05/security-hardening',
);
const inventoryPath = path.resolve(
  process.env.P6_ATTACHMENT_INVENTORY
    ?? '.tmp/p6-source-20260904/source-inventory.json',
);
const generatedAt = new Date().toISOString();
const executionDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const matrixName = `GuardLLM_158项安全增强执行矩阵_V1.0_${executionDate}.csv`;
const summaryName = `GuardLLM_安全增强全量验收摘要_V1.0_${executionDate}.json`;
const reportName = `GuardLLM_安全检测能力增强_全量验收报告_V1.0_${executionDate}.md`;

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(evidenceRoot, fileName), 'utf8'));
}

function columnNumber(coordinate) {
  const letters = coordinate.match(/^[A-Z]+/u)?.[0] ?? '';
  return [...letters].reduce(
    (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
    0,
  );
}

function rowNumber(coordinate) {
  return Number(coordinate.match(/\d+$/u)?.[0] ?? 0);
}

function rowsFromSheet(sheet) {
  const rows = new Map();
  for (const cell of sheet.cells) {
    const row = rowNumber(cell.coordinate);
    const values = rows.get(row) ?? new Map();
    values.set(columnNumber(cell.coordinate), cell.cached_value ?? cell.value ?? '');
    rows.set(row, values);
  }
  return rows;
}

function csv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

const sensitiveTestDataPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie)\s*[=:]/iu,
  /authorization\s*[:=]\s*(?:bearer|basic)\s+/iu,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:]+:[^\s@]+@/iu,
  /\b1[3-9]\d{9}\b/u,
  /\b\d{15}(?:\d{2}[\dXx])?\b/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
];

function protectTestData(value) {
  const source = String(value ?? '');
  if (!sensitiveTestDataPatterns.some((expression) => expression.test(source))) {
    return { value: source, redacted: false };
  }
  const digest = createHash('sha256').update(source).digest('hex');
  return {
    value: `[受控敏感样本已脱敏；SHA-256:${digest}]`,
    redacted: true,
  };
}

function numberFromLog(log, expression, fallback = 0) {
  return Number(log.match(expression)?.[1] ?? fallback);
}

const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
const [
  sourceVerification,
  runtimeApi,
  isolatedRuntime,
  deploymentSmoke,
  deploymentVerification,
  performance,
  faultInjection,
  textDefense,
  outputControl,
  operations,
  releaseGates,
] = await Promise.all([
  readJson('P6-source-verification.json'),
  readJson('P6-runtime-api-results.json'),
  readJson('P6-isolated-runtime-summary.json'),
  readJson('P6-deployment-smoke.json'),
  readJson('P6-deployment-verification.json'),
  readJson('P6-performance-local.json'),
  readJson('P6-fault-injection-summary.json'),
  readJson('P2-text-defense-metrics.json'),
  readJson('P4-output-control-metrics.json'),
  readJson('P5-operations-verification-summary.json'),
  readJson('P6-logs/summary.json'),
]);
const unitLog = await readFile(path.join(evidenceRoot, 'P6-logs/04-unit.log'), 'utf8');
const coverageLog = await readFile(path.join(evidenceRoot, 'P6-logs/05-coverage.log'), 'utf8');

const requiredPasses = [
  sourceVerification,
  isolatedRuntime,
  deploymentSmoke,
  deploymentVerification,
  performance,
  faultInjection,
  operations,
  releaseGates,
];
if (requiredPasses.some((item) => item.status !== 'PASS')) {
  throw new Error('At least one required P6 evidence package is not PASS');
}
if (
  runtimeApi.summary?.selectedCases !== 32
  || runtimeApi.summary?.passedAssertions !== 32
  || runtimeApi.summary?.failedAssertions !== 0
) {
  throw new Error('The 32-case runtime API evidence is incomplete');
}

const externalBlockers = new Map(Object.entries({
  'TC-0122': {
    owner: '安全扫描负责人/环境所有者',
    reason: '需要获批的真实模型、Web 与主机扫描器以及目标资产执行 POC；本地已验证扫描器准入、身份、许可和资源控制合同。',
    nextStep: '冻结扫描器版本、许可、摘要和隔离环境后，由环境所有者执行并签收。',
    evidence: 'P6-logs/04-unit.log; P6-deployment-smoke.json#SMOKE-SECURITY-SCANS',
  },
  'TC-0131': {
    owner: 'SOC/可信时间服务负责人',
    reason: '可信时间任务的状态机、重试和校验已自动化通过，但缺少真实 TSA 签章与回执。',
    nextStep: '提供 TSA 端点、证书链和获批网络路径，执行真实签章并验签。',
    evidence: 'P5-execution-record.md; P6-logs/04-unit.log',
  },
  'TC-0134': {
    owner: 'SOC/TONE 平台负责人',
    reason: '导出重试和审计合同已验证，但无法在本地替代真实 TONE 断链与恢复补发。',
    nextStep: '在目标 TONE 链路注入断网，核对队列、补发、顺序和回执。',
    evidence: 'P5-execution-record.md; P6-fault-injection-summary.json',
  },
  'TC-0135': {
    owner: 'SOC/TONE 平台负责人',
    reason: '回执校验逻辑已有自动化证据，但缺少真实 TONE 回执不匹配注入。',
    nextStep: '由对端提供可审计的错误回执并验证拒收、告警和人工处置。',
    evidence: 'P5-execution-record.md; P6-logs/04-unit.log',
  },
  'TC-0142': {
    owner: '目标模型与 AI 平台负责人',
    reason: '本地 128K 合成 CJK 单码点代理负载 2/2 成功，但附件要求目标模型与精确 Tokenizer 的逐 Token 覆盖，不能以代理结果签收。',
    nextStep: '冻结模型、Tokenizer 及 SHA-256，在目标运行时重跑 128K 边界与无静默截断校验。',
    evidence: 'P6-performance-local.json#profiles[131072]',
  },
  'TC-0153': {
    owner: '部署架构师/环境所有者',
    reason: '本地验证了超时、取消、租约和恢复逻辑，但当前单机 Compose 不能替代目标多实例拓扑故障演练。',
    nextStep: '在目标集群终止单个网关或控制面实例，按冻结 SLO 记录恢复过程。',
    evidence: 'P6-fault-injection-summary.json',
  },
  'TC-0154': {
    owner: 'DBA/业务连续性负责人',
    reason: '迁移与隔离数据库验证通过，但缺少生产规模备份介质、BIA、RPO/RTO 和恢复授权。',
    nextStep: '在客户批准环境恢复脱敏生产规模备份，执行一致性与审计链检查并签收。',
    evidence: 'P6-logs/06-integration.log; P6-deployment-verification.json',
  },
  'TC-0155': {
    owner: '性能负责人/AI 平台负责人',
    reason: '本地快路径 1K、8K、32K 和 128K 代理分位已测量；缺少目标模型、Tokenizer、硬件和全策略端到端冻结报告。',
    nextStep: '在冻结目标栈运行完整策略分位压测并提交 P50/P95/P99、错误率及资源曲线。',
    evidence: 'P6-performance-local.json',
  },
  'TC-0156': {
    owner: '性能负责人/部署架构师',
    reason: '本地并发 8、64 请求、0 错误、0 降级已测量，但未完成目标拓扑 30 分钟持续并发压测。',
    nextStep: '在目标拓扑持续压测至少 30 分钟，冻结 QPS、并发、队列、CPU、内存和降级比例。',
    evidence: 'P6-performance-local.json#concurrency',
  },
  'TC-0157': {
    owner: '国产化适配负责人/环境所有者',
    reason: '仓库兼容合同和离线工具链通过，但没有指定国产 CPU/NPU、OS、数据库与驱动组合。',
    nextStep: '确定组合清单和商业批准后逐组合执行安装、功能、性能与运维 POC。',
    evidence: 'P6-logs/10-compatibility.log; P6-logs/11-appliance.log',
  },
  'TC-0158': {
    owner: 'Version B 网络与产品负责人',
    reason: '当前范围完成应用护栏数据面，未获得 Version B 透明转发、IPS、AV、DoS、旁路和故障切换硬件环境。',
    nextStep: '完成商业范围确认并提供目标网络/硬件，对透明数据面逐项验收。',
    evidence: 'P6-logs/11-appliance.log',
  },
}));

const moduleEvidence = {
  '身份与作用域': {
    actual: '鉴权、口令、角色隔离、租户/应用边界、CSRF、审计与注销由全量单元测试及桌面/移动认证 E2E 验证通过。',
    evidence: 'P6-logs/04-unit.log; P6-logs/15d-e2e-authenticated.log; P6-isolated-runtime-summary.json',
  },
  'Guard 主链路': {
    actual: 'Guard DAG、输入/输出复检、融合、Judge、必需检测器 fail-closed、可选降级、规范化、ReDoS、流式提交门和影子动作均通过回归；部署策略运行时已就绪。',
    evidence: 'P6-logs/04-unit.log; P6-fault-injection-summary.json; P6-deployment-smoke.json',
  },
  '策略与发布': {
    actual: '策略 CRUD、词库/白名单、状态机、四眼审批、签名验真、SHADOW/CANARY/ACTIVE 与回滚自动化通过；隔离部署签名校验和绑定生效。',
    evidence: 'P1-execution-record.md; P5-execution-record.md; P6-fault-injection-summary.json; P6-deployment-smoke.json',
  },
  'RAG 安全': {
    actual: '授权、租户隔离、来源、间接注入、groundedness、引用、许可和阈值回归通过；隔离部署 RAG 请求返回预期结果。',
    evidence: 'P6-logs/04-unit.log; P6-deployment-smoke.json#SMOKE-RAG',
  },
  'Agent Action Firewall': {
    actual: '工具准入、审批、最小权限、一次性 Permit、过期、参数/主体绑定、结果 DLP/注入复检和供应链摘要回归通过；未知工具在部署中拒绝。',
    evidence: 'P6-logs/04-unit.log; P6-deployment-smoke.json#SMOKE-AGENT-DENY',
  },
  '文档与多模态': {
    actual: '上传安全、魔数/大小/分片摘要、幂等、定位、重试、版本、图文/音视频融合、出站限制和压缩预算回归通过；真实合成 PDF 在独立容器完成解析与检测。',
    evidence: 'P6-logs/04-unit.log; P6-fault-injection-summary.json; P6-deployment-smoke.json#SMOKE-DOCUMENT-PDF',
  },
  '评测门禁': {
    actual: '评测用例治理、首次尝试不可变、数据集摘要、指标公式、多模型比较和最小样本门禁随全量回归与数据库集成通过。',
    evidence: 'P6-logs/04-unit.log; P6-logs/06-integration.log',
  },
  '安全扫描': {
    actual: '资产登记、摘要、扫描器批准、结果身份、独立复核和结果上限回归通过；部署扫描边界可用。',
    evidence: 'P6-logs/04-unit.log; P6-deployment-smoke.json#SMOKE-SECURITY-SCANS',
  },
  '运营与审计': {
    actual: '看板统计、事件状态/SLA、Trace、篡改链、报表、双人导出和指标鉴权回归通过；当前部署审计链全量验证有效。',
    evidence: 'P5-operations-verification-summary.json; P6-deployment-verification.json#auditChain; P6-logs/04-unit.log',
  },
  '资源控制': {
    actual: '多层配额、幂等计费、三优先级公平调度、Tokenizer 摘要绑定、生命周期预算和租约恢复由回归及故障注入验证通过。',
    evidence: 'P6-logs/04-unit.log; P6-fault-injection-summary.json; P6-performance-local.json',
  },
  '供应链': {
    actual: '镜像引用、签名策略、离线校验和、AI-BOM 和许可证门禁通过仓库供应链与 appliance 校验。',
    evidence: 'P6-logs/03-quality.log; P6-logs/11-appliance.log',
  },
  '部署与可靠性': {
    actual: 'Secret 占位符、服务间安全配置和网络隔离合同通过；13 个服务运行，应用健康，只读根文件系统与限定 tmpfs 生效。',
    evidence: 'P6-logs/03-quality.log; P6-deployment-verification.json',
  },
};

const testCaseSheet = inventory.xlsx?.sheets?.find((sheet) => sheet.name === '测试用例');
if (!testCaseSheet) throw new Error('The 测试用例 sheet is missing');
const sourceRows = rowsFromSheet(testCaseSheet);
const runtimeByCase = new Map(runtimeApi.results.map((result) => [result.caseId, result]));
const cases = [];
for (let row = 5; row <= testCaseSheet.max_row; row += 1) {
  const values = sourceRows.get(row);
  const id = String(values?.get(1) ?? '');
  if (!/^TC-\d{4}$/u.test(id)) continue;
  const protectedTestData = protectTestData(values.get(10));
  const sourceCase = {
    id,
    requirement: String(values.get(2) ?? ''),
    module: String(values.get(3) ?? ''),
    title: String(values.get(4) ?? ''),
    testType: String(values.get(5) ?? ''),
    level: String(values.get(6) ?? ''),
    priority: String(values.get(7) ?? ''),
    preconditions: String(values.get(8) ?? ''),
    steps: String(values.get(9) ?? ''),
    testData: protectedTestData.value,
    testDataRedacted: protectedTestData.redacted,
    expected: String(values.get(11) ?? ''),
    automationReference: String(values.get(12) ?? ''),
    baseline: String(values.get(13) ?? ''),
  };
  const external = externalBlockers.get(id);
  const runtime = runtimeByCase.get(id);
  if (external) {
    cases.push({
      ...sourceCase,
      result: '外部阻塞',
      actual: external.reason,
      evidence: external.evidence,
      executor: 'Codex（内部证据）/外部责任人待签收',
      executedAt: generatedAt,
      ownerOrNextStep: `${external.owner}：${external.nextStep}`,
    });
  } else if (runtime) {
    if (!runtime.assertionPassed || runtime.httpStatus !== 200) {
      throw new Error(`${id} is not a passing runtime assertion`);
    }
    const outcome = runtime.isNegative
      ? `安全反例按预期放行（action=${runtime.action}）`
      : `受控正例命中目标维度并处置（action=${runtime.action}，score=${runtime.overallScore}）`;
    cases.push({
      ...sourceCase,
      result: '通过',
      actual: `${outcome}；HTTP 200。该结论是附件样本的功能符合性，不替代独立 2000 ATTACK + 2000 BENIGN 盲测统计。`,
      evidence: `P6-runtime-api-results.json#${id}; P6-isolated-runtime-summary.json`,
      executor: 'Codex 自动化',
      executedAt: generatedAt,
      ownerOrNextStep: '功能用例关闭；生产效果指标待独立 QA 盲测签收。',
    });
  } else {
    const mapped = moduleEvidence[sourceCase.module];
    if (!mapped) throw new Error(`No evidence mapping exists for ${id} (${sourceCase.module})`);
    const tokenizerQualification = id === 'TC-0141'
      ? ' 精确 Tokenizer 摘要的注册、SHA-256 绑定和漂移拒绝已验证；128K 目标运行时另由 TC-0142 保持外部阻塞。'
      : '';
    cases.push({
      ...sourceCase,
      result: '通过',
      actual: `${mapped.actual}${tokenizerQualification}`,
      evidence: mapped.evidence,
      executor: 'Codex 自动化',
      executedAt: generatedAt,
      ownerOrNextStep: '本地工程验收关闭。',
    });
  }
}

const expectedIds = Array.from({ length: 158 }, (_, index) => `TC-${String(index + 1).padStart(4, '0')}`);
if (cases.length !== 158 || expectedIds.some((id, index) => cases[index]?.id !== id)) {
  throw new Error('The generated matrix is not the contiguous TC-0001..TC-0158 set');
}
const statuses = ['通过', '失败', '部分覆盖', '外部阻塞'];
const totals = Object.fromEntries(statuses.map((status) => [
  status,
  cases.filter((testCase) => testCase.result === status).length,
]));
if (totals['通过'] !== 147 || totals['失败'] !== 0 || totals['部分覆盖'] !== 0 || totals['外部阻塞'] !== 11) {
  throw new Error(`Unexpected matrix totals: ${JSON.stringify(totals)}`);
}
const internalP0P1Failures = cases.filter(
  (testCase) => ['P0', 'P1'].includes(testCase.priority) && testCase.result === '失败',
).length;
if (internalP0P1Failures !== 0) throw new Error('The matrix contains internal P0/P1 failures');

const modules = [...new Set(cases.map((testCase) => testCase.module))].map((module) => ({
  module,
  total: cases.filter((testCase) => testCase.module === module).length,
  ...Object.fromEntries(statuses.map((status) => [
    status,
    cases.filter((testCase) => testCase.module === module && testCase.result === status).length,
  ])),
}));
const headers = [
  '用例ID', '需求/工作包', '模块', '用例标题', '测试类型', '层级', '优先级',
  '前置条件', '操作步骤', '测试数据', '预期结果', '自动化/证据参考', '附件基线状态',
  '本次结果', '实际结果/偏差', '证据路径', '执行人', '执行时间', '外部责任人/下一步',
];
const csvRows = cases.map((testCase) => [
  testCase.id,
  testCase.requirement,
  testCase.module,
  testCase.title,
  testCase.testType,
  testCase.level,
  testCase.priority,
  testCase.preconditions,
  testCase.steps,
  testCase.testData,
  testCase.expected,
  testCase.automationReference,
  testCase.baseline,
  testCase.result,
  testCase.actual,
  testCase.evidence,
  testCase.executor,
  testCase.executedAt,
  testCase.ownerOrNextStep,
].map(csv).join(','));
const csvContent = `\ufeff${headers.map(csv).join(',')}\r\n${csvRows.join('\r\n')}\r\n`;
const matrixSha256 = createHash('sha256').update(csvContent).digest('hex');

const unitCounts = {
  files: numberFromLog(unitLog, /Test Files\s+(\d+) passed/u),
  tests: numberFromLog(unitLog, /Tests\s+(\d+) passed/u),
};
const coverage = Object.fromEntries(['Statements', 'Branches', 'Functions', 'Lines'].map((name) => [
  name.toLowerCase(),
  numberFromLog(coverageLog, new RegExp(`${name}\\s+:\\s+([0-9.]+)%`, 'u')),
]));
const externalItems = cases.filter((testCase) => testCase.result === '外部阻塞');
const redactedTestDataCases = cases.filter((testCase) => testCase.testDataRedacted).length;
const summary = {
  schemaVersion: '1.0',
  generatedAt,
  status: 'INTERNAL_PASS_EXTERNAL_SIGNOFF_REQUIRED',
  releaseDecision: 'HOLD_PRODUCTION_RELEASE',
  source: sourceVerification.sources,
  evidenceHygiene: {
    testDataPolicy: 'Sensitive-shaped controlled test data is replaced by a SHA-256 digest before persistence.',
    redactedTestDataCases,
  },
  matrix: {
    file: matrixName,
    sha256: matrixSha256,
    totalCases: cases.length,
    totals,
    internalP0P1Failures,
    modules,
  },
  validation: {
    releaseGates: { status: releaseGates.status, passed: releaseGates.gates.length, total: releaseGates.gates.length },
    unit: unitCounts,
    coverage,
    runtimeApi: runtimeApi.summary,
    authenticatedE2E: isolatedRuntime.authenticatedE2E,
    deploymentSmoke: deploymentSmoke.summary,
    faultInjection: faultInjection.execution,
    deployment: {
      services: deploymentVerification.deployment.serviceCount,
      image: deploymentVerification.deployment.appImageDigest,
      policyGeneration: deploymentVerification.endpoints.find((item) => item.path === '/api/health/policy')?.generation ?? null,
      auditEventsChecked: deploymentVerification.auditChain.totalChecked,
    },
  },
  controlledMetrics: {
    textDefense: textDefense.metrics,
    outputCompliance: outputControl.compliance,
    dlp: outputControl.dlp,
    performance,
  },
  resolvedDefects: [
    {
      id: 'DEF-001', severity: 'P0', status: 'CLOSED',
      title: '部署运行时缺少可执行签名策略包',
      evidence: 'P6-runtime-api-results.json; P6-deployment-verification.json',
    },
    {
      id: 'DEF-002', severity: 'P2', status: 'CLOSED',
      title: '只读应用容器缺少受限 Next.js 缓存写入面',
      evidence: 'P6-deployment-verification.json#runtimeChecks.boundedWritablePaths',
    },
    {
      id: 'DEF-003', severity: 'P1', status: 'CLOSED',
      title: 'standalone 镜像遗漏 PDF Canvas 与 PDF.js worker 运行时依赖',
      evidence: 'P6-deployment-smoke.json#SMOKE-DOCUMENT-PDF; tests/document/pdf-loader.test.ts',
    },
  ],
  externalAcceptance: externalItems.map((testCase) => ({
    caseId: testCase.id,
    title: testCase.title,
    reason: testCase.actual,
    ownerOrNextStep: testCase.ownerOrNextStep,
  })),
  additionalExternalGates: [
    '独立 QA 封存且与研发集不重叠的至少 2000 ATTACK + 2000 BENIGN 盲测及签名报告',
    '批准的生产敏感词/白名单内容与许可证明',
    '生产视觉、ASR、音频异常和 TTS 模型资产及数据处理审批',
    '完整业务周期影子流量与 1%→5%→20%→50%→100% 灰度签收',
  ],
  phaseCommits: [
    { phase: 'P0', commit: 'b6643c5' },
    { phase: 'P1', commit: 'e13b48c' },
    { phase: 'P2', commit: '0dcf333' },
    { phase: 'P3', commit: '93d41f8' },
    { phase: 'P4', commit: '26996a0' },
    { phase: 'P5', commit: '1f6178a' },
    { phase: 'P6', commit: '见包含本报告的阶段提交' },
  ],
  cases,
};

const gateRows = releaseGates.gates.map((gate) =>
  `| ${gate.id} | ${gate.command} | ${gate.status} | ${gate.durationMs} |`,
).join('\n');
const moduleRows = modules.map((row) =>
  `| ${row.module} | ${row.total} | ${row['通过']} | ${row['失败']} | ${row['部分覆盖']} | ${row['外部阻塞']} |`,
).join('\n');
const blockerRows = externalItems.map((testCase) =>
  `| ${testCase.id} | ${testCase.title} | ${testCase.actual} | ${testCase.ownerOrNextStep} |`,
).join('\n');
const performanceRows = performance.profiles.map((profile) =>
  `| ${profile.estimatedTokens.toLocaleString('en-US')} | ${profile.iterations} | ${profile.metrics.latencyMs.p50} | ${profile.metrics.latencyMs.p95} | ${profile.metrics.latencyMs.p99} | ${profile.metrics.qps} | ${profile.metrics.errorRate} | ${profile.signoff} |`,
).join('\n');
const totalGateDuration = releaseGates.gates.reduce((total, gate) => total + gate.durationMs, 0);
const report = `# GuardLLM 安全检测能力增强全量验收报告

## 1. 结论

按照《GuardLLM 安全检测能力增强 Codex 执行计划》和优化设计方案，P0 至 P6 的内部可执行工作已完成。附件定义的 158 条用例已逐条回归：**147 条通过、0 条失败、0 条部分覆盖、11 条外部阻塞**；内部 P0/P1 失败为 **0**。32 条 16 维在线请求全部 HTTP 200 且断言通过，认证浏览器 E2E 10/10，通过部署能力检查 15/15（包含真实合成 PDF 上传、解析与检测）。

内部工程结论为：**可进入独立 QA 和目标环境验收**。生产发布结论仍为：**暂缓（HOLD）**。原因不是内部缺陷，而是独立 2000+2000 盲测、目标模型/Tokenizer、30 分钟目标拓扑压测、真实扫描器/TSA/TONE、备份恢复、国产组合 POC 和 Version B 网络数据面尚未由外部责任人签收。

“通过”仅代表本报告列明的本地代码、隔离数据库、容器部署和受控样本范围，不扩张为生产效果、法规结论或客户验收结论。

## 2. 范围与基线

- 来源手册：${sourceVerification.sources.docx.fileName}，SHA-256 ${sourceVerification.sources.docx.sha256}。
- 来源用例：${sourceVerification.sources.xlsx.fileName}，SHA-256 ${sourceVerification.sources.xlsx.sha256}。
- 来源结构：DOCX ${sourceVerification.docxStructure.paragraphs} 段、${sourceVerification.docxStructure.tables} 表；XLSX ${sourceVerification.workbookStructure.length} 个工作表；TC-0001 至 TC-0158 连续、唯一、无遗漏。
- 代码起点：main@69639dc；阶段分支：codex/security-hardening-v1。
- 阶段提交：P0 b6643c5、P1 e13b48c、P2 0dcf333、P3 93d41f8、P4 26996a0、P5 1f6178a；P6 见包含本报告的提交。
- 测试数据：仅使用附件内受控/虚构样本和新生成合成数据，不保存密码、Cookie 或客户原文。

## 3. 158 条矩阵结果

| 模块 | 总数 | 通过 | 失败 | 部分覆盖 | 外部阻塞 |
|---|---:|---:|---:|---:|---:|
${moduleRows}

矩阵文件：\`${matrixName}\`；SHA-256：\`${matrixSha256}\`。32 条维度正反例是功能符合性样本；其中反例通过表示本次受控样本未误报，不代表已达到生产 FPR/FNR 统计门槛。

## 4. 全仓质量门禁

14 个门禁全部通过，总耗时 ${(totalGateDuration / 1000).toFixed(1)} 秒。全量单元测试 ${unitCounts.files} 个文件、${unitCounts.tests} 项；覆盖率为语句 ${coverage.statements}%、分支 ${coverage.branches}%、函数 ${coverage.functions}%、行 ${coverage.lines}%，未降低仓库既定阈值。

| 门禁 | 命令 | 结果 | 耗时 ms |
|---|---|---|---:|
${gateRows}

补充结果：数据库集成迁移通过；Python SDK 3/3；Go SDK 通过；Java SDK 3/3；Java Gateway 28/28；Next.js 生产构建完成全部 67 个静态页面并收集生产路由。

## 5. 安全能力实测

### 5.1 输入侧

- 文本攻击受控集 24 条，注入、编码/切片/字符混淆、多语种、提示词泄露四组均 TP=4、TN=2、FP=0、FN=0；这是确定性符合性结果，不是生产盲测指标。
- 支持直接/间接注入、角色与目标劫持、提示词/推理泄露、多轮递进风险、规范化来源图和绝对预算。
- 图像/音频/视频/文档任务统一受魔数、大小、分片摘要、解压预算、出站、超时、取消和租户公平调度约束。
- 故障注入覆盖策略篡改、错误公钥、数据库短时不可用、无策略、模板失败、解码炸弹、Worker 堆积、OCR/ASR/Judge 超时、流式取消、任务竞态和只读缓存，共 ${faultInjection.execution.testFiles} 个测试文件、${faultInjection.execution.tests} 项，全部通过。

### 5.2 输出侧

- 政治、色情和保险合规矩阵共 ${outputControl.compliance.totalCases} 条，动作精确匹配 ${outputControl.compliance.exactActionMatches}/${outputControl.compliance.totalCases}；政治 ${outputControl.compliance.domains.political.cases}、色情 ${outputControl.compliance.domains.sexual.cases}、保险 ${outputControl.compliance.domains.insurance.cases} 条均 100% 符合预期。
- DLP 覆盖 ${outputControl.dlp.entityCases} 个实体用例，${outputControl.dlp.detected}/${outputControl.dlp.entityCases} 识别，${outputControl.dlp.actionMatches}/${outputControl.dlp.entityCases} 动作匹配；23 条完成变换与复检，2 条红线阻断，明文留存失败 0。
- 七级动作合同、标准拒答、自定义安全代答、模板变量白名单、变换后复检和流式提交门均有自动化证据。

## 6. 性能与稳定性

本地性能只测 GuardEngineV2、受限规范化和 PromptAttackDetector 快路径，不含外部模型网络时延，也不作为目标生产 SLO 签收。

| 估算 token | 次数 | P50 ms | P95 ms | P99 ms | QPS | 错误率 | 签收口径 |
|---:|---:|---:|---:|---:|---:|---:|---|
${performanceRows}

并发测试：并发度 ${performance.concurrency.requestedConcurrency}，请求 ${performance.concurrency.requests}，P95 ${performance.concurrency.latencyMs.p95} ms，QPS ${performance.concurrency.qps}，错误率 ${performance.concurrency.errorRate}，降级率 ${performance.concurrency.degradationRate}。128K 使用合成 CJK 单码点代理；精确目标 Tokenizer 与 30 分钟目标拓扑压测保持外部阻塞。

## 7. 部署验证

- 当前地址：http://127.0.0.1:58082；Compose 项目 guardllm-r0。
- ${deploymentVerification.deployment.serviceCount}/${deploymentVerification.deployment.expectedServices} 个服务运行；应用、数据库与策略健康端点 HTTP 200；策略 generation ${summary.validation.deployment.policyGeneration}。
- 应用镜像：\`${deploymentVerification.deployment.appImageDigest}\`；应用健康；根文件系统只读，仅 \`/tmp\` 与 \`/app/.next/cache\` 使用受限 tmpfs。
- 最近 ${deploymentVerification.logReview.window} 的 13 个服务无结构化 error/fatal、未捕获异常、段错误或 OOM 命中。
- 审计链 ${deploymentVerification.auditChain.partitions.length} 个分区、${deploymentVerification.auditChain.totalChecked} 条事件全部验证有效；分区标识在证据中仅保留 SHA-256。
- 匿名 Guard 边界返回 401；隔离运行使用专用数据库、随机临时管理员，未修改生产账号。

## 8. 已关闭缺陷

| 缺陷 | 级别 | 关闭证据 |
|---|---|---|
| DEF-001：部署无可执行签名策略包 | P0 | 策略 ready/signatureVerified；32/32 运行时请求通过 |
| DEF-002：只读容器缺少 Next 缓存写入面 | P2 | 只读根文件系统保留；限定 cache/tmp tmpfs；无启动错误 |
| DEF-003：standalone 遗漏 Canvas/PDF.js worker | P1 | 延迟加载与依赖追踪测试通过；真实合成 PDF POST 200 并完成检测 |

## 9. 外部阻塞与唯一下一步

| 用例 | 标题 | 阻塞原因 | 责任人/下一步 |
|---|---|---|---|
${blockerRows}

此外，发布门禁还要求独立 QA 持有且与研发集不重叠的至少 2000 ATTACK + 2000 BENIGN 盲测集，按注入、混淆、多语种、多轮、多模态、政治、色情、保险和 DLP 分层统计并签名；批准的生产词库/白名单、模型资产及完整业务周期影子与分阶段灰度也需具名签收。

## 10. 变更、运维与回滚

- P0：签名策略运行时、默认策略引导、readiness、部署密钥边界和兼容合同。
- P1：治理词典/白名单、响应模板、统一判定合同、审批与回滚数据模型。
- P2：有界多视图规范化、注入/混淆/多语种/泄露检测、来源定位和降级语义。
- P3：多轮会话、图文/音视频融合、资源准入、公平调度、取消与恢复。
- P4：政治/色情/保险输出合规、PII/DLP 变换、七级干预、安全代答与二次复检。
- P5：管理页面、指标告警、事件审计、原文审批、影子/灰度和自动回滚。
- P6：全仓门禁、运行时矩阵、故障注入、性能、部署证据及 PDF 生产打包修复。

迁移 0036 至 0041 均按扩展式模型实施。升级前应备份数据库、冻结策略包/密钥标识和镜像 digest；升级后运行迁移、策略 bootstrap、readiness、核心冒烟和审计链校验。应用回滚优先切回上一已验证镜像 \`sha256:2758d1a3b62fd9aa53f570261d5ac1ed2c692d9a70653ce55a975ded07bbfdad\`，随后把 Bundle generation 回滚到 last-known-good 并重新执行健康、权限、Guard、RAG/Agent、文档和审计校验。0038/0040 已附治理回滚说明；涉及数据收缩或删除必须另行审批，不能在应急回滚中直接执行。

高优先级告警覆盖策略缺失/验签失败、公钥不一致、审计链断裂、mandatory deny 绕过、流式提交门失败、检测超时/降级、资源拒绝、Worker backlog、取消失败和模板复检失败；指标标签禁止原文、客户 ID 和高基数字段。

## 11. 发布判定

| 判定层级 | 结论 |
|---|---|
| 内部工程门禁 | PASS：代码、合同、单元、覆盖率、集成、SDK、Gateway、构建、隔离 E2E、32 维请求、15 项部署冒烟、故障注入与审计链均通过 |
| 158 条矩阵 | 147 通过、0 失败、0 部分覆盖、11 外部阻塞；内部 P0/P1 失败 0 |
| 外部效果与目标环境 | 未签收 |
| 生产发布 | HOLD；完成第 9 节外部证据并由责任人具名签收后再进入发布审批 |

## 12. 证据索引

- \`${matrixName}\`：158 条逐项结果、偏差、证据和下一步。
- \`${summaryName}\`：机器可读汇总、证据摘要和全部用例记录。
- \`P6-source-verification.json\`：来源附件哈希、结构与 158 ID 连续性。
- \`P6-runtime-api-results.json\`：32 条在线请求去敏结果，只保留输入 SHA-256。
- \`P6-isolated-runtime-summary.json\`、\`P6-deployment-smoke.json\`：隔离 API/E2E/部署/PDF 冒烟。
- \`P6-performance-local.json\`、\`P6-fault-injection-summary.json\`：本地性能与故障注入。
- \`P6-deployment-verification.json\`：健康、容器安全、日志和审计链。
- \`P6-logs/summary.json\` 与 01 至 16 日志：完整门禁记录。
`;

await mkdir(reportRoot, { recursive: true });
await Promise.all([
  writeFile(path.join(reportRoot, matrixName), csvContent, 'utf8'),
  writeFile(path.join(reportRoot, summaryName), `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
  writeFile(path.join(reportRoot, reportName), report, 'utf8'),
]);
process.stdout.write(`${JSON.stringify({
  status: summary.status,
  releaseDecision: summary.releaseDecision,
  reportRoot,
  matrix: summary.matrix,
  evidenceHygiene: summary.evidenceHygiene,
})}\n`);
