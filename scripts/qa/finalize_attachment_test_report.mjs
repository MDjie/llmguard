import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const reportDir = path.resolve('输出/测试报告/2026-09-04');
const csvPath = path.join(reportDir, 'GuardLLM_158条用例执行矩阵_2026-09-04.csv');
const reportPath = path.join(reportDir, 'GuardLLM_完整自动化测试报告_2026-09-04.md');
const summaryPath = path.join(reportDir, 'test-execution-summary.json');

function parseCsv(input) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (value || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function quote(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

const csvRows = parseCsv(await readFile(csvPath, 'utf8'));
const headers = csvRows.shift();
const index = Object.fromEntries(headers.map((header, position) => [header, position]));
const deploymentDependentModules = new Set([
  'Guard 主链路',
  '策略与发布',
  'RAG 安全',
  '文档与多模态',
]);

for (const row of csvRows) {
  if (deploymentDependentModules.has(row[index['模块']]) && row[index['本次结果']] === '通过') {
    row[index['本次结果']] = '部分覆盖';
    row[index['实际结果/偏差']] = '引用的仓库自动化已通过，但部署实例没有可执行的签名策略包，无法完成该系统级场景的真实运行时闭环（见 DEF-001）';
    row[index['证据']] = `${row[index['自动化/证据参考']]}; pnpm validate (495/495); DEF-001`;
  }
}

await writeFile(
  csvPath,
  `\uFEFF${[headers, ...csvRows].map((row) => row.map(quote).join(',')).join('\r\n')}\r\n`,
  'utf8',
);

const statuses = ['通过', '失败', '部分覆盖', '外部阻塞'];
const totals = Object.fromEntries(statuses.map((status) => [
  status,
  csvRows.filter((row) => row[index['本次结果']] === status).length,
]));
const moduleNames = [...new Set(csvRows.map((row) => row[index['模块']]))];
const modules = moduleNames.map((module) => ({
  module,
  total: csvRows.filter((row) => row[index['模块']] === module).length,
  ...Object.fromEntries(statuses.map((status) => [
    status,
    csvRows.filter((row) => row[index['模块']] === module && row[index['本次结果']] === status).length,
  ])),
}));

let report = await readFile(reportPath, 'utf8');
report = report.replace(
  '本地代码、数据库、SDK、构建及桌面/移动端登录链路通过，但部署实例的核心 Guard 检测被策略发布配置阻断，**32 条 16 维系统用例全部失败**。另有附件明确要求外部盲测、目标环境、第三方系统、硬件或签名审批的用例，当前不能合规地宣称通过。',
  '本地代码、数据库、SDK、构建及桌面/移动端登录链路通过，但部署实例的核心 Guard 检测被策略发布配置阻断，**32 条 16 维系统用例全部失败**。Guard 主链路、策略发布、RAG 和文档/多模态虽有代码自动化通过证据，但缺少部署运行时闭环，均按“部分覆盖”处理。另有附件明确要求外部盲测、目标环境、第三方系统、硬件或签名审批的用例，当前不能合规地宣称通过。',
);
report = report.replace(/\| 通过 \| \d+ \| 本地自动化直接覆盖且未要求额外目标环境证据 \|/, `| 通过 | ${totals['通过']} | 本地自动化直接覆盖且未要求额外目标环境证据 |`);
report = report.replace(/\| 失败 \| \d+ \| 已执行，实际结果不符合附件预期 \|/, `| 失败 | ${totals['失败']} | 已执行，实际结果不符合附件预期 |`);
report = report.replace(/\| 部分覆盖 \| \d+ \| 代码\/数据库自动化通过，但现场、目标 DB、真实集成或人工步骤未完整执行 \|/, `| 部分覆盖 | ${totals['部分覆盖']} | 代码/数据库自动化通过，但部署运行时、现场、目标 DB、真实集成或人工步骤未完整执行 |`);
report = report.replace(/\| 外部阻塞 \| \d+ \| 附件自身标注盲测\/外部系统\/目标环境\/硬件等前置条件缺失 \|/, `| 外部阻塞 | ${totals['外部阻塞']} | 附件自身标注盲测/外部系统/目标环境/硬件等前置条件缺失 |`);

const moduleTable = [
  '| 模块 | 总数 | 通过 | 失败 | 部分覆盖 | 外部阻塞 |',
  '|---|---:|---:|---:|---:|---:|',
  ...modules.map((row) => `| ${row.module} | ${row.total} | ${row['通过']} | ${row['失败']} | ${row['部分覆盖']} | ${row['外部阻塞']} |`),
].join('\n');
report = report.replace(
  /\| 模块 \| 总数 \| 通过 \| 失败 \| 部分覆盖 \| 外部阻塞 \|[\s\S]*?(?=\n## 缺陷)/,
  `${moduleTable}\n`,
);
for (const status of ['外部阻塞', '部分覆盖', '失败']) {
  const ids = csvRows
    .filter((row) => row[index['本次结果']] === status)
    .map((row) => row[index['用例ID']])
    .join('、');
  report = report.replace(new RegExp(`${status}用例：[^\\n]*。`), `${status}用例：${ids || '无'}。`);
}
await writeFile(reportPath, report, 'utf8');

const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
summary.totals = totals;
summary.modules = modules;
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({ totalCases: csvRows.length, totals, modules }));
