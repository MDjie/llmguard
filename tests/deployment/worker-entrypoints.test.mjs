import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('worker image entrypoint completeness',()=>{
  it('checks the runtime registry without starting any worker or database connection',()=>{
    const result=spawnSync(process.execPath,['scripts/run-worker.mjs','--check'],{encoding:'utf8',windowsHide:true});
    expect(result.status).toBe(0);
    const report=JSON.parse(result.stdout);
    expect(report.workers).toContain('iam');
    expect(report.workers.length).toBeGreaterThan(10);
    const dockerfile=readFileSync('Dockerfile','utf8');
    expect(dockerfile).toContain('RUN node scripts/run-worker.mjs --check');
    const source=readFileSync('scripts/run-worker.mjs','utf8');
    for(const match of source.matchAll(/:\s*'\.\/([^']+\.ts)'/g))expect(dockerfile).toContain('scripts/'+match[1]);
  });
  it('fails when the registry names a file missing from the packaged directory',()=>{
    const directory=mkdtempSync(join(tmpdir(),'guardllm-worker-check-'));
    try{
      copyFileSync('scripts/run-worker.mjs',join(directory,'run-worker.mjs'));
      const source=readFileSync('scripts/run-worker.mjs','utf8');
      for(const match of source.matchAll(/:\s*'\.\/([^']+\.ts)'/g)){
        if(match[1]!=='iam-worker.ts')writeFileSync(join(directory,match[1]),'throw new Error("must not execute")');
      }
      const result=spawnSync(process.execPath,[join(directory,'run-worker.mjs'),'--check'],{encoding:'utf8',windowsHide:true});
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('iam=./iam-worker.ts');
    }finally{
      if(dirname(resolve(directory))!==resolve(tmpdir()))throw new Error('Unexpected temporary directory');
      rmSync(directory,{recursive:true});
    }
  });
});
