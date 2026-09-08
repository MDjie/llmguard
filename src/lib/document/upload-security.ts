import { signatureMatchesFormat } from '@/lib/media/formats/signature';
import { detectMagic } from '@/lib/artifacts/magic';
import { extensionOf, validateMediaFileMetadata } from '@/lib/media/formats/registry';
import { decodeText } from '@/lib/media/formats/text-decoder';
export class UnsafeDocumentUploadError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'UnsafeDocumentUploadError'; }
}
export async function validateDocumentUpload(file: File): Promise<{extension: string; size: number}> {
  try {
    const {format, category}=validateMediaFileMetadata(file);
    const bytes=new Uint8Array(await file.slice(0,4096).arrayBuffer()), detected=detectMagic(bytes);
    if(category==='text') decodeText(bytes,undefined,true);
    else if(!signatureMatchesFormat(format,detected)) throw new Error('FILE_SIGNATURE_INVALID');
    if(format.id==='pcm') throw new Error('PCM_METADATA_REQUIRED');
    return {extension:extensionOf(file.name),size:file.size};
  } catch(error) {
    const code=error instanceof Error && /^[A-Z_]+$/.test(error.message)?error.message:'FILE_SIGNATURE_INVALID';
    throw new UnsafeDocumentUploadError(code,code);
  }
}
