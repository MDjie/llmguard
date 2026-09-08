import { z } from 'zod';
export const agentLogSchema = z.object({ id: z.string(), recordId: z.string().nullable(), providerId: z.string().nullable(), workflowName: z.string().nullable(), latencyMs: z.number().nullable(), success: z.boolean().nullable(), createdAt: z.string().datetime({ offset: true }) });
export const agentLogsResponseSchema = z.object({ success: z.literal(true), data: z.object({ items: z.array(agentLogSchema), total: z.number().int(), page: z.number().int(), pageSize: z.number().int(), totalPages: z.number().int() }) });
export type AgentLog = z.infer<typeof agentLogSchema>;
