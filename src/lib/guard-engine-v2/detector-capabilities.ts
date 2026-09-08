import type { Direction } from '@guardllm/contracts';
export const DETECTION_CAPABILITY_VERSION='guard-detection-capabilities-1';
const ALWAYS_CONTROLS=new Set(['protected-context-leak','structured-dlp','output-credential-leak','output-privacy-dlp','output-internal-data','source-risk-relations']);
export function isEnforcementControl(detectorId:string,direction?:Direction):boolean {
  if(detectorId.startsWith('output-') && direction && !['OUTPUT_COMPLETE','OUTPUT_CHUNK','TOOL_RESULT'].includes(direction))return false;
  return ALWAYS_CONTROLS.has(detectorId);
}
export const REQUIRED_OUTPUT_DETECTORS=['protected-context-leak','output-credential-leak','output-privacy-dlp','output-internal-data','output-political-compliance','output-sexual-safety','output-illegal-harmful','output-insurance-compliance'] as const;
