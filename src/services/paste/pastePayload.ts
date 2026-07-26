import type { SharedAttachment } from '@state/shareIntentStore';
import {
  DEFAULT_MIME,
  mimeForExtension,
  safeShareFileName,
} from '../share/shareIntentPayload';

/**
 * Pure parser for the `onPaste` event emitted by the `GatorPasteInput` native module
 * (`modules/gator-paste-input/`), which fires when the user pastes into the composer — via the
 * long-press Paste menu, a keyboard image/GIF/sticker commit, or a drag-and-drop.
 *
 * WHY THE NATIVE SIDE ALREADY COPIED THE FILES: Android hands a pasted `content://` uri to the
 * receiving view under a TRANSIENT read grant. For a keyboard commit the grant is released the
 * moment the listener returns (androidx's `InputConnectionCompat` wrapper calls
 * `releasePermission()` for us), so a uri forwarded to JS would already be dead by the time an
 * async copy started. The Kotlin listener therefore stream-copies each item into
 * `<cache>/pasted-in/<batchMs>/` synchronously and emits app-private `file://` paths — the same
 * rule the share-intent path learned the hard way (`docs/SHARE_INTENT_RELIABILITY.md`). This
 * module's only job is to validate and normalize what came back.
 *
 * Kept PURE (no expo/react-native imports) so the whole decision table is unit-tested in the node
 * jest project.
 */

/** One entry exactly as the native module emits it — treated as fully untrusted. */
export interface RawPastedFile {
  uri?: string | null;
  name?: string | null;
  mimeType?: string | null;
  size?: number | string | null;
}

export interface ParsedPaste {
  /**
   * React tag of the text input that received the paste, so a screen with more than one input
   * (the composer plus the Private-API subject field) stages into the right one. Null when the
   * native side could not report it.
   */
  tag: number | null;
  files: SharedAttachment[];
  /** Entries that arrived but were unusable — drives a "couldn't read that" toast. */
  dropped: number;
}

/**
 * A pathological multi-select paste shouldn't be able to flood the composer. The native side
 * copies at most this many too, so this is a second line of defence rather than the real cap.
 */
export const MAX_PASTED_FILES = 10;

const EMPTY: ParsedPaste = { tag: null, files: [], dropped: 0 };

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** A size may arrive as a decimal string from a provider. Anything unparseable → null. */
function asSize(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '';
}

/**
 * Resolve one raw entry, or null when it is unusable.
 *
 * The `file://` check is deliberately strict: the native listener only ever emits paths it wrote
 * into our own cache, so anything else (a raw `content://`, a bare path) means something upstream
 * changed. Staging it would produce an attachment that uploads fine once and then fails forever
 * on the retry queue, which re-reads `localPath` after a restart — far worse than dropping it.
 */
function toAttachment(raw: RawPastedFile, index: number, now: number): SharedAttachment | null {
  const uri = asString(raw.uri);
  if (!uri || !uri.startsWith('file://')) return null;

  // The native side re-stats after copying, but an empty file still means the copy produced
  // nothing usable — the same failure the SAF branch of expo-file-system can resolve without
  // actually writing.
  const size = asSize(raw.size);
  if (size == null || size === 0) return null;

  const rawName = asString(raw.name);
  const mimeType =
    asString(raw.mimeType) ?? mimeForExtension(extensionOf(rawName ?? uri)) ?? DEFAULT_MIME;

  return {
    uri,
    name: safeShareFileName(rawName, uri, mimeType, index, now),
    mimeType,
    size,
  };
}

/**
 * Parse the raw `onPaste` payload. NEVER throws — a malformed event yields an empty paste.
 *
 * Non-object entries are skipped rather than trusted, mirroring the defence the share parser
 * needs against `expo-share-intent`'s junk-array bug: a native payload is not a type guarantee.
 */
export function parsePasteEvent(value: unknown, opts: { now: number }): ParsedPaste {
  if (typeof value !== 'object' || value === null) return EMPTY;
  const payload = value as { tag?: unknown; files?: unknown };

  const tag = typeof payload.tag === 'number' && Number.isFinite(payload.tag) ? payload.tag : null;
  const entries = Array.isArray(payload.files) ? payload.files.slice(0, MAX_PASTED_FILES) : [];

  const files: SharedAttachment[] = [];
  let dropped = 0;
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      dropped += 1;
      return;
    }
    const file = toAttachment(entry as RawPastedFile, index, opts.now);
    if (file) files.push(file);
    else dropped += 1;
  });

  return { tag, files, dropped };
}
