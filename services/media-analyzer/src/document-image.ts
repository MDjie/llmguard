import { copyFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { withLoadedArtifact } from './artifact-loader';
import type { CommandRunner } from './command-runner';
import type { DocumentImageRequest, OcrRegion, VisualRisk } from './contracts';
import { classifyImage } from './model-adapters';
import { runOcr } from './ocr';
import { mapInBatches } from './batching';

interface ImageView {
  readonly id: string;
  readonly path: string;
  readonly transform: string;
  readonly page: number;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 100);
}

async function sourcePages(
  request: DocumentImageRequest,
  inputPath: string,
  workspace: string,
  runner: CommandRunner,
): Promise<string[]> {
  if (request.artifact.kind === 'IMAGE') {
    const target = join(workspace, 'page-0001.png');
    await runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', inputPath, '-frames:v', '1', '-y', target,
    ], { cwd: workspace, timeoutMs: request.limits.maxDecodeSeconds * 1_000 });
    return [target];
  }
  if (request.artifact.mediaType !== 'application/pdf') {
    throw new Error('ANALYZER_DOCUMENT_FORMAT_UNSUPPORTED');
  }
  await runner.run(process.env.ANALYZER_PDFTOPPM_COMMAND ?? 'pdftoppm', [
    '-png', '-r', '150', '-f', '1', '-l', String(request.limits.maxPages),
    inputPath, join(workspace, 'page'),
  ], { cwd: workspace, timeoutMs: request.limits.maxDecodeSeconds * 1_000 });
  const pages = (await readdir(workspace))
    .filter((name) => /^page-\d+\.png$/u.test(name))
    .sort().map((name) => join(workspace, name));
  if (pages.length === 0 || pages.length > request.limits.maxPages) {
    throw new Error('ANALYZER_DOCUMENT_PAGE_LIMIT');
  }
  return pages;
}

function videoFilter(transform: string, parameters: Readonly<Record<string, string | number | boolean>>): string | null {
  if (transform === 'decode_exif') return null;
  if (transform === 'rotate') {
    const degrees = Number(parameters.degrees);
    if (degrees === 90) return 'transpose=clock';
    if (degrees === 180) return 'hflip,vflip';
    if (degrees === 270) return 'transpose=cclock';
  }
  if (transform === 'grayscale') return 'format=gray';
  if (transform === 'contrast') return `eq=contrast=${Number(parameters.factor ?? 1.5)}`;
  if (transform === 'adaptive_threshold') return "format=gray,lutyuv=y='if(gt(val,128),255,0)'";
  if (transform === 'median_denoise') return 'median=radius=1';
  if (transform === 'tile') {
    const row = Number(parameters.row ?? 0);
    const column = Number(parameters.column ?? 0);
    const rows = Number(parameters.rows ?? 2);
    const columns = Number(parameters.columns ?? 2);
    if ([row, column, rows, columns].every(Number.isInteger) && rows > 0 && columns > 0) {
      return `crop=iw/${columns}:ih/${rows}:iw*${column}/${columns}:ih*${row}/${rows}`;
    }
  }
  throw new Error('ANALYZER_IMAGE_TRANSFORM_UNSUPPORTED');
}

async function materializeViews(
  request: DocumentImageRequest,
  pages: readonly string[],
  workspace: string,
  runner: CommandRunner,
): Promise<ImageView[]> {
  if (pages.length * request.views.length > request.limits.maxFrames) {
    throw new Error('ANALYZER_DERIVED_VIEW_LIMIT');
  }
  const result: ImageView[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    for (const plan of request.views) {
      const id = pages.length === 1 ? plan.id : `page_${pageIndex + 1}_${plan.id}`;
      const target = join(workspace, `view-${safeName(id)}.png`);
      const filter = videoFilter(plan.transform, plan.parameters);
      if (!filter) {
        await copyFile(pages[pageIndex], target);
      } else {
        await runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
          '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-i', pages[pageIndex], '-vf', filter, '-frames:v', '1', '-y', target,
        ], { cwd: workspace, timeoutMs: request.limits.maxDecodeSeconds * 1_000 });
      }
      result.push({ id, path: target, transform: plan.transform, page: pageIndex + 1 });
    }
  }
  return result;
}

function tokens(text: string): Set<string> {
  return new Set(text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function disagreement(left: string, right: string): number {
  const first = tokens(left);
  const second = tokens(right);
  if (first.size === 0 && second.size === 0) return 0;
  const intersection = [...first].filter((item) => second.has(item)).length;
  const union = new Set([...first, ...second]).size;
  return 1 - intersection / Math.max(1, union);
}

function anomalyType(transform: string) {
  if (transform === 'rotate') return 'rotation' as const;
  if (transform === 'tile') return 'reorder' as const;
  if (transform === 'median_denoise') return 'noise' as const;
  return 'decoder_disagreement' as const;
}

export async function analyzeDocumentImage(
  request: DocumentImageRequest,
  runner: CommandRunner,
) {
  const maxBytes = request.artifact.kind === 'IMAGE'
    ? 100 * 1_024 * 1_024 : 500 * 1_024 * 1_024;
  if (request.artifact.sizeBytes > maxBytes) throw new Error('ANALYZER_ARTIFACT_TOO_LARGE');
  return withLoadedArtifact(request.artifact, async (inputPath, workspace) => {
    const pages = await sourcePages(request, inputPath, workspace, runner);
    const views = await materializeViews(request, pages, workspace, runner);
    const ocr: OcrRegion[] = [];
    const visual: VisualRisk[] = [];
    const versions = new Set<string>();
    const analyzedViews = await mapInBatches(
      views,
      request.limits.batchSize,
      async (view) => {
        const [regions, classified] = await Promise.all([
          runOcr({
            runner,
            tesseract: process.env.ANALYZER_TESSERACT_COMMAND ?? 'tesseract',
            ffprobe: process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe',
            imagePath: view.path,
            workspace,
            viewId: view.id,
            page: view.page,
          }),
          classifyImage({
            runner, imagePath: view.path, workspace, viewId: view.id,
          }),
        ]);
        return { regions, classified };
      },
    );
    for (const analyzed of analyzedViews) {
      versions.add(analyzed.classified.modelVersion);
      ocr.push(...analyzed.regions.filter(
        (region) => region.confidence >= request.limits.minimumConfidence,
      ));
      visual.push(...analyzed.classified.risks.filter(
        (risk) => risk.score >= request.limits.minimumConfidence,
      ));
    }
    const anomalies: Array<{
      type: 'rotation' | 'occlusion' | 'mosaic' | 'noise' | 'reorder' | 'adversarial_patch' | 'decoder_disagreement';
      score: number;
      viewIds: string[];
    }> = [];
    for (const page of pages.keys()) {
      const pageViews = views.filter((view) => view.page === page + 1);
      const original = pageViews.find((view) => view.transform === 'decode_exif');
      if (!original) continue;
      const originalText = ocr.filter((item) => item.viewId === original.id).map((item) => item.text).join(' ');
      for (const view of pageViews) {
        if (view === original) continue;
        const transformed = ocr.filter((item) => item.viewId === view.id).map((item) => item.text).join(' ');
        const score = disagreement(originalText, transformed);
        if (score >= 0.5) anomalies.push({
          type: anomalyType(view.transform),
          score,
          viewIds: [original.id, view.id],
        });
      }
    }
    return {
      analyzerVersion: `media-analyzer/1.0+${[...versions].sort().join(',')}`,
      ocr,
      visual,
      anomalies: anomalies.slice(0, 100),
      derivatives: [],
    };
  });
}
