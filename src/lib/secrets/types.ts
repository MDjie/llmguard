export interface SecretProvider {
  put(value: string): Promise<string>;
  get(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

export interface MasterKey {
  readonly id: string;
  readonly bytes: Buffer;
}

export interface SecretEnvelope {
  readonly keyId: string;
  readonly algorithm: 'AES-256-GCM';
  readonly iv: string;
  readonly ciphertext: string;
  readonly authTag: string;
}
