export interface ProductFeatureEnvironment {
  readonly GUARDLLM_ENABLE_EXPERIMENTAL_LABS?: string;
}

export function experimentalLabsEnabled(
  environment: ProductFeatureEnvironment = {
    GUARDLLM_ENABLE_EXPERIMENTAL_LABS: process.env.GUARDLLM_ENABLE_EXPERIMENTAL_LABS,
  },
): boolean {
  return environment.GUARDLLM_ENABLE_EXPERIMENTAL_LABS?.trim().toLowerCase() === 'true';
}
