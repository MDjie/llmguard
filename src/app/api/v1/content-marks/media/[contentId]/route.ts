import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { jsonObjectResponseSchema } from '@/contracts/http/common';
import { withApiSecurity } from '@/lib/api-security';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
import { requireTenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  generatedContentDerivatives,
  generatedContentMarks,
} from '@/storage/database/shared/schema';

const paramsSchema = z.object({ contentId: z.uuid() }).strict();

export const GET = withApiSecurity(
  {
    permission: 'guard:use',
    paramsSchema,
    responseSchema: jsonObjectResponseSchema,
    maxBodyBytes: 0,
    auditEvent: 'content.mark.media.download',
    rateLimitPolicy: {
      id: 'content-mark-media-download',
      windowMs: 60_000,
      maxRequests: 120,
      scope: 'principal',
    },
  },
  async ({ principal, routeContext }) => {
    const { contentId } = await (
      routeContext as { params: Promise<{ contentId: string }> }
    ).params;
    const scope = requireTenantContext(principal);
    const [record] = await db.select({
      contentId: generatedContentMarks.contentId,
      modality: generatedContentMarks.modality,
      metadata: generatedContentMarks.metadata,
      signature: generatedContentMarks.metadataSignature,
      keyId: generatedContentMarks.hashKeyId,
      mediaType: generatedContentDerivatives.mediaType,
      sizeBytes: generatedContentDerivatives.sizeBytes,
      sha256: generatedContentDerivatives.sha256,
      visibleMarkApplied: generatedContentDerivatives.visibleMarkApplied,
      spokenMarkApplied: generatedContentDerivatives.spokenMarkApplied,
      metadataEmbedded: generatedContentDerivatives.metadataEmbedded,
      outputObjectKey: generatedContentDerivatives.outputObjectKey,
    }).from(generatedContentMarks).innerJoin(
      generatedContentDerivatives,
      eq(generatedContentDerivatives.contentMarkId, generatedContentMarks.id),
    ).where(and(
      eq(generatedContentMarks.contentId, contentId),
      eq(generatedContentMarks.createdBy, principal!.subject),
      scopePredicate(generatedContentMarks, scope),
      scopePredicate(generatedContentDerivatives, scope),
    )).limit(1);
    if (!record) {
      return Response.json(
        { type: 'about:blank', title: 'Not Found', status: 404, code: 'CONTENT_MARK_NOT_FOUND' },
        { status: 404 },
      );
    }
    const download = await new S3Presigner(objectStoreConfig())
      .presign('GET', record.outputObjectKey, { expiresSeconds: 900 });
    return Response.json({
      success: true,
      data: {
        contentId: record.contentId,
        modality: record.modality,
        metadata: record.metadata,
        signature: record.signature,
        keyId: record.keyId,
        mediaType: record.mediaType,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        visibleMarkApplied: record.visibleMarkApplied,
        spokenMarkApplied: record.spokenMarkApplied,
        metadataEmbedded: record.metadataEmbedded,
        download,
      },
    });
  },
);
