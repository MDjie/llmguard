const MAX_DOCUMENT_BYTES = 50 * 1_024 * 1_024;
const BINARY_MIME_TYPES: Readonly<Record<string, readonly string[]>> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  doc: ['application/msword', 'application/x-ole-storage'],
  wps: ['application/kswps', 'application/vnd.ms-works', 'application/x-wps'],
  ofd: ['application/ofd'],
  odt: ['application/vnd.oasis.opendocument.text'],
  rtf: ['application/rtf', 'text/rtf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  bmp: ['image/bmp', 'image/x-ms-bmp'],
};
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'csv',
  'xml',
  'html',
  'css',
  'js',
  'ts',
]);

export class UnsafeDocumentUploadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'UnsafeDocumentUploadError';
  }
}

function startsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

function hasExpectedSignature(extension: string, bytes: Uint8Array): boolean {
  switch (extension) {
    case 'pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);
    case 'docx':
    case 'ofd':
    case 'odt':
      return (
        startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
        startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
      );
    case 'doc':
      return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'wps':
      return (
        startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) ||
        startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
      );
    case 'rtf':
      return new TextDecoder().decode(bytes.slice(0, 6)).toLowerCase() === '{\\rtf1';
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'gif':
      return new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
    case 'webp':
      return (
        new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
        new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
      );
    case 'bmp':
      return startsWith(bytes, [0x42, 0x4d]);
    default:
      return false;
  }
}

export async function validateDocumentUpload(
  file: File,
): Promise<{ extension: string; size: number }> {
  if (!file.name || file.name.length > 255 || /[/\\]/.test(file.name)) {
    throw new UnsafeDocumentUploadError('FILE_NAME_INVALID', 'The file name is invalid');
  }
  if (file.size <= 0 || file.size > MAX_DOCUMENT_BYTES) {
    throw new UnsafeDocumentUploadError(
      'FILE_SIZE_INVALID',
      'The file must be between 1 byte and 50 MiB',
    );
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const head = new Uint8Array(await file.slice(0, 4_096).arrayBuffer());

  if (TEXT_EXTENSIONS.has(extension)) {
    if (head.includes(0)) {
      throw new UnsafeDocumentUploadError(
        'FILE_SIGNATURE_INVALID',
        'Text uploads must not contain binary NUL bytes',
      );
    }
    return { extension, size: file.size };
  }

  const allowedMimeTypes = BINARY_MIME_TYPES[extension];
  if (!allowedMimeTypes) {
    throw new UnsafeDocumentUploadError('FILE_TYPE_UNSUPPORTED', 'The file type is unsupported');
  }
  if (file.type && !allowedMimeTypes.includes(file.type.toLowerCase())) {
    throw new UnsafeDocumentUploadError(
      'FILE_MEDIA_TYPE_MISMATCH',
      'The file media type does not match its extension',
    );
  }
  if (!hasExpectedSignature(extension, head)) {
    throw new UnsafeDocumentUploadError(
      'FILE_SIGNATURE_INVALID',
      'The file signature does not match its extension',
    );
  }
  return { extension, size: file.size };
}
