import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(readFileSync(join(packageRoot, 'model', 'guard-v1.schema.json'), 'utf8'));
const baseline = JSON.parse(
  readFileSync(join(packageRoot, 'baseline', 'guard-v1.compatibility.json'), 'utf8'),
);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function propertySchemaIsBackwardCompatible(previousSchema, currentSchema) {
  if (JSON.stringify(stable(previousSchema)) === JSON.stringify(stable(currentSchema))) return true;
  if (!Array.isArray(previousSchema.oneOf) || !Array.isArray(currentSchema.oneOf)) return false;
  const previousRest = { ...previousSchema };
  const currentRest = { ...currentSchema };
  delete previousRest.oneOf;
  delete currentRest.oneOf;
  if (JSON.stringify(stable(previousRest)) !== JSON.stringify(stable(currentRest))) return false;
  const currentBranches = new Set(
    currentSchema.oneOf.map((branch) => JSON.stringify(stable(branch))),
  );
  return previousSchema.oneOf.every(
    (branch) => currentBranches.has(JSON.stringify(stable(branch))),
  );
}

export function findCompatibilityViolations(currentSource, acceptedBaseline) {
  const violations = [];
  for (const [definitionName, previous] of Object.entries(acceptedBaseline.definitions)) {
    const current = currentSource.$defs[definitionName];
    if (!current) {
      violations.push('removed definition ' + definitionName);
      continue;
    }
    if (JSON.stringify(previous.enum) !== JSON.stringify(current.enum ?? null)) {
      violations.push('changed closed enum ' + definitionName);
    }
    const previousRequired = new Set(previous.required);
    const currentRequired = new Set(current.required ?? []);
    for (const propertyName of currentRequired) {
      if (!previousRequired.has(propertyName)) {
        violations.push('added required property ' + definitionName + '.' + propertyName);
      }
    }
    for (const [propertyName, previousSchema] of Object.entries(previous.properties)) {
      const currentSchema = current.properties?.[propertyName];
      if (!currentSchema) {
        violations.push('removed property ' + definitionName + '.' + propertyName);
        continue;
      }
      if (!propertySchemaIsBackwardCompatible(previousSchema, currentSchema)) {
        violations.push('changed property schema ' + definitionName + '.' + propertyName);
      }
    }
  }
  const currentServices = currentSource['x-grpc-services'] ?? {};
  for (const [serviceName, previousMethods] of Object.entries(acceptedBaseline.services ?? {})) {
    const currentMethods = currentServices[serviceName];
    if (!currentMethods) {
      violations.push('removed service ' + serviceName);
      continue;
    }
    for (const [methodName, previousMethod] of Object.entries(previousMethods)) {
      const currentMethod = currentMethods[methodName];
      if (!currentMethod) {
        violations.push('removed service method ' + serviceName + '.' + methodName);
      } else if (JSON.stringify(stable(previousMethod)) !== JSON.stringify(stable(currentMethod))) {
        violations.push('changed service method ' + serviceName + '.' + methodName);
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = findCompatibilityViolations(source, baseline);
  if (violations.length > 0) {
    process.stderr.write('Breaking Guard v1 contract change:\n- ' + violations.join('\n- ') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Guard v1 is backward compatible with its accepted baseline\n');
  }
}
