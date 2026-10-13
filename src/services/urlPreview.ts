import {
  isUrlPreviewImageDataUrl,
  MAX_URL_PREVIEW_IMAGE_DATA_URL_CHARS,
} from '@core/api/endpoints/urlPreviews';

/**
 * Only server-fetched image bytes may cross the preview rendering boundary. Legacy cache rows and
 * Apple payload metadata can contain remote URLs; accepting either here would make mounting an
 * image trigger a direct third-party request from the phone.
 */
export function isProxiedPreviewImageDataUrl(raw: string | null | undefined): raw is string {
  return (
    !!raw && raw.length <= MAX_URL_PREVIEW_IMAGE_DATA_URL_CHARS && isUrlPreviewImageDataUrl(raw)
  );
}
