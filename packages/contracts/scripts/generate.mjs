import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(packageRoot, 'model', 'guard-v1.schema.json');
const sourceText = readFileSync(sourcePath, 'utf8');
const source = JSON.parse(sourceText);
const sourceHash = createHash('sha256').update(sourceText).digest('hex');
const definitions = source.$defs;
const grpcServices = source['x-grpc-services'] ?? {};

function refName(schema) {
  return schema.$ref?.split('/').at(-1);
}

function unionType(types, mapper) {
  return types.map(mapper).join(' | ');
}

function typescriptType(schema) {
  const reference = refName(schema);
  if (reference) return reference;
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum) return unionType(schema.enum, JSON.stringify);
  if (schema.oneOf) return unionType(schema.oneOf, typescriptType);
  if (Array.isArray(schema.type)) {
    return unionType(schema.type, (type) => typescriptType({ type }));
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  if (schema.type === 'array') return 'readonly ' + typescriptType(schema.items) + '[]';
  if (schema.type === 'object') {
    const valueSchema = schema.additionalProperties;
    return 'Readonly<Record<string, ' + (valueSchema ? typescriptType(valueSchema) : 'unknown') + '>>';
  }
  return 'unknown';
}

function renderTypescript() {
  const lines = [
    '// Generated from model/guard-v1.schema.json. Do not edit.',
    '// Source SHA-256: ' + sourceHash,
    '',
    "export const GUARD_CONTRACT_VERSION = '1.0' as const;",
    "export const GUARD_CONTRACT_SOURCE_SHA256 = '" + sourceHash + "' as const;",
    '',
  ];
  for (const [name, schema] of Object.entries(definitions)) {
    if (schema.enum) {
      lines.push('export type ' + name + ' = ' + typescriptType(schema) + ';', '');
      continue;
    }
    if (schema.type !== 'object') continue;
    const required = new Set(schema.required ?? []);
    lines.push('export interface ' + name + ' {');
    for (const [propertyName, propertySchema] of Object.entries(schema.properties ?? {})) {
      const optional = required.has(propertyName) ? '' : '?';
      lines.push('  readonly ' + propertyName + optional + ': ' + typescriptType(propertySchema) + ';');
    }
    lines.push('}', '');
  }
  return lines.join('\n') + '\n';
}

function javaType(schema) {
  const reference = refName(schema);
  if (reference) return reference;
  if (schema.oneOf) return 'Object';
  if (Array.isArray(schema.type)) return 'Object';
  if (schema.type === 'string' || 'const' in schema) return 'String';
  if (schema.type === 'integer') return 'long';
  if (schema.type === 'number') return 'double';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') return 'List<' + boxedJavaType(schema.items) + '>';
  if (schema.type === 'object') return 'Map<String, Object>';
  return 'Object';
}

function boxedJavaType(schema) {
  const type = javaType(schema);
  if (type === 'long') return 'Long';
  if (type === 'double') return 'Double';
  if (type === 'boolean') return 'Boolean';
  return type;
}

function renderJava() {
  const lines = [
    '// Generated from model/guard-v1.schema.json. Do not edit.',
    '// Source SHA-256: ' + sourceHash,
    'package io.guardllm.contracts.v1;',
    '',
    'import java.util.List;',
    'import java.util.Map;',
    '',
    'public final class GuardContracts {',
    '  public static final String CONTRACT_VERSION = "1.0";',
    '  public static final String SOURCE_SHA256 = "' + sourceHash + '";',
    '  private GuardContracts() {}',
    '',
  ];
  for (const [name, schema] of Object.entries(definitions)) {
    if (schema.enum) {
      lines.push('  public enum ' + name + ' { ' + schema.enum.join(', ') + ' }', '');
      continue;
    }
    if (schema.type !== 'object') continue;
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {});
    lines.push('  public record ' + name + '(');
    properties.forEach(([propertyName, propertySchema], index) => {
      const suffix = index === properties.length - 1 ? '' : ',';
      const type = required.has(propertyName) ? javaType(propertySchema) : boxedJavaType(propertySchema);
      lines.push('    ' + type + ' ' + propertyName + suffix);
    });
    lines.push('  ) {}', '');
  }
  lines.push('}', '');
  return lines.join('\n');
}

function pythonType(schema) {
  const reference = refName(schema);
  if (reference) return reference;
  if ('const' in schema) return 'Literal[' + JSON.stringify(schema.const) + ']';
  if (schema.enum) return 'Literal[' + schema.enum.map(JSON.stringify).join(', ') + ']';
  if (schema.oneOf) return unionType(schema.oneOf, pythonType);
  if (Array.isArray(schema.type)) {
    return unionType(schema.type, (type) => pythonType({ type }));
  }
  if (schema.type === 'string') return 'str';
  if (schema.type === 'integer') return 'int';
  if (schema.type === 'number') return 'float';
  if (schema.type === 'boolean') return 'bool';
  if (schema.type === 'null') return 'None';
  if (schema.type === 'array') return 'list[' + pythonType(schema.items) + ']';
  if (schema.type === 'object') return 'dict[str, object]';
  return 'object';
}

function renderPython() {
  const lines = [
    '# Generated from model/guard-v1.schema.json. Do not edit.',
    '# Source SHA-256: ' + sourceHash,
    'from typing import Literal, NotRequired, TypedDict',
    '',
    "GUARD_CONTRACT_VERSION = '1.0'",
    "GUARD_CONTRACT_SOURCE_SHA256 = '" + sourceHash + "'",
    '',
  ];
  for (const [name, schema] of Object.entries(definitions)) {
    if (schema.enum) {
      lines.push(name + ' = ' + pythonType(schema), '');
      continue;
    }
    if (schema.type !== 'object') continue;
    const required = new Set(schema.required ?? []);
    lines.push('class ' + name + '(TypedDict):');
    const properties = Object.entries(schema.properties ?? {});
    if (properties.length === 0) lines.push('    pass');
    for (const [propertyName, propertySchema] of properties) {
      const type = pythonType(propertySchema);
      lines.push('    ' + propertyName + ': ' + (required.has(propertyName) ? type : 'NotRequired[' + type + ']'));
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function replaceRefs(value) {
  if (Array.isArray(value)) return value.map(replaceRefs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === '$ref' && typeof item === 'string') {
        return [key, item.replace('#/$defs/', '#/components/schemas/')];
      }
      return [key, replaceRefs(item)];
    }),
  );
}

function renderOpenApi() {
  const document = {
    openapi: '3.1.0',
    info: { title: 'GuardLLM Guard API', version: '1.0.0' },
    paths: {
      '/v1/guard/check': {
        post: {
          operationId: 'checkGuardContent',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/GuardRequest' } },
            },
          },
          responses: {
            200: {
              description: 'Guard decision',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/GuardDecision' } },
              },
            },
            default: {
              description: 'Guard protocol error',
              content: {
                'application/problem+json': { schema: { $ref: '#/components/schemas/GuardError' } },
              },
            },
          },
        },
      },
    },
    components: { schemas: replaceRefs(definitions) },
  };
  return JSON.stringify(document, null, 2) + '\n';
}

function snakeCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function protoType(schema) {
  const reference = refName(schema);
  if (reference) return reference;
  if (schema.oneOf || schema.type === 'object' || Array.isArray(schema.type)) {
    return 'google.protobuf.Value';
  }
  if (schema.type === 'string' || 'const' in schema) return 'string';
  if (schema.type === 'integer') return 'int64';
  if (schema.type === 'number') return 'double';
  if (schema.type === 'boolean') return 'bool';
  return 'google.protobuf.Value';
}

function renderProto() {
  const lines = [
    '// Generated from model/guard-v1.schema.json. Do not edit.',
    '// Source SHA-256: ' + sourceHash,
    'syntax = "proto3";',
    '',
    'package guardllm.contracts.v1;',
    '',
    'import "google/protobuf/struct.proto";',
    '',
    'option java_package = "io.guardllm.contracts.v1.proto";',
    'option java_multiple_files = true;',
    '',
  ];
  for (const [name, schema] of Object.entries(definitions)) {
    if (schema.enum) {
      lines.push('enum ' + name + ' {', '  ' + snakeCase(name).toUpperCase() + '_UNSPECIFIED = 0;');
      schema.enum.forEach((value, index) => {
        lines.push('  ' + snakeCase(name).toUpperCase() + '_' + value + ' = ' + (index + 1) + ';');
      });
      lines.push('}', '');
      continue;
    }
    if (schema.type !== 'object') continue;
    const required = new Set(schema.required ?? []);
    lines.push('message ' + name + ' {');
    Object.entries(schema.properties ?? {}).forEach(([propertyName, propertySchema], index) => {
      const repeated = propertySchema.type === 'array';
      const itemSchema = repeated ? propertySchema.items : propertySchema;
      const qualifier = repeated ? 'repeated ' : required.has(propertyName) ? '' : 'optional ';
      lines.push(
        '  ' + qualifier + protoType(itemSchema) + ' ' + snakeCase(propertyName) + ' = ' + (index + 1) + ';',
      );
    });
    lines.push('}', '');
  }
  for (const [serviceName, methods] of Object.entries(grpcServices)) {
    lines.push('service ' + serviceName + ' {');
    for (const [methodName, method] of Object.entries(methods)) {
      const request = (method.requestStream ? 'stream ' : '') + method.request;
      const response = (method.responseStream ? 'stream ' : '') + method.response;
      lines.push('  rpc ' + methodName + '(' + request + ') returns (' + response + ');');
    }
    lines.push('}', '');
  }
  return lines.join('\n') + '\n';
}

function compatibilitySignature() {
  const signature = {};
  for (const [name, schema] of Object.entries(definitions)) {
    signature[name] = {
      enum: schema.enum ?? null,
      required: schema.required ?? [],
      properties: Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([propertyName, propertySchema]) => [
          propertyName,
          propertySchema,
        ]),
      ),
    };
  }
  return {
    contractVersion: '1.0',
    definitions: signature,
    services: grpcServices,
  };
}

const outputMap = {
  'generated/typescript/guard-v1.ts': renderTypescript(),
  'generated/java/io/guardllm/contracts/v1/GuardContracts.java': renderJava(),
  'generated/python/guard_contracts_v1.py': renderPython(),
  'openapi/guard-v1.openapi.json': renderOpenApi(),
  'proto/guard/v1/guard.proto': renderProto(),
  '../../services/guard-gateway/src/main/proto/guard/v1/guard.proto': renderProto(),
};

const manifest = {
  contractVersion: '1.0',
  source: 'model/guard-v1.schema.json',
  sourceSha256: sourceHash,
  outputs: Object.fromEntries(
    Object.entries(outputMap).map(([path, content]) => [
      path,
      createHash('sha256').update(content).digest('hex'),
    ]),
  ),
};
outputMap['generated/manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';

const checkMode = process.argv.includes('--check');
const acceptBaseline = process.argv.includes('--accept-baseline');
const drift = [];

for (const [relativePath, content] of Object.entries(outputMap)) {
  const outputPath = join(packageRoot, relativePath);
  if (checkMode) {
    if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== content) drift.push(relativePath);
    continue;
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');
}

if (acceptBaseline) {
  const baselinePath = join(packageRoot, 'baseline', 'guard-v1.compatibility.json');
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(compatibilitySignature(), null, 2) + '\n', 'utf8');
}

if (drift.length > 0) {
  process.stderr.write('Generated contract drift: ' + drift.join(', ') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(
    (checkMode ? 'Contract outputs are current' : 'Generated contract outputs') +
      ' (source ' +
      sourceHash +
      ')\n',
  );
}
