import { normalizePlatformRole } from './authorization';
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
  | { readonly success: true; readonly user: UserRecord }
  | { readonly success: false; readonly reason: 'INVALID_CREDENTIALS' | 'ACCOUNT_UNAVAILABLE' };

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

  const passwordPolicy = validatePasswordPolicy(input.password, [user.username, user.email ?? '']);
  const passwordHash = verification.needsRehash
    ? await hashPassword(input.password)
    : undefined;
  const updated = await recordSuccessfulLogin(user.id, {
    now,
    clientIp: input.clientIp,
    ...(passwordHash ? { passwordHash } : {}),
    mustChangePassword:
      Boolean(user.mustChangePassword) ||
      verification.legacyPlaintext ||
      !passwordPolicy.valid ||
      passwordExpired(user.passwordChangedAt, now),
  });
  return { success: true, user: updated };
}
