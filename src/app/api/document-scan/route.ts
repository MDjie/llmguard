import {and,desc,eq,sql} from 'drizzle-orm';
import {NextResponse} from 'next/server';
import {db,documentScanTasks} from '@/lib/db';
import {formDataWithLimit,withApiSecurity} from '@/lib/api-security';
import {ApiProblem} from '@/lib/api-security/problem';
import {jsonObjectResponseSchema} from '@/contracts/http/common';
import {documentTaskQuerySchema,documentUploadMetadataSchema} from '@/contracts/http/documents';
import {UnsafeDocumentUploadError,validateDocumentUpload} from '@/lib/document/upload-security';
import {requireTenantContext,scopePredicate} from '@/lib/tenancy';
import {loadLatestVerifiedPolicyBundleForPolicy} from '@/lib/policy-bundle';
import {submitGuardJob} from '@/lib/guard-jobs';
import {storeVerifiedBytes} from '@/lib/artifacts/server-upload';
import {validateMediaFileMetadata,normalizeMediaType} from '@/lib/media/formats/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DOCUMENT_RATE_LIMIT = {
  id: 'document-scan',
  windowMs: 60_000,
  maxRequests: 30,
  scope: 'principal' as const,
};
const MULTIPART_BODY_LIMIT = 52 * 1_024 * 1_024;

function problem(status: number, code: string, detail: string): ApiProblem {
  return new ApiProblem({ status, code, title: 'Document request rejected', detail });
}

function publicTaskMetadata(task: typeof documentScanTasks.$inferSelect) {
  const {
    extractedText: _extractedText,
    parsedChunks: _parsedChunks,
    previewHtml: _previewHtml,
    plainLines: _plainLines,
    ocrResults: _ocrResults,
    errorMessage: _errorMessage,
    ...metadata
  } = task;
  return metadata;
}

export const GET = withApiSecurity(
  {
    permission: 'security:operate',
    querySchema: documentTaskQuerySchema,
    responseSchema: jsonObjectResponseSchema,
    rateLimitPolicy: DOCUMENT_RATE_LIMIT,
    maxBodyBytes: 0,
    auditEvent: 'document.scan.list',
  },
  async ({ query, principal }) => {
    const scope = requireTenantContext(principal);
    const conditions = [
      scopePredicate(documentScanTasks, scope),
      eq(documentScanTasks.ownerId, principal!.subject),
    ];
    if (query.policyId) conditions.push(eq(documentScanTasks.policyId, query.policyId));
    if (query.status) conditions.push(eq(documentScanTasks.status, query.status));
    const where = and(...conditions);

    const tasks = await db.select().from(documentScanTasks).where(where)
      .orderBy(desc(documentScanTasks.createdAt)).limit(query.limit).offset(query.offset);
    const countResult = await db.select({ count: sql<number>`count(*)` })
      .from(documentScanTasks).where(where);
    const total = Number(countResult[0]?.count ?? 0);

    return NextResponse.json({
      success: true,
      data: tasks.map(publicTaskMetadata),
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + tasks.length < total,
      },
    });
  },
);

export const POST = withApiSecurity({permission:'security:operate',allowedRequestMediaTypes:['multipart/form-data'],responseSchema:jsonObjectResponseSchema,
 rateLimitPolicy:{id:'document-scan-upload',windowMs:60000,maxRequests:5,scope:'principal'},maxBodyBytes:MULTIPART_BODY_LIMIT,auditEvent:'document.scan.upload'},async({request,principal})=>{
 const scope=requireTenantContext(principal),form=await formDataWithLimit(request,MULTIPART_BODY_LIMIT),file=form.get('file');
 if(!(file instanceof File))throw problem(400,'DOCUMENT_FILE_REQUIRED','请选择文件');
 const metadata=documentUploadMetadataSchema.safeParse({policyId:form.get('policyId'),ocrEnabled:form.get('ocrEnabled')==='true',ocrModel:form.get('ocrModel')||null});
 if(!metadata.success)throw problem(400,'DOCUMENT_METADATA_INVALID','请选择检测策略');
 try{await validateDocumentUpload(file);}catch(error:unknown){if(error instanceof UnsafeDocumentUploadError)throw problem(error.code==='FILE_SIZE_INVALID'?413:400,error.code,error.message);throw error;}
 const bundle=await loadLatestVerifiedPolicyBundleForPolicy(scope,metadata.data.policyId,{routingKey:principal!.subject});
 const selected=validateMediaFileMetadata(file);
 const artifact=await storeVerifiedBytes({scope,ownerId:principal!.subject,kind:selected.category.toUpperCase(),fileName:file.name,mediaType:normalizeMediaType(file.type)||selected.format.mimeTypes[0],bytes:Buffer.from(await file.arrayBuffer()),signal:request.signal});
 const submitted=await submitGuardJob({scope,ownerId:principal!.subject,artifactId:artifact.id,sourceArtifactIds:[artifact.id],bundleId:bundle.id,jobType:'intake',idempotencyKey:'document-'+artifact.id,maxAttempts:2});
 return NextResponse.json({success:true,data:{jobId:submitted.job.id,artifactId:artifact.id,status:submitted.job.status},message:'文件已验证，异步检测任务已创建'},{status:202});
});
