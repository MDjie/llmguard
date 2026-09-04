import { loadEnvConfig } from '@next/env';

const workspaceDirectory = process.cwd();
loadEnvConfig(workspaceDirectory, false);

async function main(): Promise<void> {
  const { ensureLocalPolicySigningKeyPair, resolveLocalPolicyKeyPaths } = await import(
    '../src/lib/policy-bundle/local-keys'
  );
  const result = ensureLocalPolicySigningKeyPair(resolveLocalPolicyKeyPaths(workspaceDirectory));
  process.stdout.write(`${JSON.stringify({
    created: result.created,
    publicKeyPath: result.publicKeyPath,
    publicKeyFingerprint: result.publicKeyFingerprint,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown policy key generation error';
  process.stderr.write(`Policy key generation failed: ${message}\n`);
  process.exitCode = 1;
});
