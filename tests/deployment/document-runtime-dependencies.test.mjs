import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('document runtime dependency isolation', () => {
  it('keeps PDF native dependencies explicit and external to the server bundle', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const nextConfig = readFileSync('next.config.ts', 'utf8');

    expect(packageJson.dependencies['@napi-rs/canvas']).toBe('0.1.80');
    expect(packageJson.dependencies['pdf-parse']).toBeTruthy();
    expect(nextConfig).toContain("'pdf-parse', '@napi-rs/canvas'");
    expect(nextConfig).toContain("'node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas/*'");
    expect(nextConfig).toContain("'node_modules/.pnpm/@napi-rs+canvas-*@*/node_modules/@napi-rs/canvas-*/*'");
    expect(nextConfig).toContain("'node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'");
  });

  it('loads pdf-parse only inside the PDF parser path', () => {
    const parser = readFileSync('src/lib/document/parser.ts', 'utf8');

    expect(parser).toContain("await import('@napi-rs/canvas')");
    expect(parser).toContain("const { PDFParse } = await import('pdf-parse')");
    expect(parser).not.toContain("const pdfParse = require('pdf-parse')");
  });
});
