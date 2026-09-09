import { pgTable, varchar, jsonb, timestamp, integer, uniqueIndex, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '@/storage/database/shared/schema';
import type { GrantAttributes } from './policy';

export const userApplicationMemberships = pgTable('user_application_memberships', {
  id: varchar('id', { length: 36 }).primaryKey().default(sql`gen_random_uuid()::text`),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id),
  tenantId: varchar('tenant_id', { length: 36 }).notNull(),
  applicationId: varchar('application_id', { length: 36 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  attributes: jsonb('attributes').$type<GrantAttributes>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  grantedBy: varchar('granted_by', { length: 128 }).notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedBy: varchar('revoked_by', { length: 128 }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
}, table => [uniqueIndex('user_application_memberships_unique').on(table.userId, table.tenantId, table.applicationId)]);

export const iamIdentityProfiles = pgTable('iam_identity_profiles', {
  userId: varchar('user_id', { length: 36 }).primaryKey().references(() => users.id),
  loginMethod: varchar('login_method', { length: 20 }).notNull().default('local'),
  issuer: varchar('issuer', { length: 512 }),
  subject: varchar('subject', { length: 255 }),
  emergencyUntil: timestamp('emergency_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('iam_identity_external_unique').on(table.issuer, table.subject)]);

export interface IamDecision { actorId: string; role: string; tokenVersion:number; decision: 'approve' | 'reject'; at: string }
export const iamChangeRequests = pgTable('iam_change_requests', {
  id: varchar('id', { length: 36 }).primaryKey().default(sql`gen_random_uuid()::text`),
  tenantId: varchar('tenant_id', { length: 36 }).notNull(),
  applicationId: varchar('application_id', { length: 36 }).notNull(),
  targetUserId: varchar('target_user_id', { length: 36 }).notNull().references(() => users.id),
  requesterId: varchar('requester_id', { length: 36 }).notNull().references(() => users.id),
  kind: varchar('kind', { length: 32 }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  payloadDigest: varchar('payload_digest', { length: 64 }).notNull(),
  expectedTokenVersion: integer('expected_token_version').notNull(),
  requesterTokenVersion: integer('requester_token_version').notNull(),
  reason: text('reason').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  decisions: jsonb('decisions').$type<IamDecision[]>().notNull().default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

export const iamOidcExchanges = pgTable('iam_oidc_exchanges', {
  id: varchar('id', { length: 64 }).primaryKey(),
  browserHash: varchar('browser_hash', { length: 64 }).notNull(),
  verifier: varchar('verifier', { length: 128 }).notNull(),
  nonce: varchar('nonce', { length: 128 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const providerApprovalRequests = pgTable('provider_approval_requests', {
  id:varchar('id',{length:36}).primaryKey().default(sql`gen_random_uuid()::text`),
  tenantId:varchar('tenant_id',{length:36}).notNull(),applicationId:varchar('application_id',{length:36}).notNull(),
  providerId:varchar('provider_id',{length:36}).notNull(),requesterId:varchar('requester_id',{length:36}).notNull(),
  reviewerId:varchar('reviewer_id',{length:36}),payload:jsonb('payload').$type<Record<string,unknown>>().notNull(),
  payloadDigest:varchar('payload_digest',{length:64}).notNull(),expectedVersion:integer('expected_version').notNull(),
  reason:text('reason').notNull(),status:varchar('status',{length:20}).notNull().default('pending'),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),decidedAt:timestamp('decided_at',{withTimezone:true}),
});
