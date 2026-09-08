import { z } from 'zod';

export const gatewayActionSchema = z.enum(['ALLOW','WARN','BLOCK','MASK','REWRITE','SAFE_RESPONSE','REQUIRE_REVIEW']);
export const gatewayChatResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    provider: z.object({ id: z.string(), name: z.string(), displayName: z.string(), model: z.string().nullable() }),
    response: z.string(), latencyMs: z.number().int().nonnegative(),
    gateway: z.object({ requestId: z.string(), snapshotId: z.string(), inputAction: gatewayActionSchema, outputAction: gatewayActionSchema, decisionId: z.string() }),
  }),
});
export const gatewayChatProvidersSchema = z.object({ success: z.literal(true), data: z.array(z.object({ id: z.string(), displayName: z.string(), defaultModel: z.string().nullable(), isDefaultTarget: z.boolean() })) });
export type GatewayChatResult = z.infer<typeof gatewayChatResponseSchema>['data'];

export const chatArtifactReferenceSchema=z.object({artifactId:z.string().uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),jobId:z.string().uuid().optional()}).strict();
export const chatArtifactReferencesSchema=z.array(chatArtifactReferenceSchema).min(1).max(8).refine(values=>new Set(values.map(value=>value.artifactId)).size===values.length);
export const consoleMessageSchema=z.object({role:z.enum(['system','user','assistant']),content:z.string().min(1).max(32768)}).strict();
export type ChatArtifactReference=z.infer<typeof chatArtifactReferenceSchema>;
