import { describe,it,expect,vi } from 'vitest';
import { inspectOwnedContainer,withPausedContainer,parseMemoryBytes,resiliencePlanSchema,type DockerCommand } from '../../scripts/acceptance/runtime-resilience';
const id='a'.repeat(64),run='test-run';
function fake(){let paused=false;const command: DockerCommand=vi.fn(async args=>{
 if(args[0]==='inspect')return JSON.stringify(id)+' '+JSON.stringify({'io.guardllm.acceptance.run':run})+' true '+paused;
 if(args[0]==='pause'){paused=true;return id;}if(args[0]==='unpause'){paused=false;return id;}throw new Error('unsupported');
});return {command,isPaused:()=>paused};}
describe('owned acceptance faults',()=>{
 it('rejects unlabeled or substituted containers before any fault',async()=>{
  await expect(inspectOwnedContainer(id,run,async()=>JSON.stringify(id)+' {} true false')).rejects.toThrow('NOT_OWNED');
  await expect(inspectOwnedContainer(id,run,async()=>JSON.stringify('b'.repeat(64))+' {} true false')).rejects.toThrow('IDENTITY_INVALID');
 });
 it('restores the exact container when work fails or is cancelled',async()=>{
  const f=fake();await expect(withPausedContainer(id,run,async()=>{expect(f.isPaused()).toBe(true);throw new Error('cancel');},f.command)).rejects.toThrow('cancel');expect(f.isPaused()).toBe(false);
 });
 it('restores a pause whose acknowledgement was lost',async()=>{
  const f=fake();const command:DockerCommand=async args=>{const result=await f.command(args);if(args[0]==='pause')throw new Error('lost ACK');return result;};
  await expect(withPausedContainer(id,run,async()=>{},command)).rejects.toThrow('lost ACK');expect(f.isPaused()).toBe(false);
 });
 it('rejects overlapping faults and parses explicit memory units',()=>{
  expect(parseMemoryBytes('2 MiB')).toBe(2097152);expect(parseMemoryBytes('2 MB')).toBe(2000000);expect(()=>parseMemoryBytes('NaN MB')).toThrow();
  expect(()=>resiliencePlanSchema.parse({version:'resilience-plan-1',runId:run,seconds:20,sampleIntervalMs:1000,containers:[id],
   faults:[{containerId:id,atMs:1000,durationMs:3000,kind:'PAUSE'},{containerId:id,atMs:2000,durationMs:1000,kind:'PAUSE'}]})).toThrow();
 });
});
