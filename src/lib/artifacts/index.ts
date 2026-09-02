export {
  ArtifactError,
  artifactPartKey,
  completeArtifactUpload,
  createArtifactUpload,
  signArtifactPart,
} from './service';
export { detectMagic, magicMatchesKind } from './magic';
export { verifyNextArtifact } from './verifier';
export { readAcceptedTextArtifact } from './text-reader';
export type { MagicDetection } from './magic';
