import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { nativeAssessmentSchema, nativeBindingSchema } from '../../../src/contracts/http/native-multimodal';
import { nativeBindingDigest } from '../../../src/lib/multimodal/native-gate';
import { withLoadedArtifact } from './artifact-loader';
import { documentImageRequestSchema } from './contracts';
import type { CommandRunner } from './command-runner';
const artifactSchema = documentImageRequestSchema.shape.artifact.extend({ kind: z.enum(['IMAGE','DOCUMENT','AUDIO','VIDEO']) });
export const nativeJointRequestSchema = z.object({ contractVersion: z.literal('1.0'), binding: nativeBindingSchema,
  contextText: z.string().max(131072), artifacts: z.array(artifactSchema).min(1).max(8),
}).strict();
export async function analyzeNativeJoint(raw: unknown, runner: CommandRunner, signal?: AbortSignal) {
  const request = nativeJointRequestSchema.parse(raw), program = process.env.ANALYZER_NATIVE_JOINT_COMMAND;
  if (!program) throw new Error('ANALYZER_NATIVE_JOINT_COMMAND_REQUIRED');
  if (createHash('sha256').update(request.contextText).digest('hex') !== request.binding.contextDigest) throw new Error('ANALYZER_NATIVE_CONTEXT_MISMATCH');
  const nativeSources = request.binding.sources.filter(source => source.modality !== 'TEXT');
  if (nativeSources.length !== request.artifacts.length || new Set(request.artifacts.map(item => item.id)).size !== request.artifacts.length ||
    nativeSources.some((source, index) => { const item=request.artifacts[index]; return item.id !== source.artifactId || item.sha256 !== source.sha256 || item.kind !== source.modality; })) throw new Error('ANALYZER_NATIVE_SOURCE_MISMATCH');
  const textSources = request.binding.sources.filter(source => source.modality === 'TEXT');
  if (textSources.length > 1 || textSources.some(source => source.sha256 !== request.binding.contextDigest)) throw new Error('ANALYZER_NATIVE_TEXT_SOURCE_MISMATCH');
  if (request.artifacts.reduce((sum,item)=>sum+item.sizeBytes,0)>256*1048576) throw new Error('ANALYZER_NATIVE_BYTE_LIMIT');
  const files: Array<{sourceId:string;path:string;sha256:string;modality:string}> = [];
  // Nested lifetimes retain every verified original until the joint command finishes, then remove each owned workspace.
  async function load(index: number): Promise<z.infer<typeof nativeAssessmentSchema>> {
    return withLoadedArtifact(request.artifacts[index], async (file,workspace) => {
      files.push({sourceId:nativeSources[index].sourceId,path:file,sha256:nativeSources[index].sha256,modality:nativeSources[index].modality});
      if(index+1<request.artifacts.length)return load(index+1);
      const manifest=join(workspace,'native-joint-request.json'), bindingDigest=nativeBindingDigest(request.binding);
      await writeFile(manifest, JSON.stringify({contractVersion:'1.0',binding:request.binding,bindingDigest,contextText:request.contextText,sourceTrust:'UNTRUSTED',instructionCapability:'FORBIDDEN',files}), {mode:0o600});
      const result=await runner.run(program!,['--manifest',manifest,'--output-format','json'],{cwd:workspace,timeoutMs:120000,maxOutputBytes:1048576,signal});
      let data:unknown;try{data=JSON.parse(result.stdout);}catch{throw new Error('ANALYZER_NATIVE_JSON_INVALID');}
      const assessment=nativeAssessmentSchema.parse(data);
      if(assessment.bindingDigest!==bindingDigest)throw new Error('ANALYZER_NATIVE_RESULT_BINDING_MISMATCH');
      return assessment;
    },signal);
  }
  return load(0);
}
