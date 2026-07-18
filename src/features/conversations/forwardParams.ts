import type { SharedAttachment } from '@state/shareIntentStore';
import { isLocalFileUri } from '@utils';

/**
 * Forward-to-new-chat param plumbing. expo-router params must be STRINGS, so the forwarded
 * attachments ride as one JSON-encoded array (`forwardAttachments`) alongside `forwardText`.
 * Only DOWNLOADED attachments (a local `file://` path) are forwardable — the forward action
 * never triggers a download. Both halves are pure (the receiver's file check is injected) so
 * they run under the node jest project.
 */

/** Wire shape of one forwarded attachment inside the `forwardAttachments` JSON param. */
export interface ForwardedAttachment {
  uri: string;
  name: string;
  mimeType: string;
}

export type ForwardParams = { forwardText?: string; forwardAttachments?: string };

export type ForwardPlan =
  | { kind: 'navigate'; params: ForwardParams }
  | { kind: 'notice'; message: string }
  | { kind: 'none' };

/** Downloaded files are named by their transferName (see expoFetcher), so the basename is it. */
function nameFromUri(uri: string): string {
  const base = uri.split('/').pop();
  if (!base) return 'attachment';
  try {
    return decodeURIComponent(base);
  } catch {
    return base; // a bare '%' in the filename is not percent-encoding — keep it as-is
  }
}

/**
 * Decide what the Forward action does for a selected message: navigate with params (text and/or
 * downloaded attachments), show a "download it first" notice (attachments exist but none are
 * downloaded and there's no text), or nothing (no content at all).
 */
export function buildForwardParams(sel: {
  text: string | null;
  attachments: { localPath: string | null; mimeType: string | null }[];
}): ForwardPlan {
  const downloaded = sel.attachments.filter((a) => isLocalFileUri(a.localPath));
  const params: ForwardParams = {};
  const text = sel.text?.trim();
  if (text) params.forwardText = sel.text as string;
  if (downloaded.length > 0) {
    params.forwardAttachments = JSON.stringify(
      downloaded.map(
        (a): ForwardedAttachment => ({
          uri: a.localPath as string,
          name: nameFromUri(a.localPath as string),
          mimeType: a.mimeType ?? 'application/octet-stream',
        }),
      ),
    );
  }
  if (params.forwardText == null && params.forwardAttachments == null) {
    return sel.attachments.length > 0
      ? {
          kind: 'notice',
          message: 'Open the attachment first to download it, then Forward again.',
        }
      : { kind: 'none' };
  }
  return { kind: 'navigate', params };
}

/**
 * Parse + validate the `forwardAttachments` router param into stageable attachments.
 * Tolerant: garbage JSON / non-arrays / malformed items degrade to fewer (or zero) staged
 * files, never a throw. Each candidate must be a local `file://` URI that actually exists
 * on disk (`fileInfo` is injected — the screen passes an expo-file-system probe).
 */
export function parseForwardAttachments(
  raw: string | undefined,
  fileInfo: (uri: string) => { exists: boolean; size: number | null },
): SharedAttachment[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SharedAttachment[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item == null) continue;
    const { uri, name, mimeType } = item as Record<string, unknown>;
    if (typeof uri !== 'string' || !isLocalFileUri(uri)) continue;
    let info: { exists: boolean; size: number | null };
    try {
      info = fileInfo(uri);
    } catch {
      continue; // an unreadable/invalid path is skipped, not fatal
    }
    if (!info.exists) continue;
    out.push({
      uri,
      name: typeof name === 'string' && name.length > 0 ? name : nameFromUri(uri),
      mimeType:
        typeof mimeType === 'string' && mimeType.length > 0 ? mimeType : 'application/octet-stream',
      size: info.size ?? 0,
    });
  }
  return out;
}
