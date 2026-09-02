import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { passwordHistory, users } from '@/storage/database/shared/schema';
import { LOGIN_FAILURE_THRESHOLD, LOGIN_LOCK_DURATION_MS, PASSWORD_HISTORY_DEPTH } from './constants';

export type UserRecord = typeof users.$inferSelect;

const publicUserColumns = {
  id: users.id,
  username: users.username,
  nickname: users.nickname,
  email: users.email,
  phone: users.phone,
  avatar: users.avatar,
  role: users.role,
  status: users.status,
  department: users.department,
  description: users.description,
  lastLoginAt: users.lastLoginAt,
  loginCount: users.loginCount,
  failedLoginCount: users.failedLoginCount,
  lockedUntil: users.lockedUntil,
  passwordChangedAt: users.passwordChangedAt,
  mustChangePassword: users.mustChangePassword,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
  createdBy: users.createdBy,
};

export interface UserListInput {
  readonly page: number;
  readonly pageSize: number;
  readonly keyword?: string;
  readonly role?: string;
  readonly status?: string;
}

export interface ManagedUserCreate {
  readonly username: string;
  readonly passwordHash: string;
  readonly nickname: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly role: string;
  readonly department: string | null;
  readonly description: string | null;
  readonly createdBy: string;
  readonly now: Date;
}

export interface ManagedUserUpdate {
  readonly nickname?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly role?: string;
  readonly status?: string;
  readonly department?: string | null;
  readonly description?: string | null;
  readonly passwordHash?: string;
  readonly mustChangePassword?: boolean;
  readonly revokeSessions: boolean;
  readonly now: Date;
}

export interface LoginFailureState {
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
}

export interface SuccessfulLoginUpdate {
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function roleStorageValues(role: string): readonly string[] {
  if (role === 'SYSTEM_ADMIN') return ['SYSTEM_ADMIN', 'admin'];
  if (role === 'BUSINESS_OPERATOR') return ['BUSINESS_OPERATOR', 'user'];
  return [role];
}

export async function listUsers(input: UserListInput) {
  const conditions: SQL[] = [];
  if (input.keyword) {
    const pattern = `%${escapeLike(input.keyword)}%`;
    const keywordCondition = or(
      ilike(users.username, pattern),
      ilike(users.nickname, pattern),
      ilike(users.email, pattern),
    );
    if (keywordCondition) conditions.push(keywordCondition);
  }
  if (input.role) conditions.push(inArray(users.role, roleStorageValues(input.role)));
  if (input.status) conditions.push(eq(users.status, input.status));
  const predicate = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (input.page - 1) * input.pageSize;

  const [items, countRows] = await Promise.all([
    db
      .select(publicUserColumns)
      .from(users)
      .where(predicate)
      .orderBy(desc(users.createdAt))
      .limit(input.pageSize)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(users).where(predicate),
  ]);
  return { items, total: Number(countRows[0]?.count ?? 0) };
}

export async function createManagedUser(input: ManagedUserCreate): Promise<UserRecord> {
  const [user] = await db
    .insert(users)
    .values({
      username: input.username,
      password: input.passwordHash,
      nickname: input.nickname,
      email: input.email,
      phone: input.phone,
      role: input.role,
      status: 'active',
      department: input.department,
      description: input.description,
      createdBy: input.createdBy,
      passwordChangedAt: input.now,
      mustChangePassword: true,
      tokenVersion: 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning();
  if (!user) throw new Error('User insert returned no row');
  return user;
}

export async function updateManagedUser(
  userId: string,
  input: ManagedUserUpdate,
): Promise<UserRecord | null> {
  const values: Partial<typeof users.$inferInsert> = {
    updatedAt: input.now,
    ...(input.nickname !== undefined ? { nickname: input.nickname } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.department !== undefined ? { department: input.department } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.passwordHash
      ? {
          password: input.passwordHash,
          passwordChangedAt: input.now,
          mustChangePassword: input.mustChangePassword ?? true,
        }
      : {}),
  };
  const [user] = await db
    .update(users)
    .set({
      ...values,
      ...(input.revokeSessions ? { tokenVersion: sql`${users.tokenVersion} + 1` } : {}),
    })
    .where(eq(users.id, userId))
    .returning();
  return user ?? null;
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

export async function deleteManagedUser(userId: string): Promise<boolean> {
  const deleted = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
  return deleted.length === 1;
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
    .where(eq(users.id, userId))
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
): Promise<UserRecord> {
  return db.transaction(async (transaction) => {
    const [current] = await transaction
      .select({ password: users.password })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');
    if (!current) throw new Error('User not found while changing password');
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
