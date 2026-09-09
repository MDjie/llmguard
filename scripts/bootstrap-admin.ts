import { randomUUID } from 'node:crypto';
import { and,eq,inArray,sql } from 'drizzle-orm';
import { z } from 'zod';

async function main(){
  if(!process.env.PGDATABASE_URL&&!process.env.DATABASE_URL)throw new Error('Explicit PGDATABASE_URL or DATABASE_URL is required');
  const {db,closeDatabaseConnection}=await import('../src/storage/database/shared/db');
  try{
    const {users,tenants,applications,tenantMemberships,passwordHistory}=await import('../src/storage/database/shared/schema');
    const {iamIdentityProfiles,userApplicationMemberships}=await import('../src/lib/iam/schema');
    const {hashPassword,validatePasswordPolicy}=await import('../src/lib/auth/password');
    const {auditIam}=await import('../src/lib/iam/management');
    const role=z.enum(['SYSTEM_ADMIN','SECURITY_ADMIN','AUDIT_ADMIN']).parse(process.env.BOOTSTRAP_ADMIN_ROLE??'SYSTEM_ADMIN');
    const username=z.string().regex(/^[A-Za-z0-9._-]{3,50}$/).parse(process.env.BOOTSTRAP_ADMIN_USERNAME);
    const password=process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if(!password||!validatePasswordPolicy(password,[username]).valid)throw new Error('A strong BOOTSTRAP_ADMIN_PASSWORD is required');
    const reason=z.string().min(10).max(1000).parse(process.env.BOOTSTRAP_IAM_REASON);
    const passwordHash=await hashPassword(password);
    const roleAliases=role==='SYSTEM_ADMIN'?['SYSTEM_ADMIN','system_admin','admin']:[role,role.toLowerCase()];
    const userId=randomUUID();
    await db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('iam:bootstrap',0))`);
      const [scope]=await tx.select({tenantId:tenants.id,applicationId:applications.id,environment:applications.environment,dataClass:applications.dataClass})
        .from(tenants).innerJoin(applications,eq(applications.tenantId,tenants.id)).where(and(
          eq(tenants.code,process.env.BOOTSTRAP_TENANT_CODE??'legacy'),eq(applications.code,process.env.BOOTSTRAP_APPLICATION_CODE??'default'),
          eq(tenants.status,'active'),eq(applications.status,'active'))).for('share');
      if(!scope)throw new Error('Active bootstrap scope not found');
      const [existing]=await tx.select({id:users.id}).from(users).innerJoin(tenantMemberships,eq(users.id,tenantMemberships.userId))
        .where(and(eq(tenantMemberships.tenantId,scope.tenantId),eq(tenantMemberships.status,'active'),eq(users.status,'active'),inArray(users.role,roleAliases))).limit(1);
      if(existing)throw new Error('This tenant already has this administrative role; use authenticated independent approval');
      const [duplicate]=await tx.select({id:users.id}).from(users).where(eq(users.username,username));
      if(duplicate)throw new Error('Username already exists; bootstrap never overwrites an account');
      await tx.insert(users).values({id:userId,username,nickname:username,password:passwordHash,role,status:'active',mustChangePassword:true,passwordChangedAt:new Date(),createdBy:'iam-bootstrap'});
      await tx.insert(tenantMemberships).values({tenantId:scope.tenantId,defaultApplicationId:scope.applicationId,userId,status:'active'});
      await tx.insert(userApplicationMemberships).values({tenantId:scope.tenantId,applicationId:scope.applicationId,userId,
        attributes:{allowedEnvironments:[z.enum(['development','test','staging','production']).parse(scope.environment)],
          maxDataClass:z.enum(['public','internal','confidential','restricted']).parse(scope.dataClass),userGroupIds:[]},grantedBy:'iam-bootstrap'});
      await tx.insert(iamIdentityProfiles).values({userId,loginMethod:'local'});
      await tx.insert(passwordHistory).values({userId,passwordHash});
      await auditIam(tx,{...scope,principalId:'iam-bootstrap'},'iam.bootstrap.created',userId,{role,reason,mustChangePassword:true});
    });
    console.log(JSON.stringify({status:'created',role,userId,mustChangePassword:true}));
  }finally{await closeDatabaseConnection();}
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'IAM_BOOTSTRAP_FAILED');process.exitCode=1;});
