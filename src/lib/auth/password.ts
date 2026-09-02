import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';
import { DEFAULT_PASSWORD_MAX_AGE_DAYS } from './constants';

const BCRYPT_COST = 12;
const BCRYPT_PATTERN = /^\$2[aby]\$(\d{2})\$/;
const COMMON_PASSWORDS = new Set([
  '12345678',
  'admin123',
  'password',
  'password1',
  'qwerty123',
  'welcome123',
  'changeme',
]);

export type PasswordPolicyCode =
  | 'PASSWORD_TOO_SHORT'
  | 'PASSWORD_TOO_LONG'
  | 'PASSWORD_MISSING_UPPERCASE'
  | 'PASSWORD_MISSING_LOWERCASE'
  | 'PASSWORD_MISSING_DIGIT'
  | 'PASSWORD_MISSING_SYMBOL'
  | 'PASSWORD_CONTAINS_IDENTITY'
  | 'PASSWORD_TOO_COMMON';

export interface PasswordPolicyResult {
  readonly valid: boolean;
  readonly violations: readonly PasswordPolicyCode[];
}

export interface PasswordVerificationResult {
  readonly valid: boolean;
  readonly legacyPlaintext: boolean;
  readonly needsRehash: boolean;
}

export function validatePasswordPolicy(
  password: string,
  identityValues: readonly string[] = [],
): PasswordPolicyResult {
  const violations: PasswordPolicyCode[] = [];
  const characterLength = Array.from(password).length;
  const byteLength = Buffer.byteLength(password, 'utf8');

  if (characterLength < 12) violations.push('PASSWORD_TOO_SHORT');
  if (characterLength > 128 || byteLength > 72) violations.push('PASSWORD_TOO_LONG');
  if (!/[A-Z]/.test(password)) violations.push('PASSWORD_MISSING_UPPERCASE');
  if (!/[a-z]/.test(password)) violations.push('PASSWORD_MISSING_LOWERCASE');
  if (!/\d/.test(password)) violations.push('PASSWORD_MISSING_DIGIT');
  if (!/[^A-Za-z\d]/.test(password)) violations.push('PASSWORD_MISSING_SYMBOL');

  const lowered = password.toLocaleLowerCase('en-US');
  if (COMMON_PASSWORDS.has(lowered)) violations.push('PASSWORD_TOO_COMMON');
  if (
    identityValues.some((value) => {
      const candidate = value.trim().toLocaleLowerCase('en-US');
      return candidate.length >= 3 && lowered.includes(candidate);
    })
  ) {
    violations.push('PASSWORD_CONTAINS_IDENTITY');
  }

  return { valid: violations.length === 0, violations };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function isBcryptHash(value: string): boolean {
  return BCRYPT_PATTERN.test(value);
}

function matchesLegacyPlaintext(candidate: string, stored: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const storedBuffer = Buffer.from(stored);
  return (
    candidateBuffer.length === storedBuffer.length &&
    timingSafeEqual(candidateBuffer, storedBuffer)
  );
}

export async function verifyStoredPassword(
  candidate: string,
  stored: string,
): Promise<PasswordVerificationResult> {
  const match = stored.match(BCRYPT_PATTERN);
  if (!match) {
    return {
      valid: matchesLegacyPlaintext(candidate, stored),
      legacyPlaintext: true,
      needsRehash: true,
    };
  }

  let valid = false;
  try {
    valid = await bcrypt.compare(candidate, stored);
  } catch {
    valid = false;
  }
  return {
    valid,
    legacyPlaintext: false,
    needsRehash: Number(match[1]) < BCRYPT_COST,
  };
}

export function passwordMaxAgeDays(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const configured = Number(environment.PASSWORD_MAX_AGE_DAYS ?? DEFAULT_PASSWORD_MAX_AGE_DAYS);
  if (!Number.isInteger(configured) || configured < 1 || configured > 365) {
    throw new Error('PASSWORD_MAX_AGE_DAYS must be an integer between 1 and 365');
  }
  return configured;
}

export function passwordExpired(
  passwordChangedAt: Date | null,
  now = new Date(),
  maxAgeDays = passwordMaxAgeDays(),
): boolean {
  if (!passwordChangedAt) return true;
  return now.getTime() - passwordChangedAt.getTime() >= maxAgeDays * 24 * 60 * 60 * 1_000;
}

export async function passwordMatchesHistory(
  candidate: string,
  hashes: readonly string[],
): Promise<boolean> {
  for (const hash of hashes) {
    const verification = await verifyStoredPassword(candidate, hash);
    if (verification.valid) return true;
  }
  return false;
}
