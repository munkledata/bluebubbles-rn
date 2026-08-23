import { createHash, randomBytes, randomUUID as nodeRandomUUID } from 'node:crypto';

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

export function randomUUID(): string {
  return nodeRandomUUID();
}
