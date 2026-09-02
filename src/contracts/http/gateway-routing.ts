import { z } from 'zod';

export const updateGatewayRoutingSchema = z.object({
  action: z.enum(['advance', 'rollback']),
  mode: z.enum(['legacy', 'shadow', 'canary', 'enforcing']).optional(),
  guardPercent: z.union([z.literal(0), z.literal(1), z.literal(5), z.literal(25), z.literal(100)]).optional(),
  gate: z.object({
    errorBudgetHealthy: z.boolean(),
    falseNegativeRate: z.number().min(0).max(1),
    p99LatencyMs: z.number().nonnegative(),
    maxFalseNegativeRate: z.number().min(0).max(1),
    maxP99LatencyMs: z.number().positive(),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'advance' && (!value.mode || value.guardPercent === undefined || !value.gate)) {
    context.addIssue({ code: 'custom', message: 'mode, guardPercent and gate are required for advance' });
  }
  if (value.action === 'rollback' && (value.mode || value.guardPercent !== undefined || value.gate)) {
    context.addIssue({ code: 'custom', message: 'rollback does not accept target or gate fields' });
  }
});
