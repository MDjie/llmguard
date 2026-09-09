import { runIamMaintenance } from '../src/lib/iam/maintenance';
import { closeDatabaseConnection } from '../src/storage/database/shared/db';
let stopping=false;
let wake:(()=>void)|undefined;
function stop(){stopping=true;wake?.();}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
async function main(){
  do{
    try{console.log(JSON.stringify({event:'iam.maintenance',...await runIamMaintenance()}));}
    catch(error:unknown){console.error(JSON.stringify({event:'iam.maintenance.failed',type:error instanceof Error?error.name:'unknown'}));}
    if(!stopping)await new Promise<void>(resolve=>{const timer=setTimeout(resolve,60000);wake=()=>{clearTimeout(timer);resolve();};});
  }while(!stopping);
}
main().finally(()=>closeDatabaseConnection());
