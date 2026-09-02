import { describe, expect, it } from 'vitest';
import {
  UnsafeDocumentUploadError,
  validateDocumentUpload,
} from '../../src/lib/document/upload-security';

describe('legacy document upload signatures', () => {
  it('accepts matching OLE WPS and RTF signatures', async () => {
    const ole = new File([
      Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1]),
    ], 'policy.wps', { type: 'application/x-wps' });
    await expect(validateDocumentUpload(ole)).resolves.toMatchObject({ extension: 'wps' });
    const rtf = new File(['{\\rtf1\ansi test}'], 'policy.rtf', { type: 'application/rtf' });
    await expect(validateDocumentUpload(rtf)).resolves.toMatchObject({ extension: 'rtf' });
  });

  it('rejects an extension/signature mismatch before conversion', async () => {
    const fake = new File(['not an ole file'], 'policy.doc', { type: 'application/msword' });
    await expect(validateDocumentUpload(fake)).rejects.toMatchObject({
      code: 'FILE_SIGNATURE_INVALID',
    } satisfies Partial<UnsafeDocumentUploadError>);
  });
});
