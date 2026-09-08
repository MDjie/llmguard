import {ProcessCommandRunner} from './command-runner';
let cached:{until:number;value:Record<string,unknown>}|undefined;
const configured=(value:string|undefined)=>Boolean(value?.trim()&&!value.includes('${'));
export async function analyzerCapabilities():Promise<Record<string,unknown>>{
 if(cached&&cached.until>Date.now())return cached.value;
 const runner=new ProcessCommandRunner(),cwd=process.env.TMPDIR??'/tmp';
 const probe=async(program:string,args:string[])=>{try{const result=await runner.run(program,args,{cwd,timeoutMs:5000,maxOutputBytes:262144,acceptedExitCodes:[0,1]});return result.stdout+'\n'+result.stderr;}catch{return null;}};
 const [decoders,office,pdf,ocr,codes,heif,tiff]=await Promise.all([probe(process.env.ANALYZER_FFMPEG_COMMAND??'ffmpeg',['-hide_banner','-decoders']),probe(process.env.ANALYZER_OFFICE_COMMAND??'libreoffice',['--version']),probe(process.env.ANALYZER_PDFTOPPM_COMMAND??'pdftoppm',['-v']),probe(process.env.ANALYZER_TESSERACT_COMMAND??'tesseract',['--version']),probe(process.env.ANALYZER_CODE_READER_COMMAND??'zbarimg',['--version']),probe(process.env.ANALYZER_HEIF_CONVERT_COMMAND??'heif-convert',['--list-decoders']),probe(process.env.ANALYZER_TIFFINFO_COMMAND??'tiffinfo',['-h'])]);
 const decoderNames = decoders ? decoders.split('\n').flatMap(line => { const match = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line); return match ? [match[1]] : []; }) : [];
 const value={decoders:decoderNames,version:'analyzer-capabilities-1',checkedAt:new Date().toISOString(),decoding:{ffmpeg:Boolean(decoders),office:Boolean(office),pdf:Boolean(pdf),ocr:Boolean(ocr),codes:Boolean(codes)},
  codecAvailability:{heif:Boolean(heif&&/libde265|HEVC/iu.test(heif)),avif:Boolean(decoders&&/av1/iu.test(decoders)),tiff:Boolean(tiff&&decoders&&/tiff/iu.test(decoders))},
  adapters:{visual:configured(process.env.ANALYZER_VISUAL_COMMAND),asr:configured(process.env.ANALYZER_ASR_COMMAND),audioClassifier:configured(process.env.ANALYZER_AUDIO_CLASSIFIER_COMMAND),nativeJoint:configured(process.env.ANALYZER_NATIVE_JOINT_COMMAND)},qualification:'POLICY_AND_MODEL_APPROVAL_REQUIRED'};
 cached={until:Date.now()+60000,value};return value;
}
