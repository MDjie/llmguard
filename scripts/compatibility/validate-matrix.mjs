import { existsSync, readFileSync } from 'node:fs';

const [file = 'deploy/compatibility/matrix.json', mode = 'schema'] = process.argv.slice(2);
const matrix = JSON.parse(readFileSync(file, 'utf8'));
const allowed = new Set(matrix.statuses ?? []);
const ids = new Set();
const errors = [];
for (const target of matrix.targets ?? []) {
  if (!target.id || ids.has(target.id)) errors.push('missing or duplicate target id: ' + target.id);
  ids.add(target.id);
  if (!allowed.has(target.status)) errors.push(target.id + ' has invalid status ' + target.status);
  for (const evidence of target.evidence ?? []) {
    if (!existsSync(evidence.split('#')[0])) errors.push(target.id + ' evidence path does not exist: ' + evidence);
  }
  if (mode === 'release' && target.required && !['CI_VERIFIED', 'IMPLEMENTED'].includes(target.status)) {
    errors.push(target.id + ' is required but remains ' + target.status);
  }
  if (mode === 'release' && target.required && (target.evidence ?? []).length === 0) {
    errors.push(target.id + ' has no acceptance evidence');
  }
}
if (errors.length > 0) {
  console.error(errors.map((error) => '- ' + error).join('\n'));
  process.exit(1);
}
const summary = Object.fromEntries([...allowed].map((status) => [
  status,
  matrix.targets.filter((target) => target.status === status).length,
]));
console.log(JSON.stringify({ targets: matrix.targets.length, summary, mode }));
