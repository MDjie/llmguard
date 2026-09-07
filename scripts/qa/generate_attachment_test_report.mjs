import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const reportDir = path.resolve('输出/测试报告/2026-09-04');
const inventoryPath = path.join(reportDir, 'source-inventory.json');
const runtimePath = path.join(reportDir, 'runtime-api-results.json');
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));

function columnNumber(coordinate) {
  const letters = coordinate.match(/^[A-Z]+/)?.[0] ?? '';
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function rowNumber(coordinate) {
  return Number(coordinate.match(/\d+$/)?.[0] ?? 0);
}

function rowsFromSheet(sheet) {
  const rows = new Map();
  for (const cell of sheet.cells) {
    const row = rowNumber(cell.coordinate);
    const column = columnNumber(cell.coordinate);
    const values = rows.get(row) ?? new Map();
    values.set(column, cell.cached_value ?? cell.value ?? '');
    rows.set(row, values);
  }
  return rows;
}

const sheet = inventory.xlsx.sheets.find((item) => item.name === '测试用例');
if (!sheet) throw new Error('测试用例 sheet not found');
const sourceRows = rowsFromSheet(sheet);
const runtimeByCase = new Map(runtime.results.map((result) => [result.caseId, result]));

const cases = [];
for (let row = 5; row <= sheet.max_row; row += 1) {
  const values = sourceRows.get(row);
  if (!values || !String(values.get(1) ?? '').startsWith('TC-')) continue;
  const testCase = {
    id: String(values.get(1) ?? ''),
    requirement: String(values.get(2) ?? ''),
    module: String(values.get(3) ?? ''),
    title: String(values.get(4) ?? ''),
    testType: String(values.get(5) ?? ''),
    level: String(values.get(6) ?? ''),
    priority: String(values.get(7) ?? ''),
    expected: String(values.get(11) ?? ''),
    automationReference: String(values.get(12) ?? ''),
    baseline: String(values.get(13) ?? ''),
  };
  const runtimeResult = runtimeByCase.get(testCase.id);
  const external = testCase.baseline.includes('外部阻塞')
    || testCase.baseline.includes('待外部系统联调')
    || testCase.baseline.includes('待盲测')
    || testCase.automationReference === '盲测';
  const targetOrManual = /待目标|待现场|待集成|待业务|目标环境|手工|部分自动化|仓库脚本/.test(
    `${testCase.baseline}|${testCase.automationReference}`,
  );

  let result;
  let actual;
  let evidence;
  if (runtimeResult && !runtimeResult.assertionPassed) {
    result = '失败';
    actual = `部署实例返回 HTTP ${runtimeResult.httpStatus} ${runtimeResult.problemCode}; 未进入 ${runtimeResult.expectedDimension ?? '目标维度'} 判定`;
    evidence = 'runtime-api-results.json; DEF-001';
  } else if (external) {
    result = '外部阻塞';
    actual = `本地仓库/容器不能替代附件要求的盲测、目标平台、第三方系统、硬件或签名审批证据（基线：${testCase.baseline}）`;
    evidence = 'acceptance/evidence/runs/2026-09-04T08-47-43-990Z-0802764b; acceptance generated audit';
  } else if (testCase.id === 'TC-0001' || testCase.id === 'TC-0015') {
    result = '通过';
    actual = '桌面与移动端均完成真实登录、鉴权导航和注销；后端连接正常';
    evidence = 'playwright-report/index.html (10/10 passed)';
  } else if (!targetOrManual && testCase.automationReference.includes('tests/')) {
    result = '通过';
    actual = '引用的仓库自动化随完整 Vitest 回归通过；仅代表本地代码基线验证';
    evidence = `${testCase.automationReference}; pnpm validate (495/495)`;
  } else {
    result = '部分覆盖';
    actual = `仓库自动化与/或数据库基线已通过，但附件要求的现场操作、目标数据库、真实集成或完整人工步骤未在本机独立满足（基线：${testCase.baseline}）`;
    evidence = `${testCase.automationReference || '附件步骤'}; pnpm validate; pnpm test:integration`;
  }
  cases.push({ ...testCase, result, actual, evidence });
}

const statuses = ['通过', '失败', '部分覆盖', '外部阻塞'];
const totals = Object.fromEntries(statuses.map((status) => [
  status,
  cases.filter((testCase) => testCase.result === status).length,
]));
const modules = [...new Set(cases.map((testCase) => testCase.module))];
const moduleRows = modules.map((module) => ({
  module,
  total: cases.filter((testCase) => testCase.module === module).length,
  ...Object.fromEntries(statuses.map((status) => [
    status,
    cases.filter((testCase) => testCase.module === module && testCase.result === status).length,
  ])),
}));

function csv(value) {
  const rendered = String(value ?? '').replace(/"/g, '""');
  return `"${rendered}"`;
}

const csvHeaders = [
  '用例ID', '需求/工作包', '模块', '用例标题', '测试类型', '层级', '优先级',
  '预期结果', '自动化/证据参考', '附件基线状态', '本次结果', '实际结果/偏差', '证据',
];
const csvRows = cases.map((testCase) => [
  testCase.id,
  testCase.requirement,
  testCase.module,
  testCase.title,
  testCase.testType,
  testCase.level,
  testCase.priority,
  testCase.expected,
  testCase.automationReference,
  testCase.baseline,
  testCase.result,
  testCase.actual,
  testCase.evidence,
].map(csv).join(','));
await writeFile(
  path.join(reportDir, 'GuardLLM_158条用例执行矩阵_2026-09-04.csv'),
  `\ufeff${csvHeaders.map(csv).join(',')}\r\n${csvRows.join('\r\n')}\r\n`,
  'utf8',
);

const failedCases = cases.filter((testCase) => testCase.result === '失败');
const blockedCases = cases.filter((testCase) => testCase.result === '外部阻塞');
const partialCases = cases.filter((testCase) => testCase.result === '部分覆盖');

const report = `# GuardLLM 附件全量自动化测试报告

## 结论

本次对附件定义的 **158 条正式用例**完成了逐条盘点和可执行自动化；本地代码、数据库、SDK、构建及桌面/移动端登录链路通过，但部署实例的核心 Guard 检测被策略发布配置阻断，**32 条 16 维系统用例全部失败**。另有附件明确要求外部盲测、目标环境、第三方系统、硬件或签名审批的用例，当前不能合规地宣称通过。

因此，本次总体结论为：**不具备发布/客户验收通过条件**。

| 结果 | 数量 | 口径 |
|---|---:|---|
| 通过 | ${totals['通过']} | 本地自动化直接覆盖且未要求额外目标环境证据 |
| 失败 | ${totals['失败']} | 已执行，实际结果不符合附件预期 |
| 部分覆盖 | ${totals['部分覆盖']} | 代码/数据库自动化通过，但现场、目标 DB、真实集成或人工步骤未完整执行 |
| 外部阻塞 | ${totals['外部阻塞']} | 附件自身标注盲测/外部系统/目标环境/硬件等前置条件缺失 |
| 合计 | ${cases.length} | TC-0001 至 TC-0158，无遗漏 |

## 执行范围与结果

| 测试项 | 结果 | 关键证据 |
|---|---|---|
| 附件解析与版式核验 | 通过 | DOCX 286 段、36 表、18 页逐页渲染检查；XLSX 7 个工作表、158 条用例、12 组受控数据全部读取 |
| 完整代码基线 | 通过 | \`pnpm validate\`；117 个测试文件、495/495 通过；TypeScript 与 ESLint 0 错误 |
| 覆盖率 | 通过门槛 | 行 37.09%、语句 36.56%、函数 36.28%、分支 33.19%，均高于仓库阈值；不代表业务验收覆盖充分 |
| 数据库集成 | 通过 | 专用数据库；37 个迁移、12 个必需关系、租户隔离、数据血缘约束、append-only 审计均 PASS |
| 浏览器 E2E | 通过 | 部署实例 127.0.0.1:58082；桌面/移动 Chromium 10/10，通过真实登录、鉴权导航、注销和健康检查 |
| 运行时 16 维检测 | **失败** | 32/32 返回 \`503 POLICY_LOAD_FAILED\`；匿名检测边界正确返回 401 |
| SDK | 通过 | Python 3/3；Go 测试包通过；Java SDK 3/3（无缓存 Maven verify） |
| Java Gateway | 通过 | 28/28，0 失败、0 错误、0 跳过 |
| 生产构建 | 通过 | Next.js 16.3.3 编译、类型检查、60 个静态页面生成及路由收集成功 |
| 生产功能面/质量基线 | 通过 | production surface passed；TypeScript/ESLint 均为 0，未回退 |
| 验收追踪 | 未签收 | 101/101 映射路径有效；accepted=0、pendingAcceptance=101；POC 状态 \`PENDING_EXTERNAL_EVIDENCE\` |
| 兼容性 | 外部阻塞 | 20 个目标：4 IMPLEMENTED、1 CI_VERIFIED、15 PENDING_TARGET_POC |
| 容器运行面 | 部分通过 | App、PostgreSQL、媒体分析器及 10 个 Worker 均运行；Worker 最近日志无错误；App 日志另见 DEF-002 |

## 按模块统计

| 模块 | 总数 | 通过 | 失败 | 部分覆盖 | 外部阻塞 |
|---|---:|---:|---:|---:|---:|
${moduleRows.map((row) => `| ${row.module} | ${row.total} | ${row['通过']} | ${row['失败']} | ${row['部分覆盖']} | ${row['外部阻塞']} |`).join('\n')}

## 缺陷

### DEF-001（P0 / 发布阻断）：Guard 核心检测不可用

- 复现：授权管理员调用 \`POST /api/detect\`，逐条提交附件 32 个 16 维正反例。
- 实际：32/32 均返回 HTTP 503，错误码 \`POLICY_LOAD_FAILED\`，未进入任何维度判定。
- 根因证据：数据库中 3 个策略 Profile 均为 active，但 \`policy_bundles\` 数量为 0；应用容器同时缺少 \`POLICY_SIGNING_PUBLIC_KEY\`、\`POLICY_SIGNING_PRIVATE_KEY\` 和 \`POLICY_SIGNING_KEY_ID\`。\`docker-compose.yml\` 的公共运行环境也未映射这些变量。
- 影响：Guard 主链路、16 维检测、RAG/Agent/评测等依赖签名策略包的运行时场景不能验收。
- 建议：生成并安全注入 Ed25519 密钥；编译、测试、审批并激活至少一个签名策略包；绑定到当前租户/应用后重跑 TC-0016 至 TC-0114 相关运行时场景及 32 个维度样本。

### DEF-002（P2）：只读 App 容器缺少 Next 图片缓存可写挂载

- 实际：App 日志重复出现 \`ENOENT: mkdir '/app/.next/cache'\` 和图片缓存写入失败。
- 影响：当前 E2E 页面仍可用，但图片优化缓存失效并产生 unhandled rejection 噪声，可能影响性能和稳定性。
- 建议：给 \`/app/.next/cache\` 配置受限 tmpfs/可写卷，或按部署策略禁用需要写盘的图片缓存路径。

## 未满足的外部验收条件

- 独立封存盲测集：至少 2000 ATTACK + 2000 BENIGN，要求 Accuracy ≥95%、Recall ≥95%、FPR ≤1%、FNR ≤5%，并提供签名报告。
- 目标模型/Tokenizer 的 128K 长上下文与摘要绑定。
- 目标拓扑 30 分钟性能、吞吐、并发、资源、P50/P95/P99 与错误率报告。
- 客户目标数据库与生产规模备份恢复、SLO/RPO/RTO、单实例故障演练。
- TONE/SIEM/IAM、可信时间、真实扫描器及模型/RAG/Agent 端点联调。
- 指定国产 CPU/NPU/OS/DB 组合 POC，以及 Version B 网络数据面与目标硬件验收。

外部阻塞用例：${blockedCases.map((testCase) => testCase.id).join('、') || '无'}。

部分覆盖用例：${partialCases.map((testCase) => testCase.id).join('、') || '无'}。

失败用例：${failedCases.map((testCase) => testCase.id).join('、') || '无'}。

## 证据索引

- \`GuardLLM_158条用例执行矩阵_2026-09-04.csv\`：全部 158 条逐条结论、偏差和证据。
- \`runtime-api-results.json\`：32 个运行时维度请求的去敏结果（仅保留输入 SHA-256，不保存会话 Cookie/密码）。
- \`source-inventory.json\`、\`manual-content.md\`、\`test-cases-content.md\`：附件结构化读取结果。
- \`manual-render/manual.pdf\` 与 \`manual-render/page-*.png\`：18 页手册渲染复核证据。
- \`coverage/coverage-summary.json\`、\`coverage/index.html\`：代码覆盖率。
- \`playwright-report/index.html\`：桌面/移动端 E2E 报告。
- \`acceptance/evidence/runs/2026-09-04T08-47-43-990Z-0802764b\`：本次验收 POC 证据目录。

## 测试基线与限制

- 实测提交：\`main@69639dc\`；附件基线：\`main@96cb4d5\`。本报告反映当前提交，不回填或改写原附件。
- 测试日期：2026-09-04（Asia/Shanghai）。
- 所有攻击、PII、凭证、RAG、Agent 和文件描述均来自附件内虚构/受控数据；未使用真实客户数据。
- “通过”只表示本报告列明范围内的本地自动化通过；不替代环境所有者和独立 QA 的具名签收。
`;

await writeFile(
  path.join(reportDir, 'GuardLLM_完整自动化测试报告_2026-09-04.md'),
  report,
  'utf8',
);
await writeFile(
  path.join(reportDir, 'test-execution-summary.json'),
  `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    commit: '69639dc',
    totalCases: cases.length,
    totals,
    modules: moduleRows,
    defects: [
      { id: 'DEF-001', severity: 'P0', status: 'OPEN', affectedCases: failedCases.map((item) => item.id) },
      { id: 'DEF-002', severity: 'P2', status: 'OPEN', affectedCases: [] },
    ],
  }, null, 2)}\n`,
  'utf8',
);
console.log(JSON.stringify({ totalCases: cases.length, totals, modules: moduleRows }));
