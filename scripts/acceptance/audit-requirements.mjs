import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function classifyImplementation(status) {
  if (status === 'ORCHESTRATION_ONLY_EXTERNAL_ANALYZER_REQUIRED') {
    return {
      conclusion: 'NOT_IMPLEMENTED',
      gap: '仅完成任务编排/融合接口，真实分析器、模型与目标格式能力未实现',
    };
  }
  if (status.startsWith('HARNESS_READY_')) {
    return {
      conclusion: 'HARNESS_ONLY',
      gap: '仅具备自动化框架，必须在目标环境执行并提交签名结果',
    };
  }
  if (status.startsWith('PENDING_')) {
    return {
      conclusion: 'NOT_IMPLEMENTED',
      gap: '缺目标适配实现与验证证据',
    };
  }
  if (status.startsWith('IMPLEMENTED_PENDING_')) {
    return {
      conclusion: 'CODE_IMPLEMENTED_ACCEPTANCE_PENDING',
      gap: '代码和本地测试已具备，仍缺真实依赖、数据或目标环境 POC',
    };
  }
  if (status.startsWith('PARTIAL_') || status === 'PARTIAL') {
    return {
      conclusion: 'PARTIAL',
      gap: '只覆盖部分验收行为，仍需按本条验收标准补齐实现或集成',
    };
  }
  return {
    conclusion: 'UNCLASSIFIED',
    gap: '状态未纳入完成度分类规则',
  };
}

export function evidencePaths(value) {
  return Array.isArray(value) ? value : [value];
}

export function assessRequirement(requirement, root = process.cwd()) {
  const implementationPaths = evidencePaths(requirement.implementation);
  const testPaths = evidencePaths(requirement.tests);
  const missingImplementation = implementationPaths.filter((path) => !existsSync(resolve(root, path)));
  const missingTests = testPaths.filter((path) => !existsSync(resolve(root, path)));
  const classification = classifyImplementation(requirement.implementationStatus);
  const mappingStatus = missingImplementation.length === 0 && missingTests.length === 0
    ? 'MAPPING_PATHS_VALID'
    : 'BROKEN_MAPPING';
  return {
    ...requirement,
    ...classification,
    mappingStatus,
    missingImplementation,
    missingTests,
    finalAcceptance: requirement.acceptanceStatus === 'PASS' ? 'PASS' : 'NOT_ACCEPTED',
  };
}

export function summarize(assessments) {
  const countBy = (field) => Object.fromEntries(
    [...new Set(assessments.map((item) => item[field]))]
      .sort()
      .map((value) => [value, assessments.filter((item) => item[field] === value).length]),
  );
  return {
    requirements: assessments.length,
    mapping: countBy('mappingStatus'),
    conclusions: countBy('conclusion'),
    accepted: assessments.filter((item) => item.finalAcceptance === 'PASS').length,
    pendingAcceptance: assessments.filter((item) => item.finalAcceptance !== 'PASS').length,
  };
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br/>');
}

function main() {
  const inputFile = process.argv[2] ?? 'acceptance/generated/requirements.json';
  const jsonFile = process.argv[3] ?? 'acceptance/generated/coverage-audit.json';
  const markdownFile = process.argv[4] ?? 'acceptance/generated/coverage-audit.md';
  const document = JSON.parse(readFileSync(inputFile, 'utf8'));
  const assessments = document.requirements.map((requirement) => assessRequirement(requirement));
  if (assessments.length !== 101) {
    throw new Error(`Expected 101 requirements, found ${assessments.length}`);
  }
  const summary = summarize(assessments);
  const output = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    source: inputFile,
    policy: 'Path mapping is not functional acceptance. PASS requires signed target-environment evidence.',
    summary,
    requirements: assessments,
  };
  mkdirSync(dirname(resolve(jsonFile)), { recursive: true });
  writeFileSync(jsonFile, JSON.stringify(output, null, 2) + '\n');

  const markdown = [
    '# 附件 101 项功能与性能要求逐条自动核对',
    '',
    '> 本报告由代码生成。路径存在只证明代码/测试映射有效，不代表功能或性能验收通过。',
    '',
    `- 需求总数：${summary.requirements}`,
    `- 最终验收通过：${summary.accepted}`,
    `- 待签名验收：${summary.pendingAcceptance}`,
    `- 映射路径异常：${summary.mapping.BROKEN_MAPPING ?? 0}`,
    '',
    '| ID | 优先级 | 需求 | 验收标准 | 实现状态 | 核对结论 | 尚缺内容 | 路径证据 | 最终验收 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...assessments.map((item) => '| ' + [
      item.id,
      item.priority,
      item.requirement,
      item.acceptanceCriteria,
      item.implementationStatus,
      item.conclusion,
      item.gap,
      item.mappingStatus,
      item.finalAcceptance,
    ].map(escapeCell).join(' | ') + ' |'),
    '',
  ].join('\n');
  writeFileSync(markdownFile, markdown);
  process.stdout.write(JSON.stringify(summary) + '\n');
  if ((summary.mapping.BROKEN_MAPPING ?? 0) > 0) process.exitCode = 1;
}

if (import.meta.main) main();
