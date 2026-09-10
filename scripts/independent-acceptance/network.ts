import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

export function installNetworkMode(allowModels: boolean): () => { mode: string; attemptedConnections: number | null } {
  // Suppress dotenv loading by the lazy database module. Credentials must be supplied explicitly through the environment.
  process.env.NEXT_PHASE = 'phase-production-build';
  process.env.LOG_LEVEL = 'error';
  if (allowModels) return () => ({ mode: 'PROJECT_RUNTIME_NETWORK_ENABLED_NOT_AN_ALLOWLIST', attemptedConnections: null });
  let attemptedConnections = 0;
  const forbidden = (): never => { attemptedConnections++; throw new Error('INDEPENDENT_ACCEPTANCE_NETWORK_FORBIDDEN'); };
  globalThis.fetch = async () => forbidden();
  net.Socket.prototype.connect = forbidden;
  syncBuiltinESMExports();
  return () => ({ mode: 'SOCKET_AND_FETCH_DENY', attemptedConnections });
}
