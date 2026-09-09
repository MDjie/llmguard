import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { passwordHistory, users } from '@/storage/database/shared/schema';
import { LOGIN_FAILURE_THRESHOLD, LOGIN_LOCK_DURATION_MS, PASSWORD_HISTORY_DEPTH } from './constants';
import { ApiProblem } from '@/lib/api-security/problem';

export type UserRecord = typeof users.$inferSelect;

export interface LoginFailureState {
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
}

export interface SuccessfulLoginUpdate {
  readonly expectedTokenVersion: number;
  readonly now: Date;
  readonly clientIp: string;
  readonly passwordHash?: string;
  readonly mustChangePassword: boolean;
}

export async function findUserByUsername(username: string): Promise<UserRecord | null> {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return user ?? null;
}

export async function findUserById(id: string): Promise<UserRecord | null> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return user ?? null;
}

export async function listRecentPasswordHashes(
  userId: string,
  depth = PASSWORD_HISTORY_DEPTH,
): Promise<readonly string[]> {
  if (!Number.isInteger(depth) || depth < 1 || depth > 24) {
    throw new RangeError('Password history depth must be between 1 and 24');
  }
  const rows = await db
    .select({ passwordHash: passwordHistory.passwordHash })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.createdAt))
    .limit(depth);
  return rows.map((row) => row.passwordHash);
}

export async function updateOwnProfile(
  userId: string,
  values: {
    readonly nickname?: string | null;
    readonly email?: string | null;
    readonly phone?: string | null;
    readonly department?: string | null;
  },
  now: Date,
): Promise<UserRecord | null> {
  const [user] = await db
    .update(users)
    .set({ ...values, updatedAt: now })
    .where(eq(users.id, userId))
    .returning();
  return user ?? null;
}

export function nextLoginFailureState(
  currentCount: number | null,
  now: Date,
): LoginFailureState {
  const failedLoginCount = (currentCount ?? 0) + 1;
  return {
    failedLoginCount,
    lockedUntil:
      failedLoginCount >= LOGIN_FAILURE_THRESHOLD
        ? new Date(now.getTime() + LOGIN_LOCK_DURATION_MS)
        : null,
  };
}

export async function recordLoginFailure(userId: string, now: Date): Promise<LoginFailureState> {
  return db.transaction(async (transaction) => {
    const [current] = await transaction
      .select({ failedLoginCount: users.failedLoginCount })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');

    const state = nextLoginFailureState(current?.failedLoginCount ?? 0, now);
    await transaction
      .update(users)
      .set({
        failedLoginCount: state.failedLoginCount,
        ...(state.lockedUntil ? { lockedUntil: state.lockedUntil } : {}),
        updatedAt: now,
      })
      .where(eq(users.id, userId));
    return state;
  });
}

export async function recordSuccessfulLogin(
  userId: string,
  update: SuccessfulLoginUpdate,
): Promise<UserRecord> {
  const [user] = await db
    .update(users)
    .set({
      lastLoginAt: update.now,
      lastLoginIp: update.clientIp,
      loginCount: sql`coalesce(${users.loginCount}, 0) + 1`,
      failedLoginCount: 0,
      lockedUntil: null,
      mustChangePassword: update.mustChangePassword,
      ...(update.passwordHash
        ? { password: update.passwordHash, passwordChangedAt: update.now }
        : {}),
      updatedAt: update.now,
    })
    .where(and(eq(users.id, userId),eq(users.tokenVersion,update.expectedTokenVersion),eq(users.status,'active')))
    .returning();

  if (!user) {
    throw new Error('User disappeared during successful login update');
  }
  return user;
}

export async function changePasswordAndRevokeSessions(
  userId: string,
  passwordHash: string,
  now: Date,
  expectedTokenVersion: number,
): Promise<UserRecord> {
  return db.transaction(async (transaction) => {
    const [current] = await transaction
      .select({ password: users.password,tokenVersion:users.tokenVersion,status:users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');
    if (!current) throw new Error('User not found while changing password');
    if(current.status!=='active'||current.tokenVersion!==expectedTokenVersion)throw new ApiProblem({status:409,code:'SESSION_CHANGED',title:'账户状态已变化',detail:'请重新登录后再修改密码。'});
    await transaction.insert(passwordHistory).values({
      userId,
      passwordHash: current.password,
      createdAt: now,
    });
    const [user] = await transaction
      .update(users)
      .set({
        password: passwordHash,
        passwordChangedAt: now,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        tokenVersion: sql`${users.tokenVersion} + 1`,
        updatedAt: now,
      })
      .where(eq(users.id, userId))
      .returning();
    await transaction.execute(sql`
      DELETE FROM password_history
      WHERE user_id = ${userId}
        AND id NOT IN (
          SELECT id FROM password_history
          WHERE user_id = ${userId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${PASSWORD_HISTORY_DEPTH}
        )
    `);
    if (!user) throw new Error('User not found while changing password');
    return user;
  });
}

export async function revokeUserSessions(userId: string, now: Date): Promise<void> {
  await db
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: now })
    .where(eq(users.id, userId));
}
