export interface ProductFeatureEnvironment {
  readonly NODE_ENV?: string;
  readonly GUARDLLM_ENABLE_EXPERIMENTAL_LABS?: string;
}

export function experimentalLabsEnabled(
  environment: ProductFeatureEnvironment = {
    NODE_ENV: process.env.NODE_ENV,
    GUARDLLM_ENABLE_EXPERIMENTAL_LABS: process.env.GUARDLLM_ENABLE_EXPERIMENTAL_LABS,
  },
): boolean {
  return (
    environment.NODE_ENV !== 'production'
    && environment.GUARDLLM_ENABLE_EXPERIMENTAL_LABS?.trim().toLowerCase() === 'true'
  );
}
