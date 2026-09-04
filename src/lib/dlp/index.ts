export {
  fuseDlpEntities,
  observationsToDlpEntities,
  presidioCandidatesToDlpEntities,
} from './entity-fusion';
export type {
  DlpEntityCandidate,
  DlpFusionOptions,
  DlpFusionResult,
  DlpRecognizerSource,
  FusedDlpEntity,
  PresidioEntityCandidate,
} from './entity-fusion';

export {
  createIrreversibleDlpToken,
  createReversibleDlpToken,
  DLP_DETOKENIZE_PERMISSION,
  DLP_REVERSIBLE_TOKENIZE_PERMISSION,
  revealReversibleDlpToken,
  transformDlpText,
} from './transformation';
export type {
  DlpTransformationOptions,
  DlpTransformationResult,
  DlpTransformEntity,
  DlpTransformOperation,
  DlpTransformRange,
  ReversibleDlpTokenOptions,
} from './transformation';
