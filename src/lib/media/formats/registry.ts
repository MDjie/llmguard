/** Shared, inert format catalog. Runtime readiness is evaluated separately on the server. */
export type MediaCategory = 'text' | 'document' | 'image' | 'audio' | 'video';
export interface MediaFormat {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly mimeTypes: readonly string[];
  readonly category: MediaCategory;
  readonly pipeline: 'text' | 'office' | 'pdf' | 'image' | 'audio' | 'video';
}
const format = (id: string, extensions: string, mimeTypes: string, category: MediaCategory,
  pipeline: MediaFormat['pipeline'] = category === 'document' ? 'office' : category): MediaFormat =>
  ({ id, extensions: extensions.split(' '), mimeTypes: mimeTypes.split(' '), category, pipeline });

export const MEDIA_FORMAT_VERSION = 'multiformat-v1';
export const MEDIA_FORMATS: readonly MediaFormat[] = [
  format('text', 'txt md log css js ts', 'text/plain text/markdown text/css text/javascript application/javascript application/typescript', 'text'),
  format('json', 'json jsonl ndjson', 'application/json application/jsonl application/x-ndjson text/plain', 'text'),
  format('table-text', 'csv tsv', 'text/csv text/tab-separated-values application/csv text/plain', 'text'),
  format('xml', 'xml', 'application/xml text/xml text/plain', 'text'),
  format('html', 'html htm', 'text/html', 'text'),
  format('yaml', 'yaml yml', 'application/yaml application/x-yaml text/yaml text/plain', 'text'),
  format('subtitle', 'srt vtt ass ssa', 'text/plain text/vtt application/x-subrip text/x-ssa', 'text'),
  format('pdf', 'pdf', 'application/pdf', 'document', 'pdf'),
  format('docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'),
  format('doc', 'doc', 'application/msword application/x-ole-storage', 'document'),
  format('xlsx', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document'),
  format('xls', 'xls', 'application/vnd.ms-excel application/x-ole-storage', 'document'),
  format('pptx', 'pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document'),
  format('ppt', 'ppt', 'application/vnd.ms-powerpoint application/x-ole-storage', 'document'),
  format('rtf', 'rtf', 'application/rtf text/rtf', 'document'),
  format('odt', 'odt', 'application/vnd.oasis.opendocument.text', 'document'),
  format('ods', 'ods', 'application/vnd.oasis.opendocument.spreadsheet', 'document'),
  format('odp', 'odp', 'application/vnd.oasis.opendocument.presentation', 'document'),
  format('wps', 'wps', 'application/kswps application/vnd.ms-works application/x-wps application/msword', 'document'),
  format('ofd', 'ofd', 'application/ofd application/vnd.ofd', 'document'),
  format('jpeg', 'jpg jpeg', 'image/jpeg image/jpg image/pjpeg', 'image'),
  format('png', 'png', 'image/png image/x-png', 'image'),
  format('webp', 'webp', 'image/webp', 'image'),
  format('bmp', 'bmp', 'image/bmp image/x-ms-bmp', 'image'),
  format('gif', 'gif', 'image/gif', 'image'),
  format('tiff', 'tif tiff', 'image/tiff image/x-tiff', 'image'),
  format('heif', 'heic heif', 'image/heic image/heif image/heic-sequence image/heif-sequence', 'image'),
  format('avif', 'avif', 'image/avif', 'image'),
  format('wav', 'wav', 'audio/wav audio/x-wav audio/wave audio/vnd.wave', 'audio'),
  format('mp3', 'mp3', 'audio/mpeg audio/mp3 audio/x-mp3', 'audio'),
  format('m4a', 'm4a', 'audio/mp4 audio/x-m4a', 'audio'),
  format('aac', 'aac', 'audio/aac audio/x-aac audio/aacp', 'audio'),
  format('flac', 'flac', 'audio/flac audio/x-flac', 'audio'),
  format('ogg', 'ogg opus', 'audio/ogg audio/opus application/ogg', 'audio'),
  format('wma', 'wma', 'audio/x-ms-wma', 'audio'),
  format('amr', 'amr', 'audio/amr audio/amr-wb', 'audio'),
  format('aiff', 'aiff aif', 'audio/aiff audio/x-aiff', 'audio'),
  format('pcm', 'pcm', 'audio/pcm audio/l16', 'audio'),
  format('mp4', 'mp4 m4v', 'video/mp4 video/x-m4v', 'video'),
  format('mov', 'mov', 'video/quicktime', 'video'),
  format('matroska', 'mkv', 'video/x-matroska application/x-matroska', 'video'),
  format('webm', 'webm', 'video/webm audio/webm', 'video'),
  format('avi', 'avi', 'video/x-msvideo video/avi', 'video'),
  format('wmv', 'wmv', 'video/x-ms-wmv', 'video'),
  format('flv', 'flv', 'video/x-flv', 'video'),
  format('mpeg', 'mpg mpeg', 'video/mpeg', 'video'),
  format('mpegts', 'ts mts m2ts', 'video/mp2t', 'video'),
  format('3gp', '3gp', 'video/3gpp audio/3gpp', 'video'),
];
export const MEDIA_LIMITS: Readonly<Record<MediaCategory, number>> = {
  text: 50 * 1024 ** 2, document: 50 * 1024 ** 2, image: 20 * 1024 ** 2,
  audio: 100 * 1024 ** 2, video: 500 * 1024 ** 2,
};
export const MAX_ATTACHMENTS = 8; // Same bound as existing native job source bindings.
export const MAX_ATTACHMENT_TOTAL_BYTES = 500 * 1024 ** 2;
export const ALL_MEDIA_EXTENSIONS = [...new Set(MEDIA_FORMATS.flatMap(item => item.extensions))];
export const MEDIA_ACCEPT = ALL_MEDIA_EXTENSIONS.map(extension => '.' + extension).join(',');
export function normalizeMediaType(value: string): string { return value.split(';')[0].trim().toLowerCase(); }
export function extensionOf(name: string): string { return name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : ''; }
export function formatForFile(name: string, mimeType = ''): MediaFormat | undefined {
  const extension = extensionOf(name), mime = normalizeMediaType(mimeType);
  const candidates = MEDIA_FORMATS.filter(item => item.extensions.includes(extension));
  return candidates.find(item => item.mimeTypes.includes(mime)) ?? candidates[0];
}
export function mediaCategory(format: MediaFormat, mimeType = ''): MediaCategory {
  return format.id === 'webm' && normalizeMediaType(mimeType) === 'audio/webm' ? 'audio' : format.category;
}
export function extensionsFor(category: MediaCategory): string[] {
  return [...new Set(MEDIA_FORMATS.filter(item => item.category === category).flatMap(item => item.extensions))];
}
export function validateMediaFileMetadata(file: {name: string; type: string; size: number}): {format: MediaFormat; category: MediaCategory} {
  if (!file.name || file.name.length > 255 || /[/\\\x00-\x1f]/u.test(file.name)) throw new Error('FILE_NAME_INVALID');
  const selected = formatForFile(file.name, file.type);
  if (!selected) throw new Error('FILE_TYPE_UNSUPPORTED');
  const category = mediaCategory(selected, file.type), mime = normalizeMediaType(file.type);
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MEDIA_LIMITS[category]) throw new Error('FILE_SIZE_INVALID');
  if (mime && mime !== 'application/octet-stream' && !selected.mimeTypes.includes(mime)) throw new Error('FILE_MEDIA_TYPE_MISMATCH');
  return {format: selected, category};
}
