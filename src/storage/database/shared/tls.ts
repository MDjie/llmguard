export interface DatabaseTlsPolicyInput {
  readonly sslMode?: string;
  readonly caCertificate?: string;
  readonly nodeEnv?: string;
  readonly plaintextAllowedHosts?: string;
}

export type DatabaseTlsOptions = false | {
  readonly rejectUnauthorized: true;
  readonly ca?: string;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DISABLED_MODES = new Set(['disable', 'off', 'false']);
const VERIFIED_MODES = new Set(['require', 'verify-ca', 'verify-full', 'on', 'true']);
const INSECURE_MODES = new Set(['allow', 'prefer', 'no-verify', 'verify-none']);

function normalizeCertificate(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\\n/g, '\n').trim();
  return normalized || undefined;
}

function parsePlaintextAllowedHosts(value: string | undefined): ReadonlySet<string> {
  const hosts = new Set(
    (value ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const host of hosts) {
    if (!/^[a-z0-9.-]+$/.test(host)) {
      throw new Error('DATABASE_PLAINTEXT_ALLOWED_HOSTS contains an invalid hostname');
    }
  }
  return hosts;
}

export function resolveDatabaseTls(
  connectionString: string,
  input: DatabaseTlsPolicyInput = {},
): DatabaseTlsOptions {
  const url = new URL(connectionString);
  const configuredMode = input.sslMode?.trim().toLowerCase();
  const queryMode = url.searchParams.get('sslmode')?.trim().toLowerCase();
  const mode = configuredMode || queryMode;
  const hostname = url.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  const plaintextAllowedHosts = parsePlaintextAllowedHosts(input.plaintextAllowedHosts);

  if (mode && INSECURE_MODES.has(mode)) {
    throw new Error('Database TLS mode must verify the server certificate');
  }
  if (mode && !DISABLED_MODES.has(mode) && !VERIFIED_MODES.has(mode)) {
    throw new Error('DATABASE_SSL_MODE is invalid');
  }
  if (mode && DISABLED_MODES.has(mode)) {
    if (
      input.nodeEnv === 'production'
      && !isLoopback
      && !plaintextAllowedHosts.has(hostname)
    ) {
      throw new Error(
        'Production database connections outside loopback must use verified TLS or an explicit plaintext host allowlist',
      );
    }
    return false;
  }
  if (!mode && isLoopback) return false;

  const ca = normalizeCertificate(input.caCertificate);
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
  };
}
