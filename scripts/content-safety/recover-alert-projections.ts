import { parseArgs } from 'node:util';
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());
const {values}=parseArgs({options:{tenant:{type:'string'},application:{type:'string'},after:{type:'string'},retry:{type:'string'},actor:{type:'string'},reason:{type:'string'}}});
async function main(){
 if(!values.tenant||!values.application)throw new Error('EXPLICIT_SCOPE_REQUIRED');
 const [{listFailedAlertProjections,retryFailedAlertProjection},{closeDatabaseConnection}]=await Promise.all([import('../../src/lib/security-alerts/recovery'),import('../../src/storage/database/shared/db')]);
 try{const scope={tenantId:values.tenant,applicationId:values.application};
  if(values.retry){if(!values.actor||!values.reason)throw new Error('RETRY_ACTOR_AND_REASON_REQUIRED');console.log(JSON.stringify(await retryFailedAlertProjection({...scope,principalId:values.actor},values.retry,values.reason)));}
  else console.log(JSON.stringify(await listFailedAlertProjections(scope,values.after)));
 }finally{await closeDatabaseConnection();}
}
main().catch(()=>{console.error('ALERT_PROJECTION_RECOVERY_FAILED');process.exitCode=1;});
