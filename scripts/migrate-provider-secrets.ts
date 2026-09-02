import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../src/storage/database/shared/db';
import { llmProviders } from '../src/storage/database/shared/schema';
import { getSecretProvider } from '../src/lib/secrets';

async function main(): Promise<void> {
  const legacy = await db
    .select({
      id: llmProviders.id,
      tenantId: llmProviders.tenantId,
      applicationId: llmProviders.applicationId,
      apiKeyEncrypted: llmProviders.apiKeyEncrypted,
    })
    .from(llmProviders)
    .where(and(isNull(llmProviders.secretRef), isNotNull(llmProviders.apiKeyEncrypted)));

  let migrated = 0;
  for (const provider of legacy) {
    if (!provider.apiKeyEncrypted) continue;
    const secretProvider = getSecretProvider({
      tenantId: provider.tenantId,
      applicationId: provider.applicationId,
    });
    const reference = await secretProvider.put(provider.apiKeyEncrypted);
    try {
      const updated = await db
        .update(llmProviders)
        .set({ secretRef: reference, apiKeyEncrypted: null, updatedAt: new Date() })
        .where(
          and(
            eq(llmProviders.id, provider.id),
            isNull(llmProviders.secretRef),
            eq(llmProviders.apiKeyEncrypted, provider.apiKeyEncrypted),
          ),
        )
        .returning({ id: llmProviders.id });
      if (updated.length === 1) {
        migrated += 1;
      } else {
        await secretProvider.delete(reference);
      }
    } catch (error) {
      await secretProvider.delete(reference).catch(() => undefined);
      throw error;
    }
  }
  process.stdout.write(`Provider secrets migrated: ${migrated}; candidates: ${legacy.length}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown migration error';
  process.stderr.write(`Provider secret migration failed: ${message}\n`);
  process.exitCode = 1;
});
