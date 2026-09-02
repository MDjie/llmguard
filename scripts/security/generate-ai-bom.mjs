import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [runtimeFile, outputFile = 'dist/ai-bom.cdx.json', mode = 'development'] = process.argv.slice(2);
if (!runtimeFile) {
  throw new Error('Usage: node scripts/security/generate-ai-bom.mjs <runtime.json> [output.json] [release]');
}
const catalog = JSON.parse(readFileSync('security/ai-components.json', 'utf8'));
const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
const errors = [];
const components = catalog.components.map((component) => {
  const resolved = runtime.components?.[component.id] ?? {};
  const merged = { ...component, ...resolved };
  if (mode === 'release' && component.runtimeResolved) {
    for (const field of ['supplier', 'name', 'version', 'license', 'source']) {
      if (!merged[field]) errors.push(component.id + ' is missing ' + field);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(merged.sha256 ?? '')) errors.push(component.id + ' has no sha256 digest');
  }
  return {
    type: component.type === 'algorithm' ? 'application' : 'machine-learning-model',
    name: merged.name ?? component.id,
    group: merged.supplier ?? 'unresolved',
    version: merged.version ?? 'unresolved',
    hashes: merged.sha256 ? [{ alg: 'SHA-256', content: merged.sha256.replace('sha256:', '') }] : [],
    licenses: merged.license ? [{ license: { name: merged.license } }] : [],
    externalReferences: merged.source ? [{ type: 'distribution', url: merged.source }] : [],
    properties: [
      { name: 'guardllm:component-id', value: component.id },
      { name: 'guardllm:purpose', value: component.purpose },
      { name: 'guardllm:verification', value: merged.sha256 ? 'digest-recorded' : 'pending' }
    ]
  };
});
if (errors.length > 0) {
  console.error(errors.map((error) => '- ' + error).join('\n'));
  process.exit(1);
}
const serial = createHash('sha256').update(JSON.stringify({ catalog, runtime })).digest('hex');
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: 'urn:uuid:' + [serial.slice(0, 8), serial.slice(8, 12), '4' + serial.slice(13, 16), '8' + serial.slice(17, 20), serial.slice(20, 32)].join('-'),
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: 'GuardLLM', version: '1.0.0' },
    properties: [{ name: 'guardllm:environment', value: runtime.environment ?? 'unspecified' }]
  },
  components
};
const target = resolve(outputFile);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(bom, null, 2) + '\n', { flag: 'w' });
console.log(target);
