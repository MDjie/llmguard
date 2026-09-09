import { normalizePlatformRole } from './authorization';
import { eq } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { iamIdentityProfiles } from '@/lib/iam/schema';
import { isPrivilegedRole } from '@/lib/iam/policy';
import { resolveUserTenantScope } from '@/lib/tenancy/repository';
import { hashPassword, passwordExpired, validatePasswordPolicy, verifyStoredPassword } from './password';
import {
  findUserByUsername,
  recordLoginFailure,
  recordSuccessfulLogin,
  type UserRecord,
} from './repository';

const FAKE_PASSWORD_HASH = '$2b$12$LQv3c1yqBWXxW6j8w9y1E.0WQe6ncF8F5YwSP0g1QvJR5ACl9cJm6';

export interface LoginInput {
  readonly username: string;
  readonly password: string;
  readonly clientIp: string;
  readonly now?: Date;
}

export type LoginResult =
  | { readonly success: true; readonly user: UserRecord; readonly emergencyUntil: Date | null }
  | { readonly success: false; readonly reason: 'INVALID_CREDENTIALS' | 'ACCOUNT_UNAVAILABLE' | 'ENTERPRISE_OR_RECOVERY_LOGIN_REQUIRED' | 'ACCOUNT_SCOPE_UNAVAILABLE' };

function accountAvailable(user: UserRecord, now: Date): boolean {
  if (user.status !== 'active') {
    return false;
  }
  return !user.lockedUntil || user.lockedUntil.getTime() <= now.getTime();
}

export async function authenticateCredentials(input: LoginInput): Promise<LoginResult> {
  const now = input.now ?? new Date();
  const username = input.username.trim();
  const user = await findUserByUsername(username);

  if (!user) {
    await verifyStoredPassword(input.password, FAKE_PASSWORD_HASH);
    return { success: false, reason: 'INVALID_CREDENTIALS' };
  }

  if (!accountAvailable(user, now)) {
    await verifyStoredPassword(input.password, user.password);
    return { success: false, reason: 'ACCOUNT_UNAVAILABLE' };
  }

  const verification = await verifyStoredPassword(input.password, user.password);
  if (!verification.valid) {
    await recordLoginFailure(user.id, now);
    return { success: false, reason: 'INVALID_CREDENTIALS' };
  }

  const role = normalizePlatformRole(user.role);
  if (!role) {
    return { success: false, reason: 'ACCOUNT_UNAVAILABLE' };
  }

  const [identity] = await db.select().from(iamIdentityProfiles).where(eq(iamIdentityProfiles.userId, user.id));
  const emergency = identity?.loginMethod === 'emergency';
  if (!identity || identity.loginMethod === 'oidc' ||
    (emergency && (!identity.emergencyUntil || identity.emergencyUntil.getTime() <= now.getTime())) ||
    (!emergency && isPrivilegedRole(role) && process.env.IAM_ENTERPRISE_LOGIN_REQUIRED === 'true')) {
    return { success: false, reason: 'ENTERPRISE_OR_RECOVERY_LOGIN_REQUIRED' };
  }
  if (!(await resolveUserTenantScope(user.id))) {
    return { success: false, reason: 'ACCOUNT_SCOPE_UNAVAILABLE' };
  }

  const passwordPolicy = validatePasswordPolicy(input.password, [user.username, user.email ?? '']);
  const passwordHash = verification.needsRehash
    ? await hashPassword(input.password)
    : undefined;
  const updated = await recordSuccessfulLogin(user.id, {
    expectedTokenVersion:user.tokenVersion,
    now,
    clientIp: input.clientIp,
    ...(passwordHash ? { passwordHash } : {}),
    mustChangePassword:
      Boolean(user.mustChangePassword) ||
      verification.legacyPlaintext ||
      !passwordPolicy.valid ||
      passwordExpired(user.passwordChangedAt, now),
  });
  return { success: true, user: updated, emergencyUntil: emergency ? identity.emergencyUntil : null };
}
