import { and,eq,lt,lte,sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { users,tenantMemberships } from '@/storage/database/shared/schema';
import { iamIdentityProfiles,iamChangeRequests,iamOidcExchanges,providerApprovalRequests } from './schema';
import { auditIam } from './management';
export async function runIamMaintenance(){
  let expired=0;
  await db.transaction(async tx=>{
    const profiles=await tx.select().from(iamIdentityProfiles).where(and(eq(iamIdentityProfiles.loginMethod,'emergency'),lte(iamIdentityProfiles.emergencyUntil,new Date()))).for('update');
    for(const profile of profiles){
      const [user]=await tx.update(users).set({status:'disabled',tokenVersion:sql`${users.tokenVersion}+1`,updatedAt:new Date()}).where(and(eq(users.id,profile.userId),eq(users.status,'active'))).returning();
      await tx.update(iamIdentityProfiles).set({emergencyUntil:null,updatedAt:new Date()}).where(eq(iamIdentityProfiles.userId,profile.userId));
      if(!user)continue;
      const scopes=await tx.select().from(tenantMemberships).where(eq(tenantMemberships.userId,profile.userId));
      for(const scope of scopes)await auditIam(tx,{principalId:'iam-maintenance',tenantId:scope.tenantId,applicationId:scope.defaultApplicationId},'iam.emergency.expired',user.id,{automaticDisable:true});
      expired++;
    }
    await tx.update(iamChangeRequests).set({status:'expired',decidedAt:new Date()}).where(and(eq(iamChangeRequests.status,'pending'),lt(iamChangeRequests.expiresAt,new Date())));
    await tx.update(providerApprovalRequests).set({status:'expired',decidedAt:new Date()}).where(and(eq(providerApprovalRequests.status,'pending'),lt(providerApprovalRequests.expiresAt,new Date())));
    await tx.delete(iamOidcExchanges).where(lt(iamOidcExchanges.expiresAt,new Date()));
  });
  return {expiredEmergencyAccounts:expired};
}
