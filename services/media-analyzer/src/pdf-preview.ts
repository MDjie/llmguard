import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {documentImageRequestSchema} from './contracts';
import {withLoadedArtifact} from './artifact-loader';
import {parsePdfPageCount} from './document-image';
import type {CommandRunner} from './command-runner';
import {originalPreviewSchema,ORIGINAL_PDF_MAX_BYTES,ORIGINAL_PAGE_MAX} from '../../../src/contracts/http/original-preview';
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export const pdfPreviewRequestSchema=z.object({contractVersion:z.literal('1.0'),context:documentImageRequestSchema.shape.context,artifact:documentImageRequestSchema.shape.artifact.extend({kind:z.literal('DOCUMENT'),mediaType:z.literal('application/pdf'),sizeBytes:z.number().int().positive().max(ORIGINAL_PDF_MAX_BYTES)}).strict(),page:z.number().int().min(1).max(ORIGINAL_PAGE_MAX)}).strict();
export function assertPreviewPng(bytes:Uint8Array){
 const value=Buffer.from(bytes);
 if(value.length<33||value.length>8*1024*1024||!value.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||value.toString('ascii',12,16)!=='IHDR')throw new Error('ANALYZER_PREVIEW_PNG_INVALID');
 const width=value.readUInt32BE(16),height=value.readUInt32BE(20);
 if(width<1||height<1||width>1600||height>1600)throw new Error('ANALYZER_PREVIEW_PIXEL_LIMIT');
}
export async function renderPdfPreview(raw:unknown,runner:CommandRunner,signal?:AbortSignal){
 const request=pdfPreviewRequestSchema.parse(raw);
 return withLoadedArtifact(request.artifact,async(inputPath,workspace)=>{
  const options={cwd:workspace,timeoutMs:30000,maxOutputBytes:65536,signal},pdfinfo=process.env.ANALYZER_PDFINFO_COMMAND??'pdfinfo',pdftoppm=process.env.ANALYZER_PDFTOPPM_COMMAND??'pdftoppm';
  const info=await runner.run(pdfinfo,[inputPath],options),totalPages=parsePdfPageCount(info.stdout,ORIGINAL_PAGE_MAX);
  if(request.page>totalPages)throw new Error('ANALYZER_PREVIEW_PAGE_OUT_OF_BOUNDS');
  const version=await runner.run(pdftoppm,['-v'],options),identity=version.stdout+version.stderr;
  if(!identity.trim())throw new Error('ANALYZER_PREVIEW_RENDERER_UNKNOWN');
  const target=join(workspace,'preview');
  await runner.run(pdftoppm,['-png','-scale-to','1600','-f',String(request.page),'-l',String(request.page),'-singlefile',inputPath,target],options);
  const file=await stat(target+'.png');if(!file.isFile()||file.size>8*1024*1024)throw new Error('ANALYZER_PREVIEW_OUTPUT_LIMIT');
  const bytes=await readFile(target+'.png');
  try{assertPreviewPng(bytes);return originalPreviewSchema.parse({version:'original-preview-1',artifactId:request.artifact.id,sourceSha256:request.artifact.sha256,representation:'PDF_PAGE',page:request.page,totalPages,transformVersion:'pdf-page-raster-1',toolchainDigest:hash(identity),outputSha256:hash(bytes),media:{mimeType:'image/png',dataBase64:bytes.toString('base64')}});}
  finally{bytes.fill(0);}
 },signal);
}
