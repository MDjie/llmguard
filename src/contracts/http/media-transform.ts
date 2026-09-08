import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(60000);
const interval = z.object({ startMs: time, endMs: time }).strict().refine(v => v.endMs > v.startMs, 'Empty time interval');
const region = z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)])
  .refine(v => v[2] > v[0] && v[3] > v[1], 'Empty mask region');
const evidence = z.string().min(1).max(128);
export const mediaTransformOperationSchema = z.discriminatedUnion('operation',[
  z.object({ operation:z.literal('MASK_REGION'), region, interval:interval.optional(), evidenceId:evidence }).strict(),
  z.object({ operation:z.literal('MUTE_INTERVAL'), interval, evidenceId:evidence }).strict(),
  z.object({ operation:z.literal('KEEP_INTERVAL'), interval, evidenceId:evidence }).strict(),
]);
export const mediaTransformPlanSchema = z.object({
  version:z.literal('media-transform-1'), sourceSha256:hash, decisionDigest:hash,
  kind:z.enum(['IMAGE','AUDIO','VIDEO']), operations:z.array(mediaTransformOperationSchema).min(1).max(64),
}).strict().superRefine((plan,ctx)=>{
  const crops=plan.operations.filter(op=>op.operation==='KEEP_INTERVAL');
  if(crops.length>1)ctx.addIssue({code:'custom',message:'Only one retained interval is supported'});
  for(const op of plan.operations){
    if(plan.kind==='IMAGE'&&(op.operation!=='MASK_REGION'||op.interval))ctx.addIssue({code:'custom',message:'Static images only accept untimed masks'});
    if(plan.kind==='AUDIO'&&op.operation==='MASK_REGION')ctx.addIssue({code:'custom',message:'Audio has no visual regions'});
    if(plan.kind==='VIDEO'&&op.operation==='MASK_REGION'&&!op.interval)ctx.addIssue({code:'custom',message:'Video masks require explicit time bounds'});
  }
});
export type MediaTransformPlan=z.infer<typeof mediaTransformPlanSchema>;
export const mediaTransformReceiptSchema=z.object({
  version:z.literal('media-transform-1'),planDigest:hash,sourceSha256:hash,derivedSha256:hash,
  mediaType:z.enum(['image/png','audio/wav','video/mp4']),sizeBytes:z.number().int().positive().max(1048576),
  transformerVersion:z.literal('guard-media-transform-1'),toolchainDigest:hash,
  sourceDurationMs:time,derivedDurationMs:time,sourceStartMs:time,
  width:z.number().int().nonnegative().max(2048),height:z.number().int().nonnegative().max(2048),
  audioTracks:z.number().int().min(0).max(1),videoTracks:z.number().int().min(0).max(1),
  decodeVerified:z.literal(true),semanticRecheckRequired:z.literal(true),
}).strict();
export type MediaTransformReceipt=z.infer<typeof mediaTransformReceiptSchema>;
