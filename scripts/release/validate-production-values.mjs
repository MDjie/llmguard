import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/release/validate-production-values.mjs <values.yaml>');
const source = readFileSync(file, 'utf8');
const digests = [...source.matchAll(/digest:\s*["']?(sha256:[a-f0-9]{64})["']?/g)].map((match) => match[1]);
const repositories = [...source.matchAll(/repository:\s*["']?([^\s"'#]+)["']?/g)].map((match) => match[1]);
const errors = [];
if (digests.length < 4) errors.push('app, gateway, worker and analyzer image digests are required');
if (repositories.length < 4) errors.push('app, gateway, worker and analyzer repositories are required');
if (digests.some((digest) => /^sha256:0{64}$/.test(digest))) errors.push('placeholder image digests are forbidden');
if (repositories.some((repository) => repository.includes('.invalid') || repository.endsWith(':latest'))) {
  errors.push('placeholder registries and latest tags are forbidden');
}
if (!/secretRef:\s*[A-Za-z0-9._-]+/.test(source)) errors.push('an external runtime secretRef is required');
if (!/gatewayGrpc:\s*[\s\S]*?enabled:\s*true[\s\S]*?tlsRequired:\s*true/.test(source)) {
  errors.push('production gRPC must be enabled with mutual TLS');
}
if (!/gatewayGrpc:\s*[\s\S]*?secretName:\s*[A-Za-z0-9._-]+/.test(source)) {
  errors.push('gRPC server certificate secretName is required');
}
if (!/analyzerModels:\s*[\s\S]*?claimName:\s*[A-Za-z0-9._-]+/.test(source)) {
  errors.push('an approved analyzer model PVC is required');
}
if (errors.length > 0) {
  console.error(errors.map((error) => '- ' + error).join('\n'));
  process.exit(1);
}
console.log('Production values passed immutable-image and external-secret checks.');
