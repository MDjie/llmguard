import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  convertOfficeDocument,
  DocumentConversionError,
  parseDocumentConverterCommand,
} from '../../src/lib/document/converter';

describe('sandbox document converter adapter', () => {
  it('requires an absolute executable and one input/output placeholder', () => {
    expect(() => parseDocumentConverterCommand(
      JSON.stringify(['converter', '{input}', '{output}']),
      '/tmp/input.wps',
      '/tmp/output.txt',
    )).toThrow(DocumentConversionError);
    expect(() => parseDocumentConverterCommand(
      JSON.stringify([process.execPath, '{input}', '{input}', '{output}']),
      '/tmp/input.wps',
      '/tmp/output.txt',
    )).toThrow(/exactly once/);
  });

  it('runs without a shell, reads bounded UTF-8 output and cleans the workspace', async () => {
    const script = [
      'const fs=require("node:fs");',
      'const output=process.argv[1];',
      'const input=process.argv[2];',
      'fs.writeFileSync(output, "converted:" + fs.statSync(input).size);',
    ].join('');
    const result = await convertOfficeDocument(Buffer.from('source'), 'wps', {
      commandJson: JSON.stringify([
        resolve(process.execPath),
        '-e',
        script,
        '{output}',
        '{input}',
      ]),
      timeoutMs: 5_000,
    });
    expect(result).toBe('converted:6');
  });
});
