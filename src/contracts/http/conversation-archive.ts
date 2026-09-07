import { z } from 'zod';
import { signedAuthContextSchema } from './gateway-v2';
const id = z.string().min(1).max(128);
export const archivePurposeSchema = z.enum(['RECEIVED_INPUT', 'MODEL_INPUT', 'MODEL_OUTPUT', 'RELEASED_OUTPUT']);
export type ArchivePurpose = z.infer<typeof archivePurposeSchema>;
export const archiveObjectStateSchema = z.enum(['PENDING', 'OBJECT_WRITTEN', 'MANIFEST_COMMITTED', 'INDEXED', 'DELETE_PENDING', 'DELETED']);
export const archiveRepresentationSchema = z.enum(['REQUEST_JSON', 'MODEL_RESPONSE_JSON', 'SSE_EVENT', 'CONTENT_SEGMENTS', 'MEDIA_BYTES']);
export const archiveObjectReferenceSchema = z.object({
  id, purpose: archivePurposeSchema, sequence: z.number().int().nonnegative(), representation: archiveRepresentationSchema,
  state: archiveObjectStateSchema, sourceHmac: z.string().regex(/^[a-f0-9]{64}$/), ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(), objectKey: z.string().min(1).max(1024), objectVersion: z.string().min(1).max(1024).nullable(), keyIds: z.array(id).min(1).max(32),
  sourceStepId: id.nullable(), eventSequence: z.number().int().nonnegative().nullable(), rangeStart: z.number().int().nonnegative().nullable(), rangeEnd: z.number().int().nonnegative().nullable(),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), verificationError: id.nullable().optional(),
}).strict();
export type ArchiveObjectReference = z.infer<typeof archiveObjectReferenceSchema>;
export const archivePolicySchema = z.object({ mode: z.enum(['DISABLED', 'STRICT_OBJECT']), retentionDays: z.literal(180), version: z.literal('archive-policy-1') }).strict();
export type ArchivePolicy = z.infer<typeof archivePolicySchema>;
export const archiveQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(180).default(180), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), cursor: z.string().max(4096).optional(),
  requestId: id.optional(), sessionId: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict();

export const gatewayArchiveWriteSchema = z.object({ contractVersion: z.literal('2.0'), auth: signedAuthContextSchema,
  purpose: z.enum(['MODEL_INPUT','MODEL_OUTPUT','RELEASED_OUTPUT']), sequence: z.number().int().min(0).max(100000),
  representation: z.enum(['REQUEST_JSON','MODEL_RESPONSE_JSON','SSE_EVENT']), contentJson: z.string().min(1).max(4194304),
  sourceStepId: id.optional(), eventSequence: z.number().int().min(1).max(100000).optional(), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  rangeStart: z.number().int().nonnegative().optional(), rangeEnd: z.number().int().nonnegative().optional(),
}).strict();
export const gatewayArchiveCompleteSchema = z.object({ contractVersion: z.literal('2.0'), auth: signedAuthContextSchema, finalSequence: z.number().int().min(0).max(100000) }).strict();

export const archiveRequestViewSchema = z.object({ requestId: id, conversationId: id, subjectId: id, state: z.string(), acceptedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), holdUntil: z.iso.datetime().nullable(),
  integrity: z.record(z.string(), z.unknown()), modelOutputFinalSequence: z.number().nullable(), modelOutputUnavailableReason: z.string().nullable() }).strict();
export const archiveMessageViewSchema = z.object({ id, requestId: id, purpose: archivePurposeSchema, sequence: z.number().int(), representation: archiveRepresentationSchema, state: archiveObjectStateSchema,
  sourceDigest: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), sourceStepId: id.nullable(), eventSequence: z.number().nullable(), rangeStart: z.number().nullable(), rangeEnd: z.number().nullable(), rawAccess: z.literal('APPROVAL_REQUIRED') }).strict();
const pageFields = { nextCursor: z.string().nullable(), hasMore: z.boolean(), watermark: z.iso.datetime(), from: z.iso.datetime(), to: z.iso.datetime() };
export const archiveListSchema = z.object({ items: z.array(archiveRequestViewSchema), ...pageFields }).strict();
export const archiveMessagesSchema = z.object({ items: z.array(archiveMessageViewSchema), ...pageFields }).strict();
export type ArchiveList = z.infer<typeof archiveListSchema>;
export type ArchiveMessages = z.infer<typeof archiveMessagesSchema>;
