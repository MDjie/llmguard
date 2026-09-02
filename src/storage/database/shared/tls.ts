export interface DatabaseTlsPolicyInput {
  readonly sslMode?: string;
  readonly caCertificate?: string;
  readonly nodeEnv?: string;
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

export function resolveDatabaseTls(
  connectionString: string,
  input: DatabaseTlsPolicyInput = {},
): DatabaseTlsOptions {
  const url = new URL(connectionString);
  const configuredMode = input.sslMode?.trim().toLowerCase();
  const queryMode = url.searchParams.get('sslmode')?.trim().toLowerCase();
  const mode = configuredMode || queryMode;
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());

  if (mode && INSECURE_MODES.has(mode)) {
    throw new Error('Database TLS mode must verify the server certificate');
  }
  if (mode && !DISABLED_MODES.has(mode) && !VERIFIED_MODES.has(mode)) {
    throw new Error('DATABASE_SSL_MODE is invalid');
  }
  if (mode && DISABLED_MODES.has(mode)) {
    if (input.nodeEnv === 'production' && !isLoopback) {
      throw new Error('Production database connections outside loopback must use verified TLS');
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
