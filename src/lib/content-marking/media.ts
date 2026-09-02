import { z } from 'zod';
import { ProviderEndpointPolicy, safeFetchJson } from '@/lib/egress';
import { objectStoreConfig, S3Presigner } from '@/lib/object-store';
import type { TenantScope } from '@/lib/tenancy';
import type { artifactParts, artifacts } from '@/storage/database/shared/schema';
import { createSignedContentMark, resolveContentMarkingConfiguration } from './mark';

const resultSchema = z.object({
  analyzerVersion: z.string().min(1).max(100),
  contentId: z.uuid(),
  output: z.object({
    sizeBytes: z.number().int().positive().max(3 * 1_024 * 1_024 * 1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/mp4', 'video/mp4']),
  }).strict(),
  visibleMarkApplied: z.boolean(),
  spokenMarkApplied: z.boolean(),
  metadataEmbedded: z.literal(true),
}).strict();

function list(value: string | undefined) {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function outputFormat(artifact: typeof artifacts.$inferSelect) {
  if (artifact.kind === 'AUDIO') {
    return { mediaType: 'audio/mp4' as const, extension: 'm4a', maxBytes: 500 * 1_024 * 1_024 };
  }
  if (artifact.kind === 'VIDEO') {
    return { mediaType: 'video/mp4' as const, extension: 'mp4', maxBytes: 3 * 1_024 * 1_024 * 1_024 };
  }
  if (artifact.detectedMediaType === 'image/jpeg') {
    return { mediaType: 'image/jpeg' as const, extension: 'jpg', maxBytes: 100 * 1_024 * 1_024 };
  }
  if (artifact.detectedMediaType === 'image/webp') {
    return { mediaType: 'image/webp' as const, extension: 'webp', maxBytes: 100 * 1_024 * 1_024 };
  }
  return { mediaType: 'image/png' as const, extension: 'png', maxBytes: 100 * 1_024 * 1_024 };
}

export async function markMediaArtifact(input: {
  readonly scope: TenantScope;
  readonly artifact: typeof artifacts.$inferSelect;
  readonly parts: readonly (typeof artifactParts.$inferSelect)[];
  readonly contentId: string;
}) {
  const baseUrl = process.env.MEDIA_ANALYZER_BASE_URL;
  if (!baseUrl) throw new Error('MEDIA_ANALYZER_BASE_URL is required');
  const sharedToken = process.env.ANALYZER_SHARED_TOKEN;
  if (!sharedToken || Buffer.byteLength(sharedToken) < 32) {
    throw new Error('ANALYZER_SHARED_TOKEN must contain at least 32 bytes');
  }
  if (!input.artifact.detectedMediaType || !input.artifact.verifiedSize ||
      !input.artifact.verifiedSha256) {
    throw new Error('Accepted media artifact verification data is incomplete');
  }
  const configuration = resolveContentMarkingConfiguration();
  const modality = input.artifact.kind.toLowerCase() as 'image' | 'audio' | 'video';
  const mark = createSignedContentMark({
    modality,
    serviceProvider: configuration.providerCode,
    key: configuration.key,
    keyId: configuration.keyId,
    contentId: input.contentId,
  });
  const format = outputFormat(input.artifact);
  const outputObjectKey = `${input.artifact.objectPrefix}/generated-marks/${mark.metadata.contentId}.${format.extension}`;
  const signer = new S3Presigner(objectStoreConfig());
  const signedParts = await Promise.all(input.parts.map(async (part) => ({
    partNumber: part.partNumber,
    sizeBytes: part.sizeBytes,
    sha256: part.sha256,
    ...(await signer.presign('GET', part.objectKey, { expiresSeconds: 900 })),
  })));
  const output = await signer.presign('PUT', outputObjectKey, { expiresSeconds: 1_800 });
  const policy = new ProviderEndpointPolicy({
    allowedHosts: list(process.env.MEDIA_ANALYZER_ALLOWED_HOSTS),
    allowedPrivateHosts: list(process.env.MEDIA_ANALYZER_ALLOWED_PRIVATE_HOSTS),
  });
  const response = await safeFetchJson({
    baseUrl,
    path: '/v1/mark/media',
    providerType: 'custom',
    timeoutMs: 30 * 60_000,
    maxRequestBytes: 512 * 1_024,
    maxResponseBytes: 1 * 1_024 * 1_024,
    headers: { 'X-Analyzer-Token': sharedToken },
    body: {
      contractVersion: '1.0',
      context: input.scope,
      artifact: {
        id: input.artifact.id,
        kind: input.artifact.kind,
        fileName: input.artifact.fileName,
        mediaType: input.artifact.detectedMediaType,
        sizeBytes: input.artifact.verifiedSize,
        sha256: input.artifact.verifiedSha256,
        parts: signedParts,
      },
      output: {
        ...output,
        mediaType: format.mediaType,
        maxBytes: format.maxBytes,
      },
      mark: {
        ...mark,
        visibleLabel: configuration.visibleLabel,
      },
      limits: { timeoutMs: 30 * 60_000 },
    },
  }, { policy });
  return {
    mark,
    outputObjectKey,
    result: resultSchema.parse(response),
  };
}
