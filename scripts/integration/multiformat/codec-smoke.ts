import {officePackageText} from '../../../services/media-analyzer/src/office';
import {readdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sourcePages} from '../../../services/media-analyzer/src/document-image';
import {ProcessCommandRunner} from '../../../services/media-analyzer/src/command-runner';
import type {DocumentImageRequest} from '../../../services/media-analyzer/src/contracts';
const results:Array<{name:string;status:string;pages?:number;expectedPages?:number;hiddenTextCovered?:boolean|null;code?:string}>=[];
for(const name of await readdir('/fixtures')){
 if(!/\.(png|jpg|webp|bmp|gif|tiff|pdf|doc|docx|xls|xlsx|ppt|pptx|rtf|odt|ods|odp|heic|avif)$/.test(name))continue;
 const mime:Record<string,string>={pdf:'application/pdf',doc:'application/msword',xls:'application/vnd.ms-excel',ppt:'application/vnd.ms-powerpoint',odt:'application/vnd.oasis.opendocument.text',ods:'application/vnd.oasis.opendocument.spreadsheet',odp:'application/vnd.oasis.opendocument.presentation',heic:'image/heif',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',rtf:'application/rtf',jpg:'image/jpeg',tiff:'image/tiff'};
 const extension=name.split('.').at(-1)!,workspace=await mkdtemp('/tmp/codec-');
 const request:DocumentImageRequest={contractVersion:'1.0',context:{tenantId:'fixture',applicationId:'fixture'},artifact:{id:'fixture',kind:['pdf','doc','docx','xls','xlsx','ppt','pptx','rtf','odt','ods','odp'].includes(extension)?'DOCUMENT':'IMAGE',fileName:name,mediaType:mime[extension]??'image/'+extension,sizeBytes:1,sha256:'0'.repeat(64),parts:[{partNumber:1,sizeBytes:1,sha256:'0'.repeat(64),url:'http://unused.invalid'}]},limits:{maxPages:100,maxFrames:100,maxPixels:50000000,maxDecodedBytes:500000000,maxDecodeSeconds:90,maxDecompressionRatio:1000,disableExternalReferences:true,disableActiveContent:true,batchSize:1,minimumConfidence:0.5},views:[{id:'source',transform:'decode_exif',parameters:{},coordinateMapping:'identity'}]};
 try{const pages=await sourcePages(request,join('/fixtures',name),workspace,new ProcessCommandRunner());const hidden=officePackageText(await readFile(join('/fixtures',name)),extension).map(part=>part.text).join('\n');results.push({name,pages:pages.length,hiddenTextCovered:extension==='xlsx'?hidden.includes('HIDDEN CONTENT MUST BE INSPECTED'):extension==='pptx'?hidden.includes('SPEAKER NOTES MUST BE INSPECTED'):null,status:'DECODED',expectedPages:['sample.gif','sample.tiff','sample.pdf'].includes(name)?2:1});}catch(error){results.push({name,status:'FAILED',code:error instanceof Error?error.message:'unknown'});}
}
await writeFile('/results/codec-smoke.json',JSON.stringify({version:'decoder-smoke-1',scope:'DECODING_ONLY_NOT_SECURITY_QUALIFICATION',results},null,2));
console.log(JSON.stringify(results));
if(!results.length||results.some(item=>item.status!=='DECODED'||item.pages!==item.expectedPages||item.hiddenTextCovered===false))process.exitCode=1;
