import type { AttachmentRow } from '@db/repositories';

/**
 * Data shapes and pure helpers for the fullscreen media viewer (`app/(app)/media/[guid].tsx`).
 *
 * The viewer guards every published path and every Share/Save/Download continuation with
 * lifetimes: the route lifetime changes when the route is recycled, the account retires or the
 * screen closes, and the page lifetime changes on every swipe or retry. A result whose lifetimes
 * no longer match the active page is dropped.
 */

/** The chat photos the viewer pages through, and the page it opened on. */
export interface MediaGallery {
  items: AttachmentRow[];
  index: number;
}

/** How long a page check may run before the viewer shows its "Checking media…" spinner. */
export const PAGE_CHECK_INDICATOR_DELAY_MS = 300;

export interface LoadedMedia {
  routeGuid: string;
  routeLifetime: number;
  attachment: AttachmentRow | null;
  gallery: MediaGallery | null;
  pageIndex: number;
  pageLifetime: number;
  pageStatus: 'checking' | 'ready' | 'error';
}

/** The exact page and file an action was started for. */
export interface MediaSourceGrant {
  routeGuid: string;
  routeLifetime: number;
  pageLifetime: number;
  attachmentGuid: string;
  localPath: string | null;
  mimeType: string | null;
}

export interface MediaActionOperation {
  token: symbol;
  source: MediaSourceGrant;
}

export type MediaDownloadIntent = 'download' | 'share' | 'save';

export interface MediaDownloadOperation {
  token: symbol;
  intent: MediaDownloadIntent;
  phase: 'downloading' | 'adopted';
  recoversMediaFailure: boolean;
  source: MediaSourceGrant;
}

export interface MediaLoadFailure {
  source: MediaSourceGrant;
}

export function sameMediaSource(left: MediaSourceGrant, right: MediaSourceGrant): boolean {
  return (
    left.routeGuid === right.routeGuid &&
    left.routeLifetime === right.routeLifetime &&
    left.pageLifetime === right.pageLifetime &&
    left.attachmentGuid === right.attachmentGuid &&
    left.localPath === right.localPath &&
    left.mimeType === right.mimeType
  );
}

/**
 * The attachment on the active page: the gallery item at the page index, or the single opened
 * attachment when there is no gallery. Never falls back from an invalid gallery index to the opened
 * attachment, so an action can only target media that is actually visible.
 */
export function activePageAttachment(loaded: LoadedMedia): AttachmentRow | null {
  return loaded.gallery ? (loaded.gallery.items[loaded.pageIndex] ?? null) : loaded.attachment;
}

/** `loaded` with the active page's snapshot row replaced by a fresh read, marked ready. */
export function withRefreshedActivePage(
  loaded: LoadedMedia,
  attachment: AttachmentRow,
): LoadedMedia {
  const gallery = loaded.gallery
    ? {
        ...loaded.gallery,
        items: loaded.gallery.items.map((item, index) =>
          index === loaded.pageIndex ? attachment : item,
        ),
      }
    : null;
  return {
    ...loaded,
    attachment: loaded.attachment?.guid === attachment.guid ? attachment : loaded.attachment,
    gallery,
    pageStatus: 'ready',
  };
}
