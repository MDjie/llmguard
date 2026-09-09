import postgres from 'postgres';
import { iamDeploymentMode,requiredAdministrativeRoles } from '../src/lib/iam/deployment-mode';
async function main(){
  const mode=iamDeploymentMode();
  const url=process.env.PGDATABASE_URL??process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit PGDATABASE_URL is required');
  const client=postgres(url,{max:1});
  try{
    const anomalies=await client`
      SELECT 'INVALID_DEFAULT_SCOPE' AS issue,m.user_id AS id
      FROM tenant_memberships m JOIN users u ON u.id=m.user_id
      LEFT JOIN applications a ON a.id=m.default_application_id AND a.tenant_id=m.tenant_id
      LEFT JOIN tenants t ON t.id=m.tenant_id
      WHERE u.status='active' AND m.status='active' AND
        (a.id IS NULL OR a.status<>'active' OR t.status<>'active' OR
        a.environment NOT IN ('development','test','staging','production') OR
        a.data_class NOT IN ('public','internal','confidential','restricted'))
      UNION ALL SELECT 'MISSING_MEMBERSHIP',u.id FROM users u
      WHERE u.status='active' AND NOT EXISTS(SELECT 1 FROM tenant_memberships m WHERE m.user_id=u.id AND m.status='active')
      UNION ALL SELECT 'UNKNOWN_ROLE',id FROM users WHERE role NOT IN
        ('admin','user','system_admin','security_admin','audit_admin','business_operator','app_developer','read_only',
         'SYSTEM_ADMIN','SECURITY_ADMIN','AUDIT_ADMIN','BUSINESS_OPERATOR','APP_DEVELOPER','READ_ONLY')
    `;
    const roles=await client`SELECT m.tenant_id,upper(CASE u.role WHEN 'admin' THEN 'SYSTEM_ADMIN' WHEN 'user' THEN 'BUSINESS_OPERATOR' ELSE u.role END) role,count(*)::int count
      FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE u.status='active' AND m.status='active' GROUP BY m.tenant_id,2`;
    const tenants=await client`SELECT id FROM tenants WHERE status='active'`;
    const missing=tenants.flatMap(tenant=>['SYSTEM_ADMIN','SECURITY_ADMIN','AUDIT_ADMIN'].filter(role=>
      !roles.some(row=>row.tenant_id===tenant.id&&row.role===role)).map(role=>({tenantId:tenant.id,role})));
    const blockingMissing=missing.filter(item=>requiredAdministrativeRoles(mode).includes(item.role));
    const blocked=anomalies.length>0||blockingMissing.length>0;
    console.log(JSON.stringify({status:blocked?'ACTION_REQUIRED':'PASS',deploymentMode:mode,anomalies,missingAdministrativeRoles:missing,
      blockingMissingAdministrativeRoles:blockingMissing,
      warnings:mode==='implementation'?['Implementation mode permits one SYSTEM_ADMIN; security/audit roles are optional for testing.']:[],
      backfillPolicy:'only existing default application; no expansion',migration:'0073 then 0074; existing databases require explicit migration'},null,2));
    if(blocked)process.exitCode=2;
  }finally{await client.end();}
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'PREFLIGHT_FAILED');process.exitCode=1;});
