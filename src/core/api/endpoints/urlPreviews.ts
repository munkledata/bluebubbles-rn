import { z } from 'zod/v4';
import type { HttpClient } from '../http';

/**
 * The server accepts at most 512 KiB of raw image content: 699,052 Base64 characters plus the
 * longest permitted data-URL prefix. Keep this byte-derived cross-repository limit exact so an
 * incompatible or compromised server cannot inflate the app's JSON/cache boundary.
 */
export const MAX_URL_PREVIEW_IMAGE_DATA_URL_CHARS = 699_075;
const MAX_URL_PREVIEW_IMAGE_BYTES = 512 * 1_024;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Validate the exact representation emitted by the server after native image inspection. Checking
 * the decoded-format signature as well as the MIME label keeps malformed or relabelled bytes away
 * from the native image decoder even if a compromised server widens its response.
 */
export function isUrlPreviewImageDataUrl(value: string): boolean {
  if (value.length > MAX_URL_PREVIEW_IMAGE_DATA_URL_CHARS) return false;
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const payload = match[2]!;
  if (payload.length % 4 !== 0) return false;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decodedBytes = (payload.length / 4) * 3 - padding;
  if (decodedBytes > MAX_URL_PREVIEW_IMAGE_BYTES) return false;
  if (padding === 2) {
    const finalValue = BASE64_ALPHABET.indexOf(payload[payload.length - 3]!);
    if (finalValue < 0 || (finalValue & 0x0f) !== 0) return false;
  } else if (padding === 1) {
    const finalValue = BASE64_ALPHABET.indexOf(payload[payload.length - 2]!);
    if (finalValue < 0 || (finalValue & 0x03) !== 0) return false;
  }
  return match[1] === 'png' ? payload.startsWith('iVBORw0KGgo') : payload.startsWith('/9j/');
}

const PreviewImageDataUrl = z.string().refine(isUrlPreviewImageDataUrl);

function hasAtMostCodePoints(value: string, max: number): boolean {
  return [...value].length <= max;
}

function isStandardHttpUrl(value: string): boolean {
  if (value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.port === ''
    );
  } catch {
    return false;
  }
}

const PreviewUrl = z.string().min(1).max(2_048).refine(isStandardHttpUrl);

/** Reject unsafe message/payload URLs before they are even sent to the configured Gator server. */
export function isUrlPreviewRequestUrl(value: unknown): value is string {
  return PreviewUrl.safeParse(value).success;
}
const PreviewTitle = z
  .string()
  .max(600)
  .refine((value) => hasAtMostCodePoints(value, 300));
const PreviewDescription = z
  .string()
  .max(2_000)
  .refine((value) => hasAtMostCodePoints(value, 1_000));
const PreviewSiteName = z
  .string()
  .max(400)
  .refine((value) => hasAtMostCodePoints(value, 200));

export const UrlPreviewResult = z
  .object({
    url: PreviewUrl,
    title: PreviewTitle.nullable(),
    description: PreviewDescription.nullable(),
    siteName: PreviewSiteName.nullable(),
    imageDataUrl: PreviewImageDataUrl.nullable(),
  })
  .strict();
export type UrlPreviewResult = z.infer<typeof UrlPreviewResult>;

/**
 * Ask the authenticated Gator server to retrieve one public page and optional image through its
 * DNS/IP-pinned outbound boundary. The phone contacts only the configured server.
 */
export function fetchUrlPreview(
  http: HttpClient,
  url: string,
  signal?: AbortSignal,
): Promise<UrlPreviewResult> {
  if (!isUrlPreviewRequestUrl(url)) {
    return Promise.reject(new TypeError('Invalid URL preview request'));
  }
  return http.post('/url-preview', UrlPreviewResult, {
    json: { url },
    retry: false,
    signal,
  });
}
