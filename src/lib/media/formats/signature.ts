import type {MagicDetection} from '@/lib/artifacts/magic';
import type {MediaFormat} from './registry';
export function signatureMatchesFormat(format: MediaFormat, detected: MagicDetection): boolean {
  if(format.category==='text') return detected.family==='text';
  if(format.pipeline==='office') {
    if(format.id==='rtf') return detected.mediaType==='application/rtf';
    return (['docx','xlsx','pptx','odt','ods','odp','ofd','wps'].includes(format.id)&&detected.container==='zip') ||
      (['doc','xls','ppt','wps'].includes(format.id)&&detected.container==='ole');
  }
  if(format.id==='m4a') return detected.container==='iso-bmff'&&['audio','video'].includes(detected.family);
  if(format.id==='webm') return detected.container==='ebml'&&detected.mediaType==='video/webm';
  if(format.id==='wma'||format.id==='wmv') return detected.container==='asf';
  if(format.id==='heif') return detected.mediaType==='image/heif';
  return format.mimeTypes.includes(detected.mediaType);
}
