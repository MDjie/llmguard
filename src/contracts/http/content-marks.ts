import { z } from 'zod';

export const markTextRequestSchema = z.object({
  text: z.string().trim().min(1).max(1_000_000),
  explicitMark: z.boolean().default(true),
  exemption: z.object({
    agreementVersion: z.string().trim().min(1).max(64),
    purpose: z.string().trim().min(1).max(500),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (!value.explicitMark && !value.exemption) {
    context.addIssue({ code: 'custom', path: ['exemption'], message: 'exemption is required when explicitMark is false' });
  }
});

export const contentMetadataSchema = z.object({
  schemaVersion: z.literal('1.0'),
  standard: z.literal('GB 45438-2025'),
  generatedContent: z.literal(true),
  modality: z.enum(['text', 'image', 'audio', 'video', 'virtual_scene']),
  serviceProvider: z.string().min(1).max(128),
  contentId: z.uuid(),
  createdAt: z.iso.datetime(),
});

export const markTextResponseSchema = z.object({
  markedText: z.string(),
  explicitMarkApplied: z.boolean(),
  mark: z.object({
    metadata: contentMetadataSchema,
    signature: z.string().min(43).max(44),
    keyId: z.string().min(1).max(64),
  }),
});

export const verifyContentMarkRequestSchema = z.object({
  metadata: contentMetadataSchema,
  signature: z.string().min(43).max(44),
  keyId: z.string().min(1).max(64),
}).strict();

export const verifyContentMarkResponseSchema = z.object({
  valid: z.boolean(),
  contentId: z.uuid(),
  standard: z.literal('GB 45438-2025'),
});
