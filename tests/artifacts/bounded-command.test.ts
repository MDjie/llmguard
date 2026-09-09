import {describe,it,expect} from 'vitest';
import {runBoundedCommand} from '../../scripts/integration/comprehensive/bounded-command.mjs';
describe('comprehensive command deadlines',()=>{
 it('returns the actual exit code',async()=>{
  expect(await runBoundedCommand(process.execPath,['-e','process.exit(2)'],{stdio:'ignore',timeoutMs:5000})).toMatchObject({exitCode:2,timedOut:false});
 });
 it('terminates its own stalled process and records timeout',async()=>{
  const result=await runBoundedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',timeoutMs:500});
  expect(result).toMatchObject({exitCode:124,timedOut:true});expect(result.elapsedMs).toBeLessThan(6500);
 });
 it('rejects invalid deadlines and resolves launch failures',async()=>{
  await expect(runBoundedCommand('missing-command',[],{timeoutMs:0})).rejects.toThrow('DEADLINE');
  expect(await runBoundedCommand('guardllm-command-that-does-not-exist',[],{stdio:'ignore',timeoutMs:5000})).toMatchObject({exitCode:1,timedOut:false});
 });
});
