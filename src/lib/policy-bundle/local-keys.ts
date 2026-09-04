import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface LocalPolicyKeyPaths {
  readonly rootDirectory: string;
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly lockPath: string;
}

export interface LocalPolicyKeyResult extends LocalPolicyKeyPaths {
  readonly created: boolean;
  readonly publicKeyFingerprint: string;
}

function exportedPublicDer(pem: string): Buffer {
  return createPublicKey(pem).export({ type: 'spki', format: 'der' });
}

export function validatePolicySigningKeyPair(privatePem: string, publicPem: string): string {
  const privateKey = createPrivateKey(privatePem);
  const suppliedPublic = exportedPublicDer(publicPem);
  const derivedPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (!Buffer.from(suppliedPublic).equals(Buffer.from(derivedPublic))) {
    throw new Error('Policy signing private and public keys do not match');
  }
  const challenge = randomBytes(32);
  const signature = sign(null, challenge, privateKey);
  if (!verify(null, challenge, createPublicKey(publicPem), signature)) {
    throw new Error('Policy signing key pair failed the cryptographic self-test');
  }
  return createHash('sha256').update(suppliedPublic).digest('hex');
}

export function resolveLocalPolicyKeyPaths(
  workspaceDirectory = process.cwd(),
): LocalPolicyKeyPaths {
  const rootDirectory = path.resolve(workspaceDirectory, '.guardllm', 'policy-signing');
  return {
    rootDirectory,
    privateKeyPath: path.join(rootDirectory, 'private', 'private.pem'),
    publicKeyPath: path.join(rootDirectory, 'public', 'public.pem'),
    lockPath: path.join(rootDirectory, '.keygen.lock'),
  };
}

function readAndValidate(paths: LocalPolicyKeyPaths): string {
  return validatePolicySigningKeyPair(
    readFileSync(paths.privateKeyPath, 'utf8'),
    readFileSync(paths.publicKeyPath, 'utf8'),
  );
}

function requireCompletePair(paths: LocalPolicyKeyPaths): 'missing' | 'present' {
  const privateExists = existsSync(paths.privateKeyPath);
  const publicExists = existsSync(paths.publicKeyPath);
  if (privateExists !== publicExists) {
    throw new Error('Incomplete policy signing key pair; refusing automatic repair');
  }
  return privateExists ? 'present' : 'missing';
}

export function ensureLocalPolicySigningKeyPair(
  paths: LocalPolicyKeyPaths = resolveLocalPolicyKeyPaths(),
): LocalPolicyKeyResult {
  mkdirSync(path.dirname(paths.privateKeyPath), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(paths.publicKeyPath), { recursive: true, mode: 0o755 });
  if (requireCompletePair(paths) === 'present') {
    return { ...paths, created: false, publicKeyFingerprint: readAndValidate(paths) };
  }

  let lockDescriptor: number | undefined;
  try {
    lockDescriptor = openSync(paths.lockPath, 'wx', 0o600);
    if (requireCompletePair(paths) === 'present') {
      return { ...paths, created: false, publicKeyFingerprint: readAndValidate(paths) };
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fingerprint = validatePolicySigningKeyPair(privatePem, publicPem);
    writeFileSync(paths.privateKeyPath, privatePem, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      writeFileSync(paths.publicKeyPath, publicPem, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    } catch (error) {
      rmSync(paths.privateKeyPath, { force: true });
      throw error;
    }
    chmodSync(paths.privateKeyPath, 0o600);
    chmodSync(paths.publicKeyPath, 0o644);
    return { ...paths, created: true, publicKeyFingerprint: fingerprint };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (code === 'EEXIST') {
      throw new Error('Policy signing key generation is already in progress', { cause: error });
    }
    throw error;
  } finally {
    if (lockDescriptor !== undefined) {
      closeSync(lockDescriptor);
      rmSync(paths.lockPath, { force: true });
    }
  }
}
