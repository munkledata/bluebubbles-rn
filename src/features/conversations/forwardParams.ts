import { isLocalFileUri } from '@utils';
import {
  MAX_FORWARD_ATTACHMENTS,
  type ForwardAttachmentCandidate,
} from './forwardAttachmentHandoff';

/**
 * Forward-to-new-chat param plumbing. Route params are public input (including custom-scheme
 * links), so file paths must never ride in them. The producer stages downloaded attachments in a
 * process-local handoff and the route carries only its opaque one-time nonce.
 */

export type ForwardParams = { forwardText?: string; forwardAttachmentHandoff?: string };

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
export function buildForwardParams(
  sel: {
    text: string | null;
    attachments: { localPath: string | null; mimeType: string | null }[];
  },
  stageAttachments: (attachments: ForwardAttachmentCandidate[]) => string | null,
): ForwardPlan {
  const downloaded = sel.attachments
    .filter((a) => isLocalFileUri(a.localPath))
    .slice(0, MAX_FORWARD_ATTACHMENTS);
  const params: ForwardParams = {};
  const text = sel.text?.trim();
  if (text) params.forwardText = sel.text as string;
  if (downloaded.length > 0) {
    const nonce = stageAttachments(
      downloaded.map((a): ForwardAttachmentCandidate => ({
        uri: a.localPath as string,
        name: nameFromUri(a.localPath as string),
        mimeType: a.mimeType ?? 'application/octet-stream',
      })),
    );
    if (!nonce) {
      return {
        kind: 'notice',
        message: 'The attachment is no longer available. Open it again, then Forward again.',
      };
    }
    params.forwardAttachmentHandoff = nonce;
  }
  if (params.forwardText == null && params.forwardAttachmentHandoff == null) {
    return sel.attachments.length > 0
      ? {
          kind: 'notice',
          message: 'Open the attachment first to download it, then Forward again.',
        }
      : { kind: 'none' };
  }
  return { kind: 'navigate', params };
}
