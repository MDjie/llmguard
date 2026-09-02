import { describe, expect, it } from 'vitest';
import { classificationControlViolations, type ClassificationControls } from '../../src/lib/data-catalog';

const controls: ClassificationControls = {
  tlsRequired: true, accessControlled: true, encryptionAtRest: true, maskingRequired: true,
  accessAudited: true, externalTransferProhibited: true, dualApprovalRequired: true, tokenizationRequired: true,
};

describe('DAT-001 classification catalog controls', () => {
  it('accepts the complete highly-sensitive control set', () => {
    expect(classificationControlViolations('HIGHLY_SENSITIVE', controls)).toEqual([]);
  });

  it('requires masking, audit and encryption for sensitive data', () => {
    expect(classificationControlViolations('SENSITIVE', { ...controls, maskingRequired: false, accessAudited: false, encryptionAtRest: false }))
      .toEqual(['ENCRYPTION_AT_REST_REQUIRED', 'MASKING_REQUIRED', 'ACCESS_AUDIT_REQUIRED']);
  });

  it('requires transfer prohibition, dual approval and tokenization for secrets', () => {
    const violations = classificationControlViolations('HIGHLY_SENSITIVE', {
      ...controls, externalTransferProhibited: false, dualApprovalRequired: false, tokenizationRequired: false,
    });
    expect(violations).toEqual(['EXTERNAL_TRANSFER_PROHIBITED', 'DUAL_APPROVAL_REQUIRED', 'TOKENIZATION_REQUIRED']);
  });
});
