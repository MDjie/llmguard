import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from '@/lib/policy-bundle/canonical';
import type {
  ApplicationProtocol,
  NetworkBypassPermitPayloadV2,
  SignedNetworkBypassPermitV2,
} from '../../../packages/contracts-appliance/generated/typescript/appliance-v1';

type SigningKey = string | Buffer | KeyObject;

export interface NetworkBypassContextV2 {
  readonly deviceGroupId: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly portPair: string;
  readonly protocol: ApplicationProtocol;
  readonly policyBundleId: string;
  readonly protectedTraffic: boolean;
  readonly requestedConnections: number;
  readonly requestedBytes: number;
  readonly nowEpochMs: number;
}

export type NetworkBypassValidationCodeV2 =
  | 'NETWORK_BYPASS_VALID'
  | 'NETWORK_BYPASS_MISSING'
  | 'NETWORK_BYPASS_PROTECTED_TRAFFIC'
  | 'NETWORK_BYPASS_ALGORITHM_INVALID'
  | 'NETWORK_BYPASS_PAYLOAD_INVALID'
  | 'NETWORK_BYPASS_REVOKED'
  | 'NETWORK_BYPASS_NOT_YET_VALID'
  | 'NETWORK_BYPASS_EXPIRED'
  | 'NETWORK_BYPASS_DURATION_EXCEEDED'
  | 'NETWORK_BYPASS_SCOPE_MISMATCH'
  | 'NETWORK_BYPASS_CAPACITY_EXCEEDED'
  | 'NETWORK_BYPASS_KEY_UNAVAILABLE'
  | 'NETWORK_BYPASS_SIGNATURE_INVALID';

export interface NetworkBypassValidationV2 {
  readonly valid: boolean;
  readonly reasonCode: NetworkBypassValidationCodeV2;
}

export interface NetworkBypassValidationOptionsV2 {
  readonly keyResolver: (keyId: string) => SigningKey | undefined;
  readonly revokedPermitIds?: ReadonlySet<string>;
  readonly maximumPermitDurationMs?: number;
}

const DEFAULT_MAXIMUM_PERMIT_DURATION_MS = 4 * 60 * 60 * 1000;

function asPrivateKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPrivateKey(key) : key;
}

function asPublicKey(key: SigningKey): KeyObject {
  return typeof key === 'string' || Buffer.isBuffer(key) ? createPublicKey(key) : key;
}

function uniqueNonEmpty(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => value.length > 0) &&
    new Set(values).size === values.length;
}

function payloadIsStructurallyValid(payload: NetworkBypassPermitPayloadV2): boolean {
  return payload.version === '2.0' &&
    payload.permitId.length >= 8 &&
    payload.deviceGroupId.length > 0 &&
    payload.tenantId.length > 0 &&
    payload.applicationId.length > 0 &&
    uniqueNonEmpty(payload.portPairs) &&
    payload.protocols.length > 0 &&
    new Set(payload.protocols).size === payload.protocols.length &&
    Number.isSafeInteger(payload.maximumConnections) && payload.maximumConnections > 0 &&
    Number.isSafeInteger(payload.maximumBytes) && payload.maximumBytes > 0 &&
    payload.reason.length >= 8 &&
    payload.changeTicketId.length > 0 &&
    uniqueNonEmpty(payload.approverIds) && payload.approverIds.length >= 2 &&
    payload.policyBundleId.length > 0 &&
    Number.isSafeInteger(payload.issuedAtEpochMs) && payload.issuedAtEpochMs > 0 &&
    Number.isSafeInteger(payload.expiresAtEpochMs) &&
    payload.expiresAtEpochMs > payload.issuedAtEpochMs;
}

export function signNetworkBypassPermitV2(
  payload: NetworkBypassPermitPayloadV2,
  keyId: string,
  privateKey: SigningKey,
): SignedNetworkBypassPermitV2 {
  if (!payloadIsStructurallyValid(payload) || keyId.length === 0) {
    throw new Error('NETWORK_BYPASS_PAYLOAD_INVALID');
  }
  return {
    keyId,
    algorithm: 'Ed25519',
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      asPrivateKey(privateKey),
    ).toString('base64url'),
  };
}

export function validateNetworkBypassPermitV2(
  permit: SignedNetworkBypassPermitV2 | undefined,
  context: NetworkBypassContextV2,
  options: NetworkBypassValidationOptionsV2,
): NetworkBypassValidationV2 {
  if (!permit) return { valid: false, reasonCode: 'NETWORK_BYPASS_MISSING' };
  if (context.protectedTraffic) {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_PROTECTED_TRAFFIC' };
  }
  if (permit.algorithm !== 'Ed25519') {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_ALGORITHM_INVALID' };
  }
  if (!payloadIsStructurallyValid(permit.payload)) {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_PAYLOAD_INVALID' };
  }
  if (options.revokedPermitIds?.has(permit.payload.permitId)) {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_REVOKED' };
  }
  if (permit.payload.issuedAtEpochMs > context.nowEpochMs) {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_NOT_YET_VALID' };
  }
  if (permit.payload.expiresAtEpochMs <= context.nowEpochMs) {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_EXPIRED' };
  }
  const maximumDurationMs = options.maximumPermitDurationMs ??
    DEFAULT_MAXIMUM_PERMIT_DURATION_MS;
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs <= 0 ||
      permit.payload.expiresAtEpochMs - permit.payload.issuedAtEpochMs > maximumDurationMs) {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_DURATION_EXCEEDED' };
  }
  if (permit.payload.deviceGroupId !== context.deviceGroupId ||
      permit.payload.tenantId !== context.tenantId ||
      permit.payload.applicationId !== context.applicationId ||
      permit.payload.policyBundleId !== context.policyBundleId ||
      !permit.payload.portPairs.includes(context.portPair) ||
      !permit.payload.protocols.includes(context.protocol)) {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_SCOPE_MISMATCH' };
  }
  if (!Number.isSafeInteger(context.requestedConnections) || context.requestedConnections < 0 ||
      !Number.isSafeInteger(context.requestedBytes) || context.requestedBytes < 0 ||
      context.requestedConnections > permit.payload.maximumConnections ||
      context.requestedBytes > permit.payload.maximumBytes) {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_CAPACITY_EXCEEDED' };
  }
  const key = options.keyResolver(permit.keyId);
  if (!key) return { valid: false, reasonCode: 'NETWORK_BYPASS_KEY_UNAVAILABLE' };
  try {
    const valid = verify(
      null,
      Buffer.from(canonicalJson(permit.payload)),
      asPublicKey(key),
      Buffer.from(permit.signature, 'base64url'),
    );
    return valid
      ? { valid: true, reasonCode: 'NETWORK_BYPASS_VALID' }
      : { valid: false, reasonCode: 'NETWORK_BYPASS_SIGNATURE_INVALID' };
  } catch {
    return { valid: false, reasonCode: 'NETWORK_BYPASS_SIGNATURE_INVALID' };
  }
}
