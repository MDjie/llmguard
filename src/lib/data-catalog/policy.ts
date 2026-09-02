export const DATA_CATEGORIES = [
  'CUSTOMER', 'POLICY', 'HEALTH', 'PROPERTY', 'MODEL', 'PROMPT', 'LOG', 'SECRET', 'OTHER',
] as const;
export const CLASSIFICATION_LEVELS = ['PUBLIC', 'INTERNAL', 'SENSITIVE', 'HIGHLY_SENSITIVE'] as const;

export type DataCategory = (typeof DATA_CATEGORIES)[number];
export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number];

export interface ClassificationControls {
  readonly tlsRequired: boolean;
  readonly accessControlled: boolean;
  readonly encryptionAtRest: boolean;
  readonly maskingRequired: boolean;
  readonly accessAudited: boolean;
  readonly externalTransferProhibited: boolean;
  readonly dualApprovalRequired: boolean;
  readonly tokenizationRequired: boolean;
}

export function classificationControlViolations(
  level: ClassificationLevel,
  controls: ClassificationControls,
): readonly string[] {
  const violations: string[] = [];
  if (!controls.tlsRequired) violations.push('TLS_REQUIRED');
  if (level !== 'PUBLIC' && !controls.accessControlled) violations.push('ACCESS_CONTROL_REQUIRED');
  if (level === 'SENSITIVE' || level === 'HIGHLY_SENSITIVE') {
    if (!controls.encryptionAtRest) violations.push('ENCRYPTION_AT_REST_REQUIRED');
    if (!controls.maskingRequired) violations.push('MASKING_REQUIRED');
    if (!controls.accessAudited) violations.push('ACCESS_AUDIT_REQUIRED');
  }
  if (level === 'HIGHLY_SENSITIVE') {
    if (!controls.externalTransferProhibited) violations.push('EXTERNAL_TRANSFER_PROHIBITED');
    if (!controls.dualApprovalRequired) violations.push('DUAL_APPROVAL_REQUIRED');
    if (!controls.tokenizationRequired) violations.push('TOKENIZATION_REQUIRED');
  }
  return violations;
}
