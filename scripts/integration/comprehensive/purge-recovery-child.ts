import {writeFileSync} from 'node:fs';
import {purgeNextArtifact} from '@/lib/artifacts/purge';
import {S3ArtifactVersionStore} from '@/lib/artifacts/version-store';
import {closeDatabaseConnection} from '@/storage/database/shared/db';
async function main(){
 const url=new URL(process.env.DATABASE_URL!);
 if(url.hostname!=='127.0.0.1'||url.port!=='5438'||!/^\/guardllm_integration_full_\d+$/.test(url.pathname))throw new Error('ISOLATION_REQUIRED');
 const [mode,output]=process.argv.slice(2);if(!['crash-after-delete','resume'].includes(mode)||!output)throw new Error('MODE_INVALID');
 const store=new S3ArtifactVersionStore();
 const result=await purgeNextArtifact(mode==='crash-after-delete'?{list:store.list.bind(store),remove:async(version,signal)=>{
   await store.remove(version,signal);writeFileSync(output,JSON.stringify({crashedAfterVersionDelete:true}));process.exit(73);
 }}:store);
 writeFileSync(output,JSON.stringify({result}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'FAILED');process.exitCode=1;}).finally(closeDatabaseConnection);
