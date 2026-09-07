import { parseArgs } from 'node:util';
import { backfillSecurityAlerts, alertBackfillSchema } from '../../src/lib/security-alerts/backfill';
import { closeDatabaseConnection } from '../../src/storage/database/shared/db';
const {values}=parseArgs({options:{tenant:{type:'string'},application:{type:'string'},source:{type:'string'},from:{type:'string'},watermark:{type:'string'},after:{type:'string'},apply:{type:'boolean',default:false}}});
async function main(){try{if(!values.tenant||!values.application)throw new Error('EXPLICIT_SCOPE_REQUIRED');const input=alertBackfillSchema.parse({source:values.source,from:values.from,watermark:values.watermark,afterId:values.after,apply:values.apply});console.log(JSON.stringify(await backfillSecurityAlerts({tenantId:values.tenant,applicationId:values.application},input)));}finally{await closeDatabaseConnection();}}
main().catch(error=>{console.error(error instanceof Error?error.message:'BACKFILL_FAILED');process.exitCode=1;});
