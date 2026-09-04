import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function listFiles(directory) {
  const absoluteDirectory = join(root, directory);
  if (!existsSync(absoluteDirectory)) return [];

  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(relative(root, absolutePath));
    }
    return [relative(root, absolutePath).replaceAll('\\', '/')];
  });
}

const allowedPublicFiles = new Set([
  'public/hero-illustration.png',
  'public/logo.png',
]);

const retiredProductionModules = [
  'src/app/api/init-database/route.ts',
  'src/lib/db/seed.ts',
  'src/lib/db/seed-supabase.ts',
  'src/lib/detection/init-database.ts',
];

for (const modulePath of retiredProductionModules) {
  if (existsSync(join(root, modulePath))) {
    failures.push(`retired production module still exists: ${modulePath}`);
  }
}

for (const guardedLab of [
  'src/app/api/simulate/route.ts',
  'src/app/model-eval/layout.tsx',
  'src/app/simulate/layout.tsx',
]) {
  if (!existsSync(join(root, guardedLab))) {
    failures.push(`guarded experimental lab is missing: ${guardedLab}`);
  } else if (!read(guardedLab).includes('experimentalLabsEnabled')) {
    failures.push(`experimental lab lacks an explicit feature gate: ${guardedLab}`);
  }
}

const productFeatures = read('src/lib/product-features.ts');
if (!productFeatures.includes("environment.NODE_ENV !== 'production'")) {
  failures.push('experimental labs are not hard-disabled in production');
}

const proxy = read('src/proxy.ts');
if (!proxy.includes('experimentalLabsEnabled')) {
  failures.push('experimental labs are not guarded at the HTTP boundary');
}
for (const matcher of [
  '/simulate/:path*',
  '/model-eval/:path*',
  '/api/simulate/:path*',
]) {
  if (!proxy.includes(`'${matcher}'`)) {
    failures.push(`experimental route is missing from the HTTP boundary: ${matcher}`);
  }
}

const applianceBarrel = read('src/lib/appliance/index.ts');
for (const referenceOnlyExport of [
  'AbSystemUpdater',
  'ApplianceBundleRollout',
  'EvidenceWal',
  'FastPathReferenceModel',
  'VirtualApplianceLab',
  'WitnessLeaseAuthority',
]) {
  if (new RegExp(`export\\s+(?:\\{[^}]*\\b${referenceOnlyExport}\\b|class\\s+${referenceOnlyExport}\\b)`, 'su').test(applianceBarrel)) {
    failures.push(`reference-only appliance API is publicly exported: ${referenceOnlyExport}`);
  }
}

for (const file of listFiles('public')) {
  if (!allowedPublicFiles.has(file)) {
    failures.push(`unexpected public asset: ${file}`);
  }
}

for (const file of allowedPublicFiles) {
  if (!existsSync(join(root, file))) {
    failures.push(`required public asset is missing: ${file}`);
  }
}

const dockerignore = read('.dockerignore');
const requiredIgnoreEntries = [
  'tests',
  'acceptance',
  '输出',
  '文档',
  'docs',
  'assets',
  'batch_test*.py',
  'extract_pdf*.py',
  'gen_arch_doc.py',
  'import_sensitive_lexicon.py',
  '*_import.sql',
  'scripts/acceptance',
  'scripts/integration',
];

const ignoreLines = new Set(
  dockerignore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
);

for (const entry of requiredIgnoreEntries) {
  if (!ignoreLines.has(entry)) {
    failures.push(`missing .dockerignore entry: ${entry}`);
  }
}

const dockerfile = read('Dockerfile');
const workerStage = dockerfile.match(
  /FROM node:24\.20\.0-alpine AS worker(?<body>[\s\S]*?)FROM node:24\.20\.0-alpine AS runner/u,
)?.groups?.body;

if (!workerStage) {
  failures.push('could not locate the isolated worker stage');
} else {
  if (/COPY\s+\.\s+\./u.test(workerStage)) {
    failures.push('worker stage copies the complete build context');
  }
  if (/acceptance|batch_test|extract_pdf|gen_arch_doc|gs_login_page|youhua/u.test(workerStage)) {
    failures.push('worker stage references internal QA or prototype content');
  }
  if (/CMD\s*\[\s*["']pnpm["']/u.test(workerStage)) {
    failures.push('worker runtime must not invoke Corepack or download pnpm');
  }
}

const helmValues = read('deploy/helm/guardllm/values.yaml');
if (/command:\s*\["pnpm"\]/u.test(helmValues)) {
  failures.push('Helm workers must use the offline Node dispatcher');
}

if (failures.length > 0) {
  console.error('Production surface verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Production surface verification passed.');
}
