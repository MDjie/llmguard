import { withApiSecurity, ApiProblem } from '@/lib/api-security';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { requireTenantContext } from '@/lib/tenancy';
import { mediaRagIngestSchema, submitMediaRagIngest } from '@/lib/rag/media-ingest';
export const POST = withApiSecurity({ permission: 'policy:manage', bodySchema: mediaRagIngestSchema, responseSchema: jsonObjectResponseSchema, maxBodyBytes: 16384,
  auditEvent: 'rag.media.ingest', rateLimitPolicy: { id: 'rag-media-ingest', windowMs: 60000, maxRequests: 10, scope: 'principal' } },
  async ({ principal, body, request }) => {
    try { return Response.json({ success: true, data: await submitMediaRagIngest(requireTenantContext(principal), principal!.subject, body, request.signal) }, { status: 202 }); }
    catch (error: unknown) {
      if (error instanceof Error && /^(MEDIA_RAG_|NORMALIZED_)/.test(error.message)) throw new ApiProblem({ status: 422, code: error.message, title: '媒体入库尚未就绪', detail: '来源、派生内容或检测资格不完整；请完成附件检测后重试。' });
      throw error;
    }
  });
