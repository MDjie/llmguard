import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CommandRunner} from '../../services/media-analyzer/src/command-runner';
const context=vi.hoisted(()=>({workspace:''}));
vi.mock('../../services/media-analyzer/src/artifact-loader',()=>({withLoadedArtifact:async(_artifact:unknown,operation:(file:string,workspace:string)=>Promise<unknown>)=>operation(join(context.workspace,'input.pdf'),context.workspace)}));
import {assertPreviewPng,pdfPreviewRequestSchema,renderPdfPreview} from '../../services/media-analyzer/src/pdf-preview';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1cAAAAASUVORK5CYII=','base64');
const request={contractVersion:'1.0',context:{tenantId:'test',applicationId:'test'},artifact:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'DOCUMENT',mediaType:'application/pdf',sizeBytes:1,sha256:'a'.repeat(64),parts:[{partNumber:1,sizeBytes:1,sha256:'a'.repeat(64),url:'https://store.invalid/one'}]},page:2};
describe('bounded PDF page preview',()=>{
 beforeEach(async()=>{context.workspace=await mkdtemp(join(tmpdir(),'preview-unit-'));});
 afterEach(async()=>{await rm(context.workspace,{recursive:true,force:true});});
 it('renders only the requested page and binds output identity',async()=>{
  const calls:string[][]=[];
  const runner:CommandRunner={run:async(_program,args)=>{calls.push([...args]);if(args.includes('-singlefile'))await writeFile(join(context.workspace,'preview.png'),png);return {stdout:args.includes('-v')?'pdftoppm test version':args.includes('-singlefile')?'':'Pages: 3\n',stderr:'',exitCode:0};}};
  const result=await renderPdfPreview(request,runner);
  expect(result).toMatchObject({artifactId:request.artifact.id,sourceSha256:request.artifact.sha256,page:2,totalPages:3,representation:'PDF_PAGE',media:{mimeType:'image/png'}});
  expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);expect(result.toolchainDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(calls.at(-1)).toContain('-singlefile');expect(calls.at(-1)?.slice(0,9)).toEqual(['-png','-scale-to','1600','-f','2','-l','2','-singlefile',join(context.workspace,'input.pdf')]);
 });
 it('rejects a page outside the actual document before rendering',async()=>{
  const run=vi.fn(async()=>({stdout:'Pages: 1\n',stderr:'',exitCode:0}));
  await expect(renderPdfPreview(request,{run})).rejects.toThrow('PAGE_OUT_OF_BOUNDS');expect(run).toHaveBeenCalledTimes(1);
 });
 it('enforces input, image and pixel budgets',()=>{
  for(const change of [{page:0},{page:2001},{artifact:{...request.artifact,sizeBytes:256*1024*1024+1}},{artifact:{...request.artifact,mediaType:'text/html'}}])expect(pdfPreviewRequestSchema.safeParse({...request,...change}).success).toBe(false);
  expect(()=>assertPreviewPng(png)).not.toThrow();
  expect(()=>assertPreviewPng(Buffer.from('<svg/>'))).toThrow('PNG_INVALID');
  const large=Buffer.from(png);large.writeUInt32BE(1601,16);expect(()=>assertPreviewPng(large)).toThrow('PIXEL_LIMIT');
 });
});
