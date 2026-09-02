import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/storage/database/shared/db';
import { secretEnvelopes } from '@/storage/database/shared/schema';
import { loadMasterKey, openSecret, sealSecret } from './envelope';
import type { MasterKey, SecretProvider } from './types';
import { LEGACY_TENANT_SCOPE, type TenantScope } from '@/lib/tenancy';

export class DatabaseSecretProvider implements SecretProvider {
  constructor(
    private readonly configuredKey?: MasterKey,
    private readonly configuredScope: TenantScope = LEGACY_TENANT_SCOPE,
  ) {}

  private masterKey(): MasterKey {
    return this.configuredKey ?? loadMasterKey();
  }

  async put(value: string): Promise<string> {
    const reference = `sec_${randomUUID()}`;
    const envelope = sealSecret(value, reference, this.masterKey());
    await db.insert(secretEnvelopes).values({
      tenantId: this.configuredScope.tenantId,
      applicationId: this.configuredScope.applicationId,
      ref: reference,
      keyId: envelope.keyId,
      algorithm: envelope.algorithm,
      iv: envelope.iv,
      ciphertext: envelope.ciphertext,
      authTag: envelope.authTag,
    });
    return reference;
  }

  async get(reference: string): Promise<string> {
    const [record] = await db
      .select()
      .from(secretEnvelopes)
      .where(and(
        eq(secretEnvelopes.ref, reference),
        eq(secretEnvelopes.tenantId, this.configuredScope.tenantId),
        eq(secretEnvelopes.applicationId, this.configuredScope.applicationId),
      ))
      .limit(1);
    if (!record) throw new Error('Secret reference was not found');
    return openSecret(
      {
        keyId: record.keyId,
        algorithm: 'AES-256-GCM',
        iv: record.iv,
        ciphertext: record.ciphertext,
        authTag: record.authTag,
      },
      reference,
      this.masterKey(),
    );
  }

  async delete(reference: string): Promise<void> {
    await db.delete(secretEnvelopes).where(and(
      eq(secretEnvelopes.ref, reference),
      eq(secretEnvelopes.tenantId, this.configuredScope.tenantId),
      eq(secretEnvelopes.applicationId, this.configuredScope.applicationId),
    ));
  }
}

let provider: SecretProvider | null = null;

export function getSecretProvider(scope: TenantScope = LEGACY_TENANT_SCOPE): SecretProvider {
  return provider ?? new DatabaseSecretProvider(undefined, scope);
}

export function setSecretProviderForTests(value: SecretProvider | null): void {
  provider = value;
}
