import type { OcrRegion } from './contracts';
import type { CommandRunner } from './command-runner';

export function parseTesseractTsv(
  tsv: string,
  viewId: string,
  width: number,
  height: number,
  page?: number,
): OcrRegion[] {
  const rows = tsv.split(/\r?\n/u).slice(1);
  const regions: OcrRegion[] = [];
  for (const row of rows) {
    const columns = row.split('\t');
    if (columns.length < 12 || columns[0] !== '5') continue;
    const blockId = Number(columns[2]);
    const paragraphId = Number(columns[3]);
    const lineId = Number(columns[4]);
    const wordId = Number(columns[5]);
    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const boxWidth = Number(columns[8]);
    const boxHeight = Number(columns[9]);
    const confidence = Number(columns[10]);
    const text = columns.slice(11).join('\t').trim();
    if (!text || ![left, top, boxWidth, boxHeight, confidence].every(Number.isFinite) ||
        confidence < 0 || width <= 0 || height <= 0) continue;
    regions.push({
      viewId,
      text: text.slice(0, 10_000),
      confidence: Math.min(1, confidence / 100),
      region: [
        Math.max(0, left / width),
        Math.max(0, top / height),
        Math.min(1, (left + boxWidth) / width),
        Math.min(1, (top + boxHeight) / height),
      ],
      ...(page ? { page } : {}),
      ...(Number.isSafeInteger(blockId) ? { blockId } : {}),
      ...(Number.isSafeInteger(paragraphId) ? { paragraphId } : {}),
      ...(Number.isSafeInteger(lineId) ? { lineId } : {}),
      ...(Number.isSafeInteger(wordId) ? { wordId } : {}),
      sourceRelation: page ? 'OCR_FROM_RENDERED_PAGE' : 'OCR_FROM_IMAGE',
    });
    if (regions.length >= 100_000) break;
  }
  return regions;
}

export async function imageDimensions(
  runner: CommandRunner,
  ffprobe: string,
  imagePath: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number }> {
  const result = await runner.run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', imagePath,
  ], { cwd: workspace, timeoutMs: 30_000, maxOutputBytes: 1_024, signal });
  const [width, height] = result.stdout.trim().split('x').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('ANALYZER_IMAGE_DIMENSIONS_INVALID');
  }
  return { width, height };
}

export async function runOcr(input: {
  runner: CommandRunner;
  tesseract: string;
  ffprobe: string;
  imagePath: string;
  workspace: string;
  viewId: string;
  page?: number;
  sourceRelation?: OcrRegion['sourceRelation'];
  signal?: AbortSignal;
}): Promise<OcrRegion[]> {
  const dimensions = await imageDimensions(
    input.runner, input.ffprobe, input.imagePath, input.workspace, input.signal);
  const result = await input.runner.run(input.tesseract, [
    input.imagePath, 'stdout', '-l',
    process.env.ANALYZER_TESSERACT_LANGUAGES ?? 'chi_sim+eng', 'tsv',
  ], {
    cwd: input.workspace,
    timeoutMs: 60_000,
    maxOutputBytes: 16 * 1_024 * 1_024,
    signal: input.signal,
  });
  return parseTesseractTsv(
    result.stdout, input.viewId, dimensions.width, dimensions.height, input.page).map((region) => ({
      ...region,
      sourceRelation: input.sourceRelation ?? region.sourceRelation,
    }));
}
