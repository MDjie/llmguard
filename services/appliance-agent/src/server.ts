import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type {
  CapabilityManifest,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';
import {
  AppliancePolicyAgent,
  type SignedApplianceBundle,
} from '../../../src/lib/appliance/appliance-bundle';
import { validateCapabilityManifest } from '../../../src/lib/appliance/capability';
import { EvidenceFileStore } from '../../../src/lib/appliance/evidence-file-store';
import { EvidenceWal } from '../../../src/lib/appliance/evidence-wal';

const MAXIMUM_REQUEST_BYTES = 2 * 1024 * 1024;

interface ApplianceAgentConfig {
  readonly listenHost: '127.0.0.1' | '::1';
  readonly port: number;
  readonly capabilityManifestPath: string;
  readonly policyPublicKeyPaths: Readonly<Record<string, string>>;
  readonly evidencePrivateKeyPath: string;
  readonly evidenceSigningKeyId: string;
  readonly evidenceWalPath: string;
  readonly evidenceMaximumFileBytes: number;
  readonly evidenceMaximumRecords: number;
  readonly statePath: string;
}

interface ApplianceAgentState {
  readonly schemaVersion: '1.0';
  readonly activeBundle?: SignedApplianceBundle;
  readonly previousBundle?: SignedApplianceBundle;
}

export interface ApplianceAgentService {
  readonly server: Server;
  listen(): Promise<number>;
  close(): Promise<void>;
}

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathFrom(baseDirectory: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}

function parseConfig(value: unknown, baseDirectory: string): ApplianceAgentConfig {
  if (!object(value) || (value.listenHost !== '127.0.0.1' && value.listenHost !== '::1') ||
      typeof value.port !== 'number' || !Number.isSafeInteger(value.port) ||
      value.port < 0 || value.port > 65_535 ||
      typeof value.capabilityManifestPath !== 'string' ||
      !object(value.policyPublicKeyPaths) ||
      Object.keys(value.policyPublicKeyPaths).length === 0 ||
      Object.values(value.policyPublicKeyPaths).some((path) => typeof path !== 'string') ||
      typeof value.evidencePrivateKeyPath !== 'string' ||
      typeof value.evidenceSigningKeyId !== 'string' || value.evidenceSigningKeyId.length === 0 ||
      typeof value.evidenceWalPath !== 'string' || typeof value.statePath !== 'string' ||
      typeof value.evidenceMaximumFileBytes !== 'number' ||
      !Number.isSafeInteger(value.evidenceMaximumFileBytes) ||
      value.evidenceMaximumFileBytes < 1_024 ||
      typeof value.evidenceMaximumRecords !== 'number' ||
      !Number.isSafeInteger(value.evidenceMaximumRecords) ||
      value.evidenceMaximumRecords < 1) {
    throw new Error('APPLIANCE_AGENT_CONFIG_INVALID');
  }
  return {
    listenHost: value.listenHost,
    port: value.port,
    capabilityManifestPath: pathFrom(baseDirectory, value.capabilityManifestPath),
    policyPublicKeyPaths: Object.fromEntries(Object.entries(value.policyPublicKeyPaths).map(
      ([keyId, path]) => [keyId, pathFrom(baseDirectory, String(path))],
    )),
    evidencePrivateKeyPath: pathFrom(baseDirectory, value.evidencePrivateKeyPath),
    evidenceSigningKeyId: value.evidenceSigningKeyId,
    evidenceWalPath: pathFrom(baseDirectory, value.evidenceWalPath),
    evidenceMaximumFileBytes: value.evidenceMaximumFileBytes,
    evidenceMaximumRecords: value.evidenceMaximumRecords,
    statePath: pathFrom(baseDirectory, value.statePath),
  };
}

function isCapabilityManifest(value: unknown): value is CapabilityManifest {
  if (!object(value) || !Array.isArray(value.deploymentModes) ||
      !Array.isArray(value.engines) || !object(value.hardware)) return false;
  const hardware = value.hardware;
  return value.contractVersion === '1.0' && typeof value.deviceId === 'string' &&
    typeof value.deviceGroupId === 'string' && typeof value.generation === 'number' &&
    typeof value.reportedAtEpochMs === 'number' && typeof value.softwareVersion === 'string' &&
    typeof value.softwareDigest === 'string' && typeof value.manifestDigest === 'string' &&
    typeof hardware.cpuArchitecture === 'string' && typeof hardware.cpuModel === 'string' &&
    typeof hardware.memoryBytes === 'number' && Array.isArray(hardware.nicModels) &&
    Array.isArray(hardware.acceleratorModels) && Array.isArray(hardware.driverDigests) &&
    Array.isArray(hardware.firmwareDigests) &&
    typeof hardware.physicalBypassAvailable === 'boolean' &&
    typeof hardware.trustedKeyDeviceAvailable === 'boolean';
}

function isSignedBundle(value: unknown): value is SignedApplianceBundle {
  if (!object(value) || !object(value.payload)) return false;
  const payload = value.payload;
  return value.signatureAlgorithm === 'Ed25519' && typeof value.canonicalJson === 'string' &&
    typeof value.contentHash === 'string' && typeof value.signature === 'string' &&
    typeof value.signingKeyId === 'string' && payload.schemaVersion === '1.0' &&
    typeof payload.bundleId === 'string' && typeof payload.generation === 'number' &&
    typeof payload.deviceGroupId === 'string' && typeof payload.issuedAtEpochMs === 'number' &&
    typeof payload.expiresAtEpochMs === 'number' &&
    typeof payload.minimumSoftwareVersion === 'string' &&
    Array.isArray(payload.requiredDeploymentModes) && Array.isArray(payload.requiredEngines) &&
    typeof payload.requirePhysicalBypass === 'boolean' &&
    typeof payload.requireTrustedKeyDevice === 'boolean' &&
    typeof payload.networkPolicyDigest === 'string' && typeof payload.tlsPolicyDigest === 'string' &&
    typeof payload.guardPolicyBundleDigest === 'string' &&
    typeof payload.observabilityPolicyDigest === 'string';
}

function isState(value: unknown): value is ApplianceAgentState {
  return object(value) && value.schemaVersion === '1.0' &&
    (value.activeBundle === undefined || isSignedBundle(value.activeBundle)) &&
    (value.previousBundle === undefined || isSignedBundle(value.previousBundle));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.tmp-' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  const candidate = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7)
    : '';
  return Buffer.byteLength(candidate) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers['content-type'] ?? '').toString().toLowerCase()
    .startsWith('application/json')) {
    throw new Error('APPLIANCE_AGENT_CONTENT_TYPE_REQUIRED');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAXIMUM_REQUEST_BYTES) throw new Error('APPLIANCE_AGENT_BODY_TOO_LARGE');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('APPLIANCE_AGENT_JSON_INVALID');
  }
}

function respond(response: ServerResponse, statusCode: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
}

export async function createApplianceAgentService(input: {
  readonly configPath: string;
  readonly authToken: string;
  readonly now?: () => number;
}): Promise<ApplianceAgentService> {
  if (input.authToken.length < 32) throw new Error('APPLIANCE_AGENT_AUTH_TOKEN_TOO_SHORT');
  const absoluteConfigPath = resolve(input.configPath);
  const config = parseConfig(await readJson(absoluteConfigPath), dirname(absoluteConfigPath));
  const capabilityValue = await readJson(config.capabilityManifestPath);
  if (!isCapabilityManifest(capabilityValue) ||
      !validateCapabilityManifest(capabilityValue).valid) {
    throw new Error('APPLIANCE_AGENT_CAPABILITY_INVALID');
  }
  const publicKeys = new Map<string, string>();
  for (const [keyId, path] of Object.entries(config.policyPublicKeyPaths)) {
    if (keyId.length === 0) throw new Error('APPLIANCE_AGENT_POLICY_KEY_ID_INVALID');
    publicKeys.set(keyId, await readFile(path, 'utf8'));
  }
  const evidencePrivateKey = await readFile(config.evidencePrivateKeyPath, 'utf8');
  const now = input.now ?? Date.now;
  const policyAgent = new AppliancePolicyAgent(
    capabilityValue.deviceId,
    capabilityValue,
    (keyId) => publicKeys.get(keyId),
    now,
  );
  let stateHealthy = true;
  const persisted = await readOptionalJson(config.statePath);
  if (persisted !== undefined) {
    if (!isState(persisted)) {
      stateHealthy = false;
    } else {
      const restore = [persisted.previousBundle, persisted.activeBundle]
        .filter((bundle): bundle is SignedApplianceBundle => bundle !== undefined);
      for (const bundle of restore) {
        const prepared = policyAgent.prepare(bundle);
        if (prepared.status !== 'PREPARED') {
          stateHealthy = false;
          break;
        }
        policyAgent.activate(bundle.payload.bundleId);
      }
    }
  }
  const evidenceStore = new EvidenceFileStore({
    filePath: config.evidenceWalPath,
    deviceId: capabilityValue.deviceId,
    maximumFileBytes: config.evidenceMaximumFileBytes,
    keyResolver: (keyId) => keyId === config.evidenceSigningKeyId
      ? evidencePrivateKey
      : undefined,
  });
  await evidenceStore.initialize();
  const recovered = await evidenceStore.recover();
  const recoveredTail = recovered.records.at(-1);
  let evidenceWal = new EvidenceWal({
    deviceId: capabilityValue.deviceId,
    signingKeyId: config.evidenceSigningKeyId,
    privateKey: evidencePrivateKey,
    maximumRecords: config.evidenceMaximumRecords,
    highWatermarkRatio: 0.8,
    initialSequence: recoveredTail
      ? recoveredTail.body.sequence + 1
      : recovered.header.startingSequence,
    previousRecordHash: recoveredTail?.recordHash ?? recovered.header.previousRecordHash,
  });
  let evidenceHealthy = true;

  const persistState = async () => {
    const state: ApplianceAgentState = {
      schemaVersion: '1.0',
      ...(policyAgent.activeBundle() ? { activeBundle: policyAgent.activeBundle() } : {}),
      ...(policyAgent.previousBundle() ? { previousBundle: policyAgent.previousBundle() } : {}),
    };
    try {
      await atomicWriteJson(config.statePath, state);
      stateHealthy = true;
    } catch (error) {
      stateHealthy = false;
      throw error;
    }
  };

  const recordAudit = async (
    eventType: string,
    bundleId: string,
    payload: Readonly<Record<string, unknown>>,
  ) => {
    if (!evidenceHealthy) throw new Error('APPLIANCE_AGENT_EVIDENCE_UNAVAILABLE');
    const record = evidenceWal.append({
      domain: 'AUDIT', eventType, occurredAtEpochMs: now(), policyBundleId: bundleId, payload,
    });
    try {
      await evidenceStore.appendDurably(record);
    } catch (error) {
      evidenceHealthy = false;
      const disk = await evidenceStore.recover();
      const tail = disk.records.at(-1);
      evidenceWal = new EvidenceWal({
        deviceId: capabilityValue.deviceId,
        signingKeyId: config.evidenceSigningKeyId,
        privateKey: evidencePrivateKey,
        maximumRecords: config.evidenceMaximumRecords,
        highWatermarkRatio: 0.8,
        initialSequence: tail ? tail.body.sequence + 1 : disk.header.startingSequence,
        previousRecordHash: tail?.recordHash ?? disk.header.previousRecordHash,
      });
      throw error;
    }
  };

  let stopping = false;
  const server = createServer((request, response) => {
    const route = async () => {
      if (request.method === 'GET' && request.url === '/health/live') {
        respond(response, 200, { status: stopping ? 'stopping' : 'live' });
        return;
      }
      if (request.method === 'GET' && request.url === '/health/ready') {
        const ready = !stopping && stateHealthy && evidenceHealthy &&
          policyAgent.activeBundle() !== undefined;
        respond(response, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready', stateHealthy, evidenceHealthy,
          activeBundleId: policyAgent.activeBundle()?.payload.bundleId ?? null,
        });
        return;
      }
      if (!authorized(request, input.authToken)) {
        respond(response, 401, { code: 'APPLIANCE_AGENT_UNAUTHORIZED' });
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/capability') {
        respond(response, 200, capabilityValue);
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/state') {
        respond(response, 200, {
          deviceId: capabilityValue.deviceId,
          capabilityDigest: capabilityValue.manifestDigest,
          activeBundleId: policyAgent.activeBundle()?.payload.bundleId ?? null,
          activeGeneration: policyAgent.activeBundle()?.payload.generation ?? 0,
          previousBundleId: policyAgent.previousBundle()?.payload.bundleId ?? null,
          stateHealthy,
          evidenceHealthy,
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/bundles/prepare') {
        const body = await jsonBody(request);
        if (!isSignedBundle(body)) throw new Error('APPLIANCE_AGENT_BUNDLE_INVALID');
        const receipt = policyAgent.prepare(body);
        await recordAudit('APPLIANCE_BUNDLE_PREPARE', receipt.bundleId, { ...receipt });
        respond(response, receipt.status === 'PREPARED' ? 200 : 422, receipt);
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/bundles/activate') {
        const body = await jsonBody(request);
        if (!object(body) || typeof body.bundleId !== 'string') {
          throw new Error('APPLIANCE_AGENT_ACTIVATION_INVALID');
        }
        const receipt = policyAgent.activate(body.bundleId);
        await persistState();
        await recordAudit('APPLIANCE_BUNDLE_ACTIVATE', receipt.bundleId, { ...receipt });
        respond(response, 200, receipt);
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/bundles/rollback') {
        const body = await jsonBody(request);
        if (!object(body) || typeof body.reasonCode !== 'string') {
          throw new Error('APPLIANCE_AGENT_ROLLBACK_INVALID');
        }
        const receipt = policyAgent.rollback(body.reasonCode);
        await persistState();
        await recordAudit('APPLIANCE_BUNDLE_ROLLBACK', receipt.bundleId, { ...receipt });
        respond(response, 200, receipt);
        return;
      }
      respond(response, 404, { code: 'APPLIANCE_AGENT_ROUTE_NOT_FOUND' });
    };
    route().catch((error: unknown) => {
      const code = error instanceof Error && /^[A-Z0-9_:.-]+$/u.test(error.message)
        ? error.message.slice(0, 160)
        : 'APPLIANCE_AGENT_REQUEST_FAILED';
      respond(response, code.includes('TOO_LARGE') ? 413 : 422, { code });
    });
  });

  return {
    server,
    listen: () => new Promise<number>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(config.port, config.listenHost, () => {
        server.removeListener('error', rejectListen);
        resolveListen((server.address() as AddressInfo).port);
      });
    }),
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      stopping = true;
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

const isMainModule = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const configPath = process.env.APPLIANCE_AGENT_CONFIG ?? '';
  const authToken = process.env.APPLIANCE_AGENT_AUTH_TOKEN ?? '';
  if (configPath.length === 0) throw new Error('APPLIANCE_AGENT_CONFIG is required');
  const service = await createApplianceAgentService({ configPath, authToken });
  const port = await service.listen();
  process.stdout.write(JSON.stringify({ event: 'appliance-agent.started', port }) + '\n');
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      service.close().then(
        () => { process.exitCode = 0; },
        () => { process.exitCode = 1; },
      );
    });
  }
}
