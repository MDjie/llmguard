import { contentFingerprint } from '@/lib/data-protection/content';
import { buildLineageEdge } from '@/lib/data-protection/lineage';
import type { TenantContext } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import {
  dataLineageEdges,
  generatedContentMarks,
} from '@/storage/database/shared/schema';
import {
  applyVisibleTextMark,
  createSignedContentMark,
  exemptionExpiresAt,
  resolveContentMarkingConfiguration,
} from './mark';

export interface MarkTextInput {
  readonly text: string;
  readonly explicitMark: boolean;
  readonly exemption?: {
    readonly agreementVersion: string;
    readonly purpose: string;
  };
}

export async function markGeneratedText(scope: TenantContext, input: MarkTextInput) {
  if (!input.explicitMark && (!input.exemption?.agreementVersion.trim() || !input.exemption.purpose.trim())) {
    throw new Error('A recorded agreement and purpose are required when the explicit mark is omitted');
  }
  const configuration = resolveContentMarkingConfiguration();
  const mark = createSignedContentMark({
    modality: 'text',
    serviceProvider: configuration.providerCode,
    key: configuration.key,
    keyId: configuration.keyId,
  });
  const markedText = input.explicitMark
    ? applyVisibleTextMark(input.text, configuration.visibleLabel)
    : input.text;
  const createdAt = new Date(mark.metadata.createdAt);
  await db.transaction(async (transaction) => {
    const [record] = await transaction.insert(generatedContentMarks).values({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      contentId: mark.metadata.contentId,
      modality: mark.metadata.modality,
      serviceProvider: mark.metadata.serviceProvider,
      generatedContent: true,
      explicitMarkApplied: input.explicitMark,
      metadata: { ...mark.metadata },
      metadataSignature: mark.signature,
      hashKeyId: mark.keyId,
      contentHash: contentFingerprint(markedText),
      exemptionSubjectId: input.explicitMark ? null : scope.principalId,
      exemptionAgreementVersion: input.explicitMark ? null : input.exemption?.agreementVersion,
      exemptionPurpose: input.explicitMark ? null : input.exemption?.purpose,
      retainUntil: input.explicitMark ? null : exemptionExpiresAt(createdAt),
      createdBy: scope.principalId,
      createdAt,
    }).returning({ id: generatedContentMarks.id });
    if (!record) throw new Error('Generated content mark was not persisted');
    await transaction.insert(dataLineageEdges).values(buildLineageEdge({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      sourceType: 'MODEL_OUTPUT_HASH',
      sourceId: contentFingerprint(input.text),
      targetType: 'CONTENT_MARK',
      targetId: record.id,
      operation: 'CONTENT_MARKING',
      processorId: 'guardllm-content-marker',
      processorVersion: '1.0',
      attributes: {
        contentId: mark.metadata.contentId,
        modality: mark.metadata.modality,
        explicitMarkApplied: input.explicitMark,
      },
      createdAt,
    }));
  });
  return { markedText, mark, explicitMarkApplied: input.explicitMark };
}
