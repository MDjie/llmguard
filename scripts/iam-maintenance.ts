import { runIamMaintenance } from '../src/lib/iam/maintenance';
import { closeDatabaseConnection } from '../src/storage/database/shared/db';
runIamMaintenance().then(result=>console.log(JSON.stringify(result))).catch((error:unknown)=>{
  console.error(error instanceof Error?error.message:'IAM_MAINTENANCE_FAILED');process.exitCode=1;
}).finally(()=>closeDatabaseConnection());
