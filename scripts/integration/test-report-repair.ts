import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadEnvConfig } from '@next/env';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and,eq,inArray } from 'drizzle-orm';
import { db,closeDatabaseConnection } from '../../src/storage/database/shared/db';
import { tenants,applications,detectionDimensions,testCases } from '../../src/storage/database/shared/schema';
import * as dimensions from '../../src/lib/dimensions/service';
import { createDimensionSchema,createRuleSchema,updateDimensionSchema,updateRuleSchema } from '../../src/contracts/http/dimensions';
import { inspectRuntime } from '../../src/lib/operations/inspection';
import { importSampleFile } from '../../src/lib/evaluation/sample-import-service';
async function main(){
  loadEnvConfig(process.cwd());
  const url=new URL(process.env.PGDATABASE_URL??process.env.DATABASE_URL??'');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Only a local test database is allowed');
  const tenantIds=[randomUUID(),randomUUID()],appIds=[randomUUID(),randomUUID()];
  const scopes=tenantIds.map((tenantId,index)=>({tenantId,applicationId:appIds[index],principalId:'report-repair-test'}));
  const checks:string[]=[];
  const check=async(name:string,run:()=>Promise<void>)=>{await run();checks.push(name);console.log('PASS '+name);};
  try{
    for(let i=0;i<scopes.length;i++){
      await db.insert(tenants).values({id:tenantIds[i],code:'repair-'+tenantIds[i],name:'报告修复回归临时租户'});
      await db.insert(applications).values({id:appIds[i],tenantId:tenantIds[i],code:'repair-test',name:'临时回归应用'});
    }
    const first=await dimensions.createDimension(scopes[0],createDimensionSchema.parse({code:'repair_dimension',name:'隐私测试',category:'privacy',weight:1.5,priority:7}));
    await dimensions.createDimension(scopes[1],createDimensionSchema.parse({code:'repair_dimension',name:'其他租户'}));
    await check('create, duplicate code and tenant-isolated ID/code lookup',async()=>{
      await assert.rejects(()=>dimensions.createDimension(scopes[0],createDimensionSchema.parse({code:'repair_dimension',name:'重复'})),{code:'DIMENSION_CODE_EXISTS'});
      assert.equal((await dimensions.dimensionDetail(scopes[0],'repair_dimension')).id,first.id);
      await assert.rejects(()=>dimensions.findDimension(scopes[1],first.id),{code:'DIMENSION_NOT_FOUND'});
    });
    await check('dimension toggle preserves category, weight and priority',async()=>{
      const result=await dimensions.updateDimension(scopes[0],first.id,updateDimensionSchema.parse({enabled:false}));
      assert.equal(result.enabled,false);assert.equal(result.category,'privacy');assert.equal(Number(result.weight),1.5);assert.equal(result.priority,7);
    });
    const rule=await dimensions.createRule(scopes[0],'repair_dimension',createRuleSchema.parse({name:'测试规则',type:'keyword',pattern:'hello',score:0,confidence:0,priority:0}));
    await check('rule zero values, update type, code addressing and independent toggle',async()=>{
      assert.equal(Number(rule.score),0);assert.equal(rule.priority,0);
      await dimensions.updateRule(scopes[0],first.id,rule.id,updateRuleSchema.parse({type:'regex',pattern:'\\D+',score:50}));
      const disabled=await dimensions.updateRule(scopes[0],'repair_dimension',rule.id,updateRuleSchema.parse({enabled:false}));
      assert.equal(disabled.pattern,'\\D+');assert.equal(disabled.priority,0);assert.equal(disabled.enabled,false);
      assert.equal((await dimensions.testDimension(scopes[0],'repair_dimension','ABC')).matchedCount,0);
      await dimensions.updateRule(scopes[0],first.id,rule.id,updateRuleSchema.parse({enabled:true}));
      assert.equal((await dimensions.testDimension(scopes[0],'repair_dimension','ABC')).matchedCount,1);
      assert.equal((await dimensions.testDimension(scopes[0],first.id,'123')).matchedCount,0);
      await assert.rejects(()=>dimensions.findRule(scopes[1],first.id,rule.id),{code:'DIMENSION_NOT_FOUND'});
    });
    await check('preview has no writes, invalid import is atomic, retries and concurrency deduplicate',async()=>{
      const body={fileName:'samples.jsonl',content:JSON.stringify({title:'导入样本',category:'prompt_injection',inputText:'sample marker',outputText:'answer marker',expectedAction:'block'}),preview:true};
      const preview=await importSampleFile(scopes[0],body);assert.equal(preview.status,200);
      assert.equal((await db.select().from(testCases).where(eq(testCases.tenantId,tenantIds[0]))).length,0);
      const invalid=await importSampleFile(scopes[0],{...body,content:body.content+'\ninvalid',preview:false});assert.equal(invalid.status,400);
      assert.equal((await db.select().from(testCases).where(eq(testCases.tenantId,tenantIds[0]))).length,0);
      const results=await Promise.all([importSampleFile(scopes[0],{...body,preview:false}),importSampleFile(scopes[0],{...body,preview:false})]);
      const payloads=await Promise.all(results.map(result=>result.json()));assert.equal(payloads.reduce((sum,payload)=>sum+payload.data.imported,0),1);
      const rows=await db.select().from(testCases).where(and(eq(testCases.tenantId,tenantIds[0]),eq(testCases.applicationId,appIds[0])));assert.equal(rows.length,1);assert.equal(rows[0].outputText,'answer marker');
      const other=await(await importSampleFile(scopes[1],{...body,preview:false})).json();assert.equal(other.data.imported,1);
    });
    await check('rule and dimension deletion do not affect another tenant',async()=>{
      await dimensions.deleteRule(scopes[0],'repair_dimension',rule.id);
      assert.equal((await dimensions.dimensionDetail(scopes[0],first.id)).rules.length,0);
      await dimensions.deleteDimension(scopes[0],first.id);
      assert.equal((await dimensions.listDimensions(scopes[0])).length,0);assert.equal((await dimensions.listDimensions(scopes[1])).length,1);
    });
    await check('runtime inspection uses local CPU, memory, filesystem and PostgreSQL',async()=>{
      const inspection=await inspectRuntime();
      assert.ok(inspection.cpu.count>0);assert.ok(inspection.memory.totalBytes>0);
      assert.equal(inspection.disk.status,'available');assert.ok(inspection.disk.totalBytes!==null&&inspection.disk.totalBytes>0);
      assert.equal(inspection.services.find(service=>service.name==='PostgreSQL')?.status,'healthy');
      assert.ok(inspection.cpu.usagePercent===null||(inspection.cpu.usagePercent>=0&&inspection.cpu.usagePercent<=100));
    });
  }finally{
    // Delete only the UUID-scoped temporary fixtures created above. No existing tenant rows are touched.
    await db.delete(testCases).where(inArray(testCases.tenantId,tenantIds));
    await db.delete(detectionDimensions).where(inArray(detectionDimensions.tenantId,tenantIds));
    await db.delete(applications).where(inArray(applications.id,appIds));
    await db.delete(tenants).where(inArray(tenants.id,tenantIds));
    await closeDatabaseConnection();
  }
    const directory=path.resolve('输出/测试报告/2026-09-08/report-repair-evidence');await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,'database-regression.json'),JSON.stringify({executedAt:new Date().toISOString(),database:'local PostgreSQL',checks,status:'PASS',syntheticScopesCleaned:true},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
