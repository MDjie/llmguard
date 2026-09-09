import {officeToPdf,officePackageText,officePackageInventory} from './office';
import { mapRegion, inverseRotation, tileMapping, type Affine } from '../../../src/lib/evidence/coordinate-mapping';
import { copyFile, readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withLoadedArtifact } from './artifact-loader';
import type { CommandRunner } from './command-runner';
import type {
  AnalysisFailure,
  CodeRegion,
  DocumentElement,
  DocumentImageRequest,
  OcrRegion,
  VisualLabel,
  VisualRisk,
} from './contracts';
import { classifyImage } from './model-adapters';
import { imageDimensions, runOcr } from './ocr';
import { mapInBatches } from './batching';
import { readCodes } from './code-reader';
import { AnalyzerDependencyGuard } from './resilience';

interface ImageView {
  readonly id: string;
  readonly path: string;
  readonly transform: string;
  readonly page: number;
  readonly mapping: {viewId:string;page:number;basis:string;mappingVersion:string;sourceWidth:number;sourceHeight:number;matrix:Affine;transform:string;parameters:Readonly<Record<string,string|number|boolean>>};
}

const ocrGuard = new AnalyzerDependencyGuard({
  component: 'OCR', timeoutMs: 60_000, maxAttempts: 2,
  maximumConcurrent: 8, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});
const codeGuard = new AnalyzerDependencyGuard({
  component: 'CODE_READER', timeoutMs: 30_000, maxAttempts: 2,
  maximumConcurrent: 4, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});
const visualGuard = new AnalyzerDependencyGuard({
  component: 'VISUAL', timeoutMs: 120_000, maxAttempts: 2,
  maximumConcurrent: 4, circuitFailureThreshold: 3, circuitResetMs: 30_000,
});

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 100);
}

export function assertImageResourceBudget(input: {
  readonly pixels: number;
  readonly decodedBytes: number;
  readonly artifactBytes: number;
  readonly maxPixels: number;
  readonly maxDecodedBytes: number;
  readonly maxDecompressionRatio: number;
  readonly expansionBasis?: 'COMPRESSED_IMAGE' | 'DOCUMENT_RENDER';
}): void {
  if (
    !Number.isSafeInteger(input.pixels) || input.pixels < 0 ||
    !Number.isSafeInteger(input.decodedBytes) || input.decodedBytes < 0 ||
    !Number.isSafeInteger(input.artifactBytes) || input.artifactBytes < 0
  ) {
    throw new Error('ANALYZER_IMAGE_BUDGET_INPUT_INVALID');
  }
  if (input.pixels > input.maxPixels) throw new Error('ANALYZER_PIXEL_LIMIT');
  if (input.decodedBytes > input.maxDecodedBytes) {
    throw new Error('ANALYZER_DECODED_BYTES_LIMIT');
  }
  // Document rasterization is not decompression: a short RTF may render a full page.
  // ZIP expansion is checked in inspectOfficeZip; all documents retain page/pixel/byte/time limits.
  if (input.expansionBasis !== 'DOCUMENT_RENDER' && input.decodedBytes / Math.max(1, input.artifactBytes) > input.maxDecompressionRatio) {
    throw new Error('ANALYZER_DECOMPRESSION_RATIO_LIMIT');
  }
}

function failure(
  component: AnalysisFailure['component'],
  required: boolean,
  error: unknown,
): AnalysisFailure {
  const candidate = error instanceof Error ? error.message : '';
  const code = /^ANALYZER_[A-Z0-9_:.-]+$/u.test(candidate)
    ? candidate.slice(0, 160)
    : `ANALYZER_${component}_FAILED`;
  return { component, required, code };
}

function uniqueFailures(values: readonly AnalysisFailure[]): AnalysisFailure[] {
  return [...new Map(values.map((item) => [
    `${item.component}:${item.required}:${item.code}`,
    item,
  ])).values()].slice(0, 100);
}

export function parsePdfPageCount(stdout:string,maximum:number):number{
  const matches=[...stdout.matchAll(/^Pages:\s+(\d+)\s*$/gmu)];
  const count=matches.length===1?Number(matches[0][1]):0;
  if(!Number.isSafeInteger(count)||count<1||count>maximum)throw new Error('ANALYZER_DOCUMENT_PAGE_LIMIT');
  return count;
}
export async function sourcePages(
  request: DocumentImageRequest,
  inputPath: string,
  workspace: string,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<string[]> {
  if (request.artifact.kind === 'IMAGE' && ['image/heif','image/heic'].includes(request.artifact.mediaType)) {
    const info=await runner.run(process.env.ANALYZER_HEIF_INFO_COMMAND??'heif-info',[inputPath],{cwd:workspace,timeoutMs:request.limits.maxDecodeSeconds*1000,maxOutputBytes:262144,signal});
    const dimensions=[...info.stdout.matchAll(/^image: (\d+)x(\d+) /gmu)];
    if(!dimensions.length||/image sequence|main brand: (?:msf1|hevs|hevx)/iu.test(info.stdout))throw new Error('ANALYZER_HEIF_SEQUENCE_PROFILE_UNAVAILABLE');
    if(dimensions.length>request.limits.maxPages||dimensions.length*request.views.length>request.limits.maxFrames||dimensions.reduce((sum,match)=>sum+Number(match[1])*Number(match[2]),0)>request.limits.maxPixels)throw new Error('ANALYZER_IMAGE_RESOURCE_LIMIT');
    await runner.run(process.env.ANALYZER_HEIF_CONVERT_COMMAND??'heif-convert',['--quiet','--with-aux','--no-colons','--codec-threads','2','--tile-threads','2',inputPath,join(workspace,'heif.png')],{cwd:workspace,timeoutMs:request.limits.maxDecodeSeconds*1000,maxOutputBytes:65536,signal});
    const pages=(await readdir(workspace)).filter(name=>/^heif(?:[-_][A-Za-z0-9._-]+)?\.png$/u.test(name)).sort().map(name=>join(workspace,name));
    if(pages.length<dimensions.length||pages.length>request.limits.maxPages||pages.length*request.views.length>request.limits.maxFrames)throw new Error('ANALYZER_HEIF_IMAGE_COVERAGE_INCOMPLETE');
    return pages;
  }
  if (request.artifact.kind === 'IMAGE' && request.artifact.mediaType === 'image/tiff') {
    const info = await runner.run(process.env.ANALYZER_TIFFINFO_COMMAND ?? 'tiffinfo', [inputPath], {cwd:workspace, timeoutMs:request.limits.maxDecodeSeconds*1000, maxOutputBytes:262144,signal});
    const directories=[...info.stdout.matchAll(/^=== TIFF directory (\d+) ===$/gmu)];
    const dimensions=[...info.stdout.matchAll(/Image Width: (\d+) Image Length: (\d+)/gu)];
    if (!directories.length || directories.length !== dimensions.length || /SubIFD|ExifIFD|GPSIFD/iu.test(info.stdout)) throw new Error('ANALYZER_TIFF_DIRECTORY_COVERAGE_UNSUPPORTED');
    const pixels=dimensions.reduce((sum,match)=>sum+Number(match[1])*Number(match[2]),0);
    if (directories.length>request.limits.maxPages || directories.length*request.views.length>request.limits.maxFrames || pixels>request.limits.maxPixels) throw new Error('ANALYZER_IMAGE_RESOURCE_LIMIT');
    await runner.run(process.env.ANALYZER_TIFFSPLIT_COMMAND ?? 'tiffsplit',[inputPath,join(workspace,'split-')],{cwd:workspace,timeoutMs:request.limits.maxDecodeSeconds*1000,signal});
    const split=(await readdir(workspace)).filter(name=>/^split-[a-z]+\.tif$/u.test(name)).sort();
    if(split.length!==directories.length)throw new Error('ANALYZER_TIFF_PAGE_COVERAGE_INCOMPLETE');
    const pages:string[]=[];
    for(const [index,name] of split.entries()) {
      const target=join(workspace,`page-${String(index+1).padStart(6,'0')}.png`);
      await runner.run(process.env.ANALYZER_FFMPEG_COMMAND??'ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',join(workspace,name),'-frames:v','1','-y',target],{cwd:workspace,timeoutMs:request.limits.maxDecodeSeconds*1000,signal});pages.push(target);
    }
    return pages;
  }
  if (request.artifact.kind === 'IMAGE') {
    const probe=await runner.run(process.env.ANALYZER_FFPROBE_COMMAND??'ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames,width,height','-of','json',inputPath],
      {cwd:workspace,timeoutMs:request.limits.maxDecodeSeconds*1000,maxOutputBytes:65536,signal});
    const countSchema=z.object({streams:z.array(z.object({nb_read_frames:z.string(),width:z.number().int().positive(),height:z.number().int().positive()})).length(1)});
    const stream=countSchema.parse(JSON.parse(probe.stdout)).streams[0],frames=stream.nb_read_frames;
    const frameCount=Number(frames);
    if(!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>Math.min(request.limits.maxPages,request.limits.maxFrames))throw new Error('ANALYZER_IMAGE_FRAME_LIMIT');
    if(frameCount*request.views.length>request.limits.maxFrames||stream.width*stream.height*frameCount>request.limits.maxPixels)throw new Error('ANALYZER_IMAGE_RESOURCE_LIMIT');
    if(frameCount>1){
      await runner.run(process.env.ANALYZER_FFMPEG_COMMAND??'ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',inputPath,'-vsync','0','-frames:v',String(frameCount),'-y',join(workspace,'page-%06d.png')],{cwd:workspace,timeoutMs:request.limits.maxDecodeSeconds*1000,signal});
      const pages=(await readdir(workspace)).filter(name=>/^page-\d+\.png$/u.test(name)).sort().map(name=>join(workspace,name));
      if(pages.length!==frameCount)throw new Error('ANALYZER_IMAGE_FRAME_COVERAGE_INCOMPLETE');
      return pages;
    }
    const target = join(workspace, 'page-0001.png');
    await runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
      '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', inputPath, '-frames:v', '1', '-y', target,
    ], {
      cwd: workspace, timeoutMs: request.limits.maxDecodeSeconds * 1_000, signal,
    });
    return [target];
  }
  if (request.artifact.mediaType !== 'application/pdf') {
    inputPath=await officeToPdf(inputPath,request.artifact.fileName??'',workspace,runner,request.limits.maxDecodeSeconds*1000,signal);
  }
  const info=await runner.run(process.env.ANALYZER_PDFINFO_COMMAND??'pdfinfo',[inputPath],{cwd:workspace,timeoutMs:request.limits.maxDecodeSeconds*1000,maxOutputBytes:65536,signal});
  const expectedPages=parsePdfPageCount(info.stdout,request.limits.maxPages);
  if(expectedPages*request.views.length>request.limits.maxFrames)throw new Error('ANALYZER_DERIVED_VIEW_LIMIT');
  await runner.run(process.env.ANALYZER_PDFTOPPM_COMMAND ?? 'pdftoppm', [
    '-png', '-r', '150', '-f', '1', '-l', String(request.limits.maxPages),
    inputPath, join(workspace, 'page'),
  ], {
    cwd: workspace, timeoutMs: request.limits.maxDecodeSeconds * 1_000, signal,
  });
  const pages = (await readdir(workspace))
    .filter((name) => /^page-\d+\.png$/u.test(name))
    .sort().map((name) => join(workspace, name));
  if (pages.length !== expectedPages) {
    throw new Error('ANALYZER_DOCUMENT_PAGE_LIMIT');
  }
  return pages;
}

function videoFilter(
  transform: string,
  parameters: Readonly<Record<string, string | number | boolean>>,
): string | null {
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
  signal?: AbortSignal,
): Promise<ImageView[]> {
  if (pages.length * request.views.length > request.limits.maxFrames) {
    throw new Error('ANALYZER_DERIVED_VIEW_LIMIT');
  }
  const result: ImageView[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const dimensions=await imageDimensions(runner,process.env.ANALYZER_FFPROBE_COMMAND??'ffprobe',pages[pageIndex],workspace,signal);
    for (const plan of request.views) {
      const id = pages.length === 1 ? plan.id : `page_${pageIndex + 1}_${plan.id}`;
      const target = join(workspace, `view-${safeName(id)}.png`);
      let filter = videoFilter(plan.transform, plan.parameters);
      let matrix:Affine=inverseRotation(plan.transform==='rotate'?Number(plan.parameters.degrees):0);
      if(plan.transform==='tile'){
        const tile=tileMapping(dimensions.width,dimensions.height,Number(plan.parameters.row??0),Number(plan.parameters.column??0),Number(plan.parameters.rows??2),Number(plan.parameters.columns??2));
        matrix=tile.matrix;filter=`crop=${tile.width}:${tile.height}:${tile.x}:${tile.y}:exact=1`;
      }
      if (!filter) {
        await copyFile(pages[pageIndex], target);
      } else {
        await runner.run(process.env.ANALYZER_FFMPEG_COMMAND ?? 'ffmpeg', [
          '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
          '-i', pages[pageIndex], '-vf', filter, '-frames:v', '1', '-y', target,
        ], {
          cwd: workspace, timeoutMs: request.limits.maxDecodeSeconds * 1_000, signal,
        });
      }
      result.push({ id, path: target, transform: plan.transform, page: pageIndex + 1,mapping:{viewId:id,page:pageIndex+1,basis:'DISPLAY_ORIENTED_SOURCE_PAGE',mappingVersion:'inverse-image-view-1',sourceWidth:dimensions.width,sourceHeight:dimensions.height,matrix,transform:plan.transform,parameters:plan.parameters} });
    }
  }
  return result;
}

async function assertDecodeBudgets(
  request: DocumentImageRequest,
  pages: readonly string[],
  views: readonly ImageView[],
  runner: CommandRunner,
  workspace: string,
  signal?: AbortSignal,
): Promise<void> {
  let pixels = 0;
  for (const page of pages) {
    const dimensions = await imageDimensions(
      runner,
      process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe',
      page,
      workspace,
      signal,
    );
    pixels += dimensions.width * dimensions.height;
    if (!Number.isSafeInteger(pixels) || pixels > request.limits.maxPixels) {
      throw new Error('ANALYZER_PIXEL_LIMIT');
    }
  }
  let decodedBytes = 0;
  for (const filePath of [...pages, ...views.map((view) => view.path)]) {
    decodedBytes += (await stat(filePath)).size;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > request.limits.maxDecodedBytes) {
      throw new Error('ANALYZER_DECODED_BYTES_LIMIT');
    }
  }
  assertImageResourceBudget({
    pixels,
    decodedBytes,
    artifactBytes: request.artifact.sizeBytes,
    expansionBasis: request.artifact.kind === 'DOCUMENT' ? 'DOCUMENT_RENDER' : 'COMPRESSED_IMAGE',
    maxPixels: request.limits.maxPixels,
    maxDecodedBytes: request.limits.maxDecodedBytes,
    maxDecompressionRatio: request.limits.maxDecompressionRatio,
  });
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

function unionRegion(regions: readonly OcrRegion[]): readonly [number, number, number, number] {
  return [
    Math.min(...regions.map((item) => item.region[0])),
    Math.min(...regions.map((item) => item.region[1])),
    Math.max(...regions.map((item) => item.region[2])),
    Math.max(...regions.map((item) => item.region[3])),
  ];
}

function documentElements(ocr: readonly OcrRegion[]): DocumentElement[] {
  const elements: DocumentElement[] = [];
  const pages = new Map<string, OcrRegion[]>();
  const paragraphs = new Map<string, OcrRegion[]>();
  const lines = new Map<string, OcrRegion[]>();
  for (const item of ocr) {
    const page = item.page ?? 1;
    const pageKey = `${item.viewId}:p${page}`;
    const paragraphKey = `${pageKey}:b${item.blockId ?? 0}:p${item.paragraphId ?? 0}`;
    const lineKey = `${paragraphKey}:l${item.lineId ?? 0}`;
    pages.set(pageKey, [...(pages.get(pageKey) ?? []), item]);
    paragraphs.set(paragraphKey, [...(paragraphs.get(paragraphKey) ?? []), item]);
    lines.set(lineKey, [...(lines.get(lineKey) ?? []), item]);
    elements.push({
      elementId: `${lineKey}:w${item.wordId ?? elements.length}`.slice(0, 128),
      kind: 'WORD', page, region: item.region, sourceViewId: item.viewId,
      parentElementId: lineKey.slice(0, 128),
    });
  }
  for (const [id, items] of lines) elements.push({
    elementId: id.slice(0, 128), kind: 'LINE', page: items[0].page ?? 1,
    region: unionRegion(items), sourceViewId: items[0].viewId,
    parentElementId: id.slice(0, id.lastIndexOf(':l')).slice(0, 128),
  });
  for (const [id, items] of paragraphs) elements.push({
    elementId: id.slice(0, 128), kind: 'PARAGRAPH', page: items[0].page ?? 1,
    region: unionRegion(items), sourceViewId: items[0].viewId,
    parentElementId: id.slice(0, id.indexOf(':b')).slice(0, 128),
  });
  for (const [id, items] of pages) elements.push({
    elementId: id.slice(0, 128), kind: 'PAGE', page: items[0].page ?? 1,
    region: [0, 0, 1, 1], sourceViewId: items[0].viewId,
  });
  return elements.slice(0, 100_000);
}

export async function analyzeDocumentImage(
  request: DocumentImageRequest,
  runner: CommandRunner,
  signal?: AbortSignal,
) {
  const maxBytes = request.artifact.kind === 'IMAGE'
    ? 100 * 1_024 * 1_024 : 500 * 1_024 * 1_024;
  if (request.artifact.sizeBytes > maxBytes) throw new Error('ANALYZER_ARTIFACT_TOO_LARGE');
  return withLoadedArtifact(request.artifact, async (inputPath, workspace) => {
    const officeBytes=request.artifact.kind==='DOCUMENT'&&request.artifact.mediaType!=='application/pdf'?await readFile(inputPath):null;
    const officeExtension=(request.artifact.fileName??'').split('.').at(-1)?.toLowerCase()??'';
    const inventory=officeBytes?officePackageInventory(officeBytes,officeExtension):null;
    const documentText=officeBytes?officePackageText(officeBytes,officeExtension):[];
    const pages = await sourcePages(request, inputPath, workspace, runner, signal);
    const views = await materializeViews(request, pages, workspace, runner, signal);
    await assertDecodeBudgets(request, pages, views, runner, workspace, signal);
    const ocr: OcrRegion[] = [];
    const codes: CodeRegion[] = [];
    const labels: VisualLabel[] = [];
    const visual: VisualRisk[] = [];
    const failures: AnalysisFailure[] = [
      ...(inventory?.unresolved.length ? [{component:'VISUAL' as const,required:true,code:'ANALYZER_OFFICE_EMBEDDED_CONTENT_UNANALYZED'}] : []),
      ...(inventory?.coverageGaps.map(code=>({component:'VISUAL' as const,required:true,code}))??[]),
    ];
    const versions = new Set<string>();
    let lowConfidenceOcr=false;
    const analyzedViews = await mapInBatches(
      views,
      Math.min(request.limits.batchSize,ocrGuard.maximumConcurrent,visualGuard.maximumConcurrent,codeGuard.maximumConcurrent),
      async (view) => {
        const [ocrResult, visualResult, codeResult] = await Promise.allSettled([
          ocrGuard.execute((attemptSignal) => runOcr({
            runner,
            tesseract: process.env.ANALYZER_TESSERACT_COMMAND ?? 'tesseract',
            ffprobe: process.env.ANALYZER_FFPROBE_COMMAND ?? 'ffprobe',
            imagePath: view.path,
            workspace,
            viewId: view.id,
            page: view.page,
            signal: attemptSignal,
          }), signal),
          visualGuard.execute((attemptSignal) => classifyImage({
            runner, imagePath: view.path, workspace, viewId: view.id, signal: attemptSignal,
          }), signal),
          codeGuard.execute((attemptSignal) => readCodes({
            runner, imagePath: view.path, workspace, viewId: view.id,
            page: view.page, signal: attemptSignal,
          }), signal),
        ]);
        return { view, ocrResult, visualResult, codeResult };
      },
      signal,
    );
    for (const analyzed of analyzedViews) {
      if (analyzed.ocrResult.status === 'fulfilled') {
        if(analyzed.ocrResult.value.some(region=>region.confidence<request.limits.minimumConfidence))lowConfidenceOcr=true;
        ocr.push(...analyzed.ocrResult.value.filter(
          (region) => region.confidence >= request.limits.minimumConfidence,
        ).map(region=>({...region,region:mapRegion(region.region,analyzed.view.mapping.matrix)})));
      } else {
        failures.push(failure('OCR', true, analyzed.ocrResult.reason));
      }
      if (analyzed.visualResult.status === 'fulfilled') {
        versions.add(analyzed.visualResult.value.modelVersion);
        labels.push(...analyzed.visualResult.value.labels.filter(
          (label) => label.score >= request.limits.minimumConfidence,
        ).map(label=>({...label,...(label.region?{region:mapRegion(label.region,analyzed.view.mapping.matrix)}:{})})));
        visual.push(...analyzed.visualResult.value.risks.filter(
          (risk) => risk.score >= request.limits.minimumConfidence,
        ).map(risk=>({...risk,...(risk.region?{region:mapRegion(risk.region,analyzed.view.mapping.matrix)}:{})})));
      } else {
        failures.push(failure('VISUAL', true, analyzed.visualResult.reason));
      }
      if (analyzed.codeResult.status === 'fulfilled') {
        codes.push(...analyzed.codeResult.value.map(code=>({...code,region:mapRegion(code.region,analyzed.view.mapping.matrix)})));
      } else {
        failures.push(failure('CODE_READER', true, analyzed.codeResult.reason));
      }
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
    const analysisFailures = uniqueFailures(failures);
    return {
      analyzerVersion: `media-analyzer/1.1+${[...versions].sort().join(',') || 'degraded'}`,
      coverage:{artifactSha256:request.artifact.sha256,modality:request.artifact.kind,
        state:analysisFailures.length||lowConfidenceOcr?'INCOMPLETE' as const:'COMPLETE' as const,
        unit:'PAGE_VIEW' as const,expectedUnits:pages.length*request.views.length,processedUnits:views.length,
        processingCoverage:[{unit:'PAGE_VIEW' as const,expected:pages.length*request.views.length,processed:views.length,failed:0,skipped:Math.max(0,pages.length*request.views.length-views.length)}],
        analyzerVersion:`media-analyzer/1.1+${[...versions].sort().join(',') || 'degraded'}`,
        reasonCodes:[...analysisFailures.map(f=>f.code),...(lowConfidenceOcr?['OCR_LOW_CONFIDENCE_REGIONS']:[])]},
      coordinateMappings:[...(inventory?.members.map(member=>({...member,mappingVersion:inventory.version,coverage:'INVENTORY_ONLY',sourceRelation:'OFFICE_PACKAGE_MEMBER'}))??[]),...views.map(view=>view.mapping),...documentText.map(part=>({viewId:part.viewId,containerPath:part.containerPath,sourceRelation:part.sourceRelation,mappingVersion:'office-package-text-1',offsetEncoding:'UTF16'}))],
      documentText,
      ocr,
      codes,
      labels,
      documentElements: documentElements(ocr),
      visual,
      anomalies: anomalies.slice(0, 100),
      analysisFailures,
      degraded: analysisFailures.length > 0,
      derivatives: [],
    };
  }, signal);
}
