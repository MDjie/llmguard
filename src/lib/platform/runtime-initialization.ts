export interface RuntimeInitializationEnvironment {
  readonly NODE_ENV?: string;
  readonly ALLOW_RUNTIME_DATABASE_INIT?: string;
}

export function isRuntimeDatabaseInitializationAllowed(
  environment: RuntimeInitializationEnvironment = process.env,
): boolean {
  return (
    environment.NODE_ENV !== 'production' &&
    environment.ALLOW_RUNTIME_DATABASE_INIT === 'true'
  );
}
