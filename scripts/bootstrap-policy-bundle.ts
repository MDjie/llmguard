import { loadEnvConfig } from '@next/env';

const workspaceDirectory = process.cwd();
loadEnvConfig(workspaceDirectory, false);

async function main(): Promise<void> {
  const supportedArguments = new Set(['--allow-local-development']);
  const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));
  if (unknownArguments.length > 0) throw new Error(`Unsupported argument: ${unknownArguments[0]}`);
  const acknowledged = process.argv.includes('--allow-local-development');
  const databaseUrl = process.env.PGDATABASE_URL ?? process.env.COZE_SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  process.env.GUARDLLM_DEPLOYMENT_PROFILE = 'local-compose';

  const [{
    assertLocalDevelopmentBootstrap,
    bootstrapLocalDefaultPolicyBundle,
  }, {
    ensureLocalPolicySigningKeyPair,
    resolveLocalPolicyKeyPaths,
  }, {
    closeDatabaseConnection,
  }, {
    LEGACY_TENANT_SCOPE,
  }] = await Promise.all([
    import('../src/lib/policy-bundle/bootstrap'),
    import('../src/lib/policy-bundle/local-keys'),
    import('../src/storage/database/shared/db'),
    import('../src/lib/tenancy'),
  ]);

  assertLocalDevelopmentBootstrap({
    acknowledged,
    databaseUrl,
    deploymentProfile: process.env.GUARDLLM_DEPLOYMENT_PROFILE,
  });
  const keys = ensureLocalPolicySigningKeyPair(resolveLocalPolicyKeyPaths(workspaceDirectory));
  delete process.env.POLICY_SIGNING_PRIVATE_KEY;
  delete process.env.POLICY_SIGNING_PUBLIC_KEY;
  process.env.POLICY_SIGNING_PRIVATE_KEY_FILE = keys.privateKeyPath;
  process.env.POLICY_SIGNING_PUBLIC_KEY_FILE = keys.publicKeyPath;
  process.env.POLICY_SIGNING_KEY_ID ||= 'local-ed25519-v1';

  try {
    const result = await bootstrapLocalDefaultPolicyBundle(LEGACY_TENANT_SCOPE);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await closeDatabaseConnection();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown policy bootstrap error';
  process.stderr.write(`Policy bootstrap failed: ${message}\n`);
  process.exitCode = 1;
});
