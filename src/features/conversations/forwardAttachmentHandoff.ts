import type { SharedAttachment } from '@state/shareIntentStore';

/** Match the established rich-paste intake ceiling. */
export const MAX_FORWARD_ATTACHMENTS = 10;
export const MAX_FORWARD_ATTACHMENT_BYTES = 128 * 1024 * 1024; // 128 MiB per file
export const MAX_FORWARD_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MiB per handoff

const HANDOFF_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_HANDOFFS = 8;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ForwardAttachmentCandidate {
  uri: string;
  name: string;
  mimeType: string;
}

interface PendingHandoff {
  createdAt: number;
  attachments: ForwardAttachmentCandidate[];
  isCurrent: () => boolean;
  protections: ForwardAttachmentProtection[];
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

export interface ForwardAttachmentProtection {
  release(): void;
}

const pending = new Map<string, PendingHandoff>();

function releaseProtections(handoff: PendingHandoff): void {
  const protections = handoff.protections.splice(0);
  for (const protection of protections) protection.release();
}

function removePending(nonce: string, handoff: PendingHandoff, release: boolean): void {
  if (pending.get(nonce) !== handoff) return;
  pending.delete(nonce);
  if (handoff.expiryTimer != null) clearTimeout(handoff.expiryTimer);
  handoff.expiryTimer = null;
  if (release) releaseProtections(handoff);
}

function isCurrent(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function pruneExpired(now: number): void {
  for (const [nonce, handoff] of pending) {
    if (now - handoff.createdAt > HANDOFF_TTL_MS || !isCurrent(handoff.isCurrent)) {
      removePending(nonce, handoff, true);
    }
  }
}

/**
 * Put an attachment batch behind an unguessable, one-time route token. The route sees only the
 * token; file paths never become public URL data. The account-current callback prevents a token
 * created by an old chat screen from being consumed after an account switch.
 */
export function stageForwardAttachmentHandoff(args: {
  nonce: string;
  attachments: ForwardAttachmentCandidate[];
  isCurrent: () => boolean;
  now?: number;
  /** Synchronously pins each source before the route handoff becomes visible. */
  protectPath?: (path: string) => ForwardAttachmentProtection | null;
}): string | null {
  const now = args.now ?? Date.now();
  pruneExpired(now);
  if (
    !UUID_V4.test(args.nonce) ||
    !isCurrent(args.isCurrent) ||
    args.attachments.length === 0 ||
    args.attachments.length > MAX_FORWARD_ATTACHMENTS ||
    pending.has(args.nonce)
  ) {
    return null;
  }
  if (
    args.attachments.some(
      (file) =>
        typeof file.uri !== 'string' ||
        file.uri.length === 0 ||
        typeof file.name !== 'string' ||
        file.name.length === 0 ||
        typeof file.mimeType !== 'string' ||
        file.mimeType.length === 0,
    )
  ) {
    return null;
  }

  const protections: ForwardAttachmentProtection[] = [];
  if (args.protectPath) {
    for (const attachment of args.attachments) {
      let protection: ForwardAttachmentProtection | null;
      try {
        protection = args.protectPath(attachment.uri);
      } catch {
        protection = null;
      }
      if (protection === null) {
        for (const acquired of protections) acquired.release();
        return null;
      }
      protections.push(protection);
    }
  }

  const handoff: PendingHandoff = {
    createdAt: now,
    attachments: args.attachments.map((file) => ({ ...file })),
    isCurrent: args.isCurrent,
    protections,
    expiryTimer: null,
  };
  pending.set(args.nonce, handoff);
  // A route/navigation failure must not pin a path forever. The identity check inside
  // removePending prevents an old timer from touching a later handoff that reused the nonce.
  handoff.expiryTimer = setTimeout(() => {
    removePending(args.nonce, handoff, true);
  }, HANDOFF_TTL_MS + 1);
  while (pending.size > MAX_PENDING_HANDOFFS) {
    const oldestNonce = pending.keys().next().value as string | undefined;
    if (oldestNonce == null) break;
    const oldest = pending.get(oldestNonce);
    if (oldest) removePending(oldestNonce, oldest, true);
  }
  return args.nonce;
}

function normalizedPrivateFileUri(raw: string): string | null {
  // Native URI decoders may treat encoded separators as path separators. Reject them instead of
  // depending on one platform's decode order; URL itself normalizes literal and encoded dot paths.
  if (raw.includes('\\') || /%(?:00|2f|5c)/i.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'file:' ||
      parsed.hostname !== '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function isUnderOwnedRoot(uri: string, roots: string[]): boolean {
  const normalized = normalizedPrivateFileUri(uri);
  if (!normalized) return false;
  return roots.some((root) => {
    const normalizedRoot = normalizedPrivateFileUri(root);
    if (!normalizedRoot) return false;
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    return normalized.startsWith(prefix);
  });
}

/**
 * Consume exactly one staged token. Validation is all-or-nothing: every file must still exist,
 * resolve below an app-owned root, and fit the count/per-file/aggregate limits before the caller
 * receives any path. Unknown or fractional sizes fail closed.
 */
export function consumeForwardAttachmentHandoff(
  rawNonce: unknown,
  options: {
    ownedRoots: string[];
    fileInfo: (uri: string) => { exists: boolean; size: number | null };
    now?: number;
    /** Receives ownership of the stage-time pins until the composer sends or unmounts. */
    onProtectionLease?: (release: () => void) => void;
  },
): SharedAttachment[] {
  if (typeof rawNonce !== 'string' || !UUID_V4.test(rawNonce)) return [];
  const now = options.now ?? Date.now();
  pruneExpired(now);
  const handoff = pending.get(rawNonce);
  if (!handoff) return [];
  // Delete before touching the filesystem: failures and re-entrant calls cannot replay a token.
  removePending(rawNonce, handoff, false);
  if (
    !isCurrent(handoff.isCurrent) ||
    now - handoff.createdAt > HANDOFF_TTL_MS ||
    options.ownedRoots.length === 0 ||
    handoff.attachments.length === 0 ||
    handoff.attachments.length > MAX_FORWARD_ATTACHMENTS
  ) {
    releaseProtections(handoff);
    return [];
  }

  const validated: SharedAttachment[] = [];
  let totalBytes = 0;
  for (const attachment of handoff.attachments) {
    if (!isUnderOwnedRoot(attachment.uri, options.ownedRoots)) {
      releaseProtections(handoff);
      return [];
    }
    let info: { exists: boolean; size: number | null };
    try {
      info = options.fileInfo(attachment.uri);
    } catch {
      releaseProtections(handoff);
      return [];
    }
    const bytes = info.size;
    if (
      !info.exists ||
      bytes == null ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > MAX_FORWARD_ATTACHMENT_BYTES
    ) {
      releaseProtections(handoff);
      return [];
    }
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_FORWARD_TOTAL_BYTES) {
      releaseProtections(handoff);
      return [];
    }
    validated.push({ ...attachment, size: bytes });
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseProtections(handoff);
  };
  if (handoff.protections.length > 0 && options.onProtectionLease) {
    try {
      options.onProtectionLease(release);
    } catch {
      release();
      return [];
    }
  } else {
    // Callers that do not accept a lease retain the historical one-shot API without leaking pins.
    release();
  }
  return validated;
}

/** Test/session-cleanup seam; production handoffs otherwise disappear on consume/expiry. */
export function clearForwardAttachmentHandoffs(): void {
  for (const [nonce, handoff] of pending) removePending(nonce, handoff, true);
}
