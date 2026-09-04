import type { CommandRunner } from './command-runner';
import type { CodeRegion } from './contracts';

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function codeKind(value: string): CodeRegion['kind'] {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/gu, '');
  if (normalized.includes('QR')) return 'QR';
  if (normalized.includes('DATAMATRIX')) return 'DATA_MATRIX';
  return 'BARCODE';
}

export function parseZbarXml(
  xml: string,
  viewId: string,
  page?: number,
): CodeRegion[] {
  const regions: CodeRegion[] = [];
  const symbols = xml.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/giu);
  for (const symbol of symbols) {
    const attributes = symbol[1] ?? '';
    const body = symbol[2] ?? '';
    const type = /\btype=['"]([^'"]+)['"]/iu.exec(attributes)?.[1] ?? 'BARCODE';
    const qualityText = /\bquality=['"]([0-9]+)['"]/iu.exec(attributes)?.[1];
    const data = /<data>([\s\S]*?)<\/data>/iu.exec(body)?.[1];
    if (!data) continue;
    const trimmed = data.trim();
    const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/u.exec(trimmed)?.[1] ?? trimmed;
    const text = decodeXml(cdata).normalize('NFKC').slice(0, 16_384);
    if (!text) continue;
    const quality = Number(qualityText ?? 1);
    regions.push({
      kind: codeKind(type),
      text,
      confidence: Math.max(0, Math.min(1, Number.isFinite(quality) ? quality / 10 : 0.1)),
      viewId,
      region: [0, 0, 1, 1],
      ...(page ? { page } : {}),
    });
    if (regions.length >= 100) break;
  }
  return regions;
}

export async function readCodes(input: {
  readonly runner: CommandRunner;
  readonly imagePath: string;
  readonly workspace: string;
  readonly viewId: string;
  readonly page?: number;
  readonly signal?: AbortSignal;
}): Promise<CodeRegion[]> {
  const result = await input.runner.run(
    process.env.ANALYZER_CODE_READER_COMMAND ?? 'zbarimg',
    ['--quiet', '--xml', input.imagePath],
    {
      cwd: input.workspace,
      timeoutMs: 30_000,
      maxOutputBytes: 2 * 1_024 * 1_024,
      acceptedExitCodes: [0, 4],
      signal: input.signal,
    },
  );
  if (result.exitCode === 4 || !result.stdout.trim()) return [];
  return parseZbarXml(result.stdout, input.viewId, input.page);
}
