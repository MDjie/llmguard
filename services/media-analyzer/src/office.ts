import {SaxesParser} from 'saxes';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import type {CommandRunner} from './command-runner';
const OFFICE=new Set(['doc','docx','xls','xlsx','ppt','pptx','rtf','odt','ods','odp','wps']);
const crcTable = Uint32Array.from({length:256}, (_, value) => {
 let crc=value;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;return crc>>>0;
});
export function officeCrc32(bytes:Uint8Array):number {
 let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;
}
/** Hyperlinks are inert document content; external images, OLE and linked data are not. */
export function validateOfficeExternalReferences(xml:string):void {
 const parser=new SaxesParser({xmlns:true});let depth=0;
 parser.on('doctype',()=>{throw new Error('ANALYZER_OFFICE_EXTERNAL_CONTENT');});
 parser.on('opentag',tag=>{
  if(++depth>128)throw new Error('ANALYZER_OFFICE_XML_DEPTH_LIMIT');
  const attributes=Object.values(tag.attributes);
  const attribute=(name:string)=>attributes.find(item=>item.local===name)?.value;
  if(attribute('TargetMode')?.toLowerCase()==='external') {
   const type=attribute('Type')??'',target=attribute('Target')??'';
   if(tag.local!=='Relationship'||!/^https?:\/\/(?:schemas\.openxmlformats\.org\/officeDocument\/2006|purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/hyperlink$/u.test(type)||!/^https?:|^mailto:/iu.test(target))throw new Error('ANALYZER_OFFICE_EXTERNAL_CONTENT');
  }
  for(const attr of attributes){
   if(attr.local!=='href')continue;
   const external=/^[a-z][a-z0-9+.-]*:|^\/\/|^\\\\/iu.test(attr.value);
   if(external&&!(tag.local==='a'&&tag.uri==='urn:oasis:names:tc:opendocument:xmlns:text:1.0'&&/^https?:|^mailto:/iu.test(attr.value)))throw new Error('ANALYZER_OFFICE_EXTERNAL_CONTENT');
  }
 });
 parser.on('closetag',()=>{depth--;});parser.write(xml).close();
}
/** Validate ZIP central-directory bounds before LibreOffice sees an OOXML/ODF container. */
export interface OfficePackageMember { containerPath:string;sha256:string;sizeBytes:number;kind:'XML'|'MEDIA'|'EMBEDDED_OBJECT'|'ACTIVE_CONTENT'|'OTHER';execution:'FORBIDDEN'; }
function readOfficePackage(bytes:Buffer,extension:string,inventoryOnly=false):{entries:Array<{name:string;bytes:Buffer}>;members:OfficePackageMember[]}{
 if(bytes.length<4||bytes.readUInt32LE(0)!==0x04034b50)return {entries:[],members:[]};
 const entries:Array<{name:string;bytes:Buffer}>=[],members:OfficePackageMember[]=[];
 let end=-1;for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--){if(bytes.readUInt32LE(offset)===0x06054b50){end=offset;break;}}
 if(end<0||end+22+bytes.readUInt16LE(end+20)!==bytes.length)throw new Error('ANALYZER_OFFICE_ARCHIVE_INVALID');
 const count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12);let pos=bytes.readUInt32LE(end+16),expanded=0;
 if(!count||count>10000||pos+centralSize!==end||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0||bytes.readUInt16LE(end+8)!==count)throw new Error('ANALYZER_OFFICE_ARCHIVE_LIMIT');
 const names=new Set<string>(),ranges:Array<{start:number;end:number}>=[];
 const centralStart=pos;
 for(let index=0;index<count;index++){
  if(pos+46>end||bytes.readUInt32LE(pos)!==0x02014b50)throw new Error('ANALYZER_OFFICE_ARCHIVE_INVALID');
  const flags=bytes.readUInt16LE(pos+8),method=bytes.readUInt16LE(pos+10),compressed=bytes.readUInt32LE(pos+20),size=bytes.readUInt32LE(pos+24),length=bytes.readUInt16LE(pos+28),extra=bytes.readUInt16LE(pos+30),comment=bytes.readUInt16LE(pos+32),local=bytes.readUInt32LE(pos+42);
  if(pos+46+length+extra+comment>end||flags&1||![0,8].includes(method)||local+30>pos)throw new Error('ANALYZER_OFFICE_ARCHIVE_UNSUPPORTED');
  const name=bytes.subarray(pos+46,pos+46+length).toString('utf8');
  if(!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||name.split('/').includes('..')||name.includes(':')||names.has(name))throw new Error('ANALYZER_OFFICE_PATH_INVALID');
  const active=/vbaProject|macros?\/|scripts?\//iu.test(name),embedded=/embeddings\//iu.test(name);
  if(!inventoryOnly&&(active||embedded))throw new Error('ANALYZER_OFFICE_ACTIVE_CONTENT');
  names.add(name);expanded+=size;
  if(expanded>256*1024*1024||size>32*1024*1024||size>Math.max(1,compressed)*1000)throw new Error('ANALYZER_OFFICE_EXPANSION_LIMIT');
  if(bytes.readUInt32LE(local)!==0x04034b50)throw new Error('ANALYZER_OFFICE_ARCHIVE_INVALID');
  const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
  const localName=bytes.subarray(local+30,local+30+bytes.readUInt16LE(local+26)).toString('utf8');
  if(localName!==name||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)throw new Error('ANALYZER_OFFICE_LOCAL_DIRECTORY_MISMATCH');
  if(start+compressed>centralStart||start>centralStart||ranges.some(range=>local<range.end&&start+compressed>range.start))throw new Error('ANALYZER_OFFICE_ARCHIVE_INVALID');
  ranges.push({start:local,end:start+compressed});
  const raw=bytes.subarray(start,start+compressed),decoded=method===8?inflateRawSync(raw,{maxOutputLength:32*1024*1024}):raw;
  if(decoded.length!==size)throw new Error('ANALYZER_OFFICE_ENTRY_SIZE_MISMATCH');
  if(officeCrc32(decoded)!==bytes.readUInt32LE(pos+16))throw new Error('ANALYZER_OFFICE_ENTRY_CHECKSUM_MISMATCH');
  members.push({containerPath:name,sha256:createHash('sha256').update(decoded).digest('hex'),sizeBytes:size,kind:active?'ACTIVE_CONTENT':embedded?'EMBEDDED_OBJECT':/(?:^|\/)(?:media|Pictures)\/|\.(?:png|jpe?g|gif|tiff?|webp|svg|emf|wmf|mp3|mp4|wav)$/iu.test(name)?'MEDIA':/\.xml$|\.rels$/iu.test(name)?'XML':/\.bin$/iu.test(name)?'EMBEDDED_OBJECT':'OTHER',execution:'FORBIDDEN'});
  if(name.endsWith('.rels')||['content.xml','settings.xml'].includes(name)) {
   validateOfficeExternalReferences(new TextDecoder('utf-8',{fatal:true}).decode(decoded));
  }
  if(/\.xml$/iu.test(name)&&!/^(?:docProps|_rels)\/|styles|theme/iu.test(name)) entries.push({name,bytes:decoded});
  pos+=46+length+extra+comment;
 }
 if(pos!==end)throw new Error('ANALYZER_OFFICE_ARCHIVE_INVALID');
 const required:Readonly<Record<string,string>>={docx:'word/document.xml',xlsx:'xl/workbook.xml',pptx:'ppt/presentation.xml',odt:'content.xml',ods:'content.xml',odp:'content.xml'};
 if(required[extension]&&!names.has(required[extension]))throw new Error('ANALYZER_OFFICE_CONTAINER_MISMATCH');
 return {entries,members};
}
export function inspectOfficeZip(bytes:Buffer,extension:string){return readOfficePackage(bytes,extension).entries;}
/** Enumerates inert bytes only; this API never makes a package eligible for rendering. */
export function officePackageInventory(bytes:Buffer,extension:string){
 const {members}=readOfficePackage(bytes,extension,true);
 const unresolved=members.filter(member=>['MEDIA','EMBEDDED_OBJECT','ACTIVE_CONTENT'].includes(member.kind));
 return {version:'office-package-inventory-1' as const,members,unresolved,nativeCoverageClaimed:false as const};
}
export async function officeToPdf(inputPath:string,fileName:string,workspace:string,runner:CommandRunner,timeoutMs:number,signal?:AbortSignal):Promise<string>{
 const extension=extname(fileName).slice(1).toLowerCase();
 if(extension==='ofd')throw new Error('ANALYZER_OFD_ADAPTER_UNAVAILABLE');
 if(!OFFICE.has(extension))throw new Error('ANALYZER_DOCUMENT_FORMAT_UNSUPPORTED');
 const bytes=await readFile(inputPath);if(bytes.length<4||bytes.length>50*1024*1024)throw new Error('ANALYZER_OFFICE_SIZE_INVALID');
 if(['docx','xlsx','pptx','odt','ods','odp'].includes(extension)&&bytes.readUInt32LE(0)!==0x04034b50)throw new Error('ANALYZER_OFFICE_CONTAINER_MISMATCH');
 inspectOfficeZip(bytes,extension);
 const directory=join(workspace,'office'),profile=join(workspace,'office-profile');await mkdir(directory);await mkdir(join(profile,'user'),{recursive:true});
 await writeFile(join(profile,'user','registrymodifications.xcu'),'<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Common/Security/TrustedSources"><prop oor:name="TrustedAuthors" oor:op="fuse"><value/></prop></item></oor:items>');
 const source=join(directory,'source.'+extension);await copyFile(inputPath,source);
 await runner.run(process.env.ANALYZER_OFFICE_COMMAND??'libreoffice',['-env:UserInstallation='+pathToFileURL(profile).href,'--headless','--nologo','--nodefault','--nolockcheck','--norestore','--convert-to','pdf','--outdir',directory,source],{cwd:workspace,timeoutMs,maxOutputBytes:65536,signal});
 const output=join(directory,'source.pdf'),size=(await stat(output)).size;if(!size||size>256*1024*1024)throw new Error('ANALYZER_OFFICE_OUTPUT_INVALID');return output;
}

export interface OfficeTextPart {viewId:string;containerPath:string;text:string;sourceRelation:'OFFICE_PACKAGE_TEXT';}
export function officePackageText(bytes:Buffer,extension:string):OfficeTextPart[]{
 const entries=inspectOfficeZip(bytes,extension),parts:OfficeTextPart[]=[];let characters=0;
 for(const entry of entries){
  if(!/^(?:word\/(?:document|comments\d*|header\d*|footer\d*|footnotes|endnotes)\.xml|xl\/(?:worksheets\/[^/]+|sharedStrings|comments\d*)\.xml|ppt\/(?:slides|notesSlides|comments)\/[^/]+\.xml|content\.xml)$/u.test(entry.name))continue;
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(entry.bytes),parser=new SaxesParser({xmlns:true});
  let text='',depth=0,captureDepth=0;
  const append=(value:string)=>{text+=value;characters+=value.length;if(characters>262144)throw new Error('ANALYZER_OFFICE_TEXT_BUDGET_EXCEEDED');};
  parser.on('doctype',()=>{throw new Error('ANALYZER_OFFICE_XML_DOCTYPE_FORBIDDEN');});
  parser.on('opentag',tag=>{depth++;if(depth>128)throw new Error('ANALYZER_OFFICE_XML_DEPTH_LIMIT');if(!captureDepth&&['t','v','f','p','h'].includes(tag.local))captureDepth=depth;});
  parser.on('text',value=>{if(captureDepth)append(value);});parser.on('cdata',value=>{if(captureDepth)append(value);});
  parser.on('closetag',tag=>{if(captureDepth===depth)captureDepth=0;if(['p','h','row','tc','si','comment'].includes(tag.local))append('\n');depth--;});
  parser.write(xml).close();
  if(text.trim())parts.push({viewId:'office-'+createHash('sha256').update(entry.name).digest('hex').slice(0,24),containerPath:entry.name,text,sourceRelation:'OFFICE_PACKAGE_TEXT'});
 }
 return parts;
}
