import { sql, and, inArray } from 'drizzle-orm';
import { type TenantContext, scopePredicate } from '@/lib/tenancy';
import { db } from '@/storage/database/shared/db';
import { testCases } from '@/storage/database/shared/schema';
import { importSamplesSchema, parseSampleImport, sampleIdentity } from '@/lib/evaluation/sample-import';

import type { z } from 'zod';

export async function importSampleFile(scope:TenantContext,body:z.infer<typeof importSamplesSchema>):Promise<Response> {
  const parsed=parseSampleImport(body.fileName,body.content);
  if(parsed.errors.length)return Response.json({success:false,detail:'文件校验失败，未写入任何样本',data:{errors:parsed.errors,validCount:parsed.rows.length,duplicates:parsed.duplicates,imported:0}},{status:400});
  return db.transaction(async tx=>{
    // Serialize imports in one tenant/application; concurrent retries cannot insert duplicates.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId+':'+scope.applicationId+':sample-import'}))`);
    const existing=await tx.select({id:testCases.id,inputText:testCases.inputText,outputText:testCases.outputText,category:testCases.category,expectedAction:testCases.expectedAction}).from(testCases).where(and(scopePredicate(testCases,scope),inArray(testCases.inputText,parsed.rows.map(row=>row.sample.inputText))));
    const known=new Set(existing.map(sampleIdentity));
    const fresh=parsed.rows.filter(row=>!known.has(sampleIdentity(row.sample)));
    const duplicates=parsed.duplicates+parsed.rows.length-fresh.length;
    if(body.preview)return Response.json({success:true,data:{preview:true,validCount:fresh.length,duplicates,errors:[],samples:fresh.slice(0,10).map(row=>({line:row.line,title:row.sample.title,inputText:row.sample.inputText.slice(0,300),outputText:row.sample.outputText?.slice(0,300)??null})),imported:0}});
    const ids:string[]=[];
    for(let offset=0;offset<fresh.length;offset+=100){
      const inserted=await tx.insert(testCases).values(fresh.slice(offset,offset+100).map(({sample})=>({...sample,tenantId:scope.tenantId,applicationId:scope.applicationId,expectedScoreMin:sample.expectedScoreMin===undefined?null:String(sample.expectedScoreMin),expectedScoreMax:sample.expectedScoreMax===undefined?null:String(sample.expectedScoreMax)}))).returning({id:testCases.id});
      ids.push(...inserted.map(row=>row.id));
    }
    return Response.json({success:true,data:{preview:false,imported:ids.length,duplicates,testCaseIds:ids,errors:[]}});
  });
}
