import { createHash } from 'node:crypto';

export const HIDDEN_INCIDENT_EVIDENCE =
  '[原文证据已隐藏；请提交用途说明并经另一名授权人员审批后临时查看]';

export function incidentEvidenceDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function projectIncidentWithoutRawEvidence<
  T extends { readonly answerEvidence: string },
>(incident: T): Omit<T, 'answerEvidence'> & {
  readonly answerEvidence: string;
  readonly answerEvidenceDigest: string;
  readonly answerEvidenceBytes: number;
  readonly rawEvidenceAccess: 'APPROVAL_REQUIRED';
} {
  return {
    ...incident,
    answerEvidence: HIDDEN_INCIDENT_EVIDENCE,
    answerEvidenceDigest: incidentEvidenceDigest(incident.answerEvidence),
    answerEvidenceBytes: Buffer.byteLength(incident.answerEvidence, 'utf8'),
    rawEvidenceAccess: 'APPROVAL_REQUIRED',
  };
}
