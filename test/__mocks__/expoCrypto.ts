import {
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID as nodeRandomUUID,
} from 'node:crypto';

/** Node implementation of the small Expo Crypto surface exercised by unit tests. */
export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' } as const;

export async function digest(
  algorithm: string,
  data: ArrayBuffer | ArrayBufferView,
): Promise<ArrayBuffer> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) throw new Error('unsupported test digest');
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const output = createHash('sha256').update(bytes).digest();
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
}

export async function digestStringAsync(algorithm: string, data: string): Promise<string> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) throw new Error('unsupported test digest');
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function getRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export async function getRandomBytesAsync(length: number): Promise<Uint8Array> {
  return getRandomBytes(length);
}

export function randomUUID(): string {
  return nodeRandomUUID();
}

/** Node-backed stand-ins for Expo SDK 57's AES objects. Native behavior still needs device proof. */
export class AESEncryptionKey {
  private constructor(readonly material: Uint8Array) {}

  static async import(material: Uint8Array): Promise<AESEncryptionKey> {
    if (material.length !== 32) throw new Error('unsupported test AES key length');
    return new AESEncryptionKey(material.slice());
  }
}

export class AESSealedData {
  private constructor(
    readonly ivBytes: Uint8Array,
    readonly ciphertextBytes: Uint8Array,
    readonly tagBytes: Uint8Array,
  ) {}

  static fromParts(iv: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): AESSealedData {
    return new AESSealedData(iv.slice(), ciphertext.slice(), tag.slice());
  }
}

export async function aesDecryptAsync(
  sealed: AESSealedData,
  key: AESEncryptionKey,
  options: { readonly additionalData?: Uint8Array; readonly output?: 'bytes' | 'base64' } = {},
): Promise<Uint8Array | string> {
  const decipher = createDecipheriv('aes-256-gcm', key.material, sealed.ivBytes);
  if (options.additionalData) decipher.setAAD(options.additionalData);
  decipher.setAuthTag(sealed.tagBytes);
  const plaintext = Buffer.concat([decipher.update(sealed.ciphertextBytes), decipher.final()]);
  return options.output === 'base64' ? plaintext.toString('base64') : new Uint8Array(plaintext);
}
