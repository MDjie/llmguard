'use client';
import {originalPreviewSchema,type OriginalPreview} from '@/contracts/http/original-preview';
import {AuthorizedMediaPreview} from './authorized-media';
export function OriginalPreviewDisplay({preview}:{preview:OriginalPreview}){
 const parsed=originalPreviewSchema.safeParse(preview);
 if(!parsed.success)return <p role="alert">原件预览格式无法验证。</p>;
 const value=parsed.data;
 return <section className="space-y-2" aria-label="经独立审批的原件预览"><p className="text-sm">{value.representation==='PDF_PAGE'?'PDF 第 '+value.page+' / '+value.totalPages+' 页（页面图片）':'原始媒体'}</p><p className="break-all text-xs text-muted-foreground">源 SHA256：{value.sourceSha256}</p><AuthorizedMediaPreview key={value.outputSha256} media={value.media} original/></section>;
}
