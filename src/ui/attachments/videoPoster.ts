import { createVideoPlayer, type VideoThumbnail } from 'expo-video';

/**
 * In-bubble video posters, made one at a time.
 *
 * Every native player loads its video and holds decoder buffers on the Java heap. Creating one per
 * bubble (the old `useVideoPlayer` in each row) let a chat with a few large videos allocate them
 * all at once and crash with an OutOfMemoryError while drawing (seen on the owner's Pixel with
 * 60–80 MB group videos, 2026-11-02). A poster needs a player only long enough to read one frame,
 * so each request gets a short-lived player that is released before the next request starts.
 */

const MAX_CACHED_POSTERS = 64;
const posters = new Map<string, VideoThumbnail>();
let queue: Promise<unknown> = Promise.resolve();

/** A cached poster for this attachment, or undefined when none has been made yet. */
export function cachedVideoPoster(attachmentGuid: string): VideoThumbnail | undefined {
  return posters.get(attachmentGuid);
}

/**
 * The first frame of a local video at most 600 px wide, or null when it can't be read. Requests run
 * strictly one after another, and each one's player is released before the next begins.
 */
export function requestVideoPoster(
  attachmentGuid: string,
  localPath: string,
): Promise<VideoThumbnail | null> {
  const cached = posters.get(attachmentGuid);
  if (cached) return Promise.resolve(cached);
  const run = queue.then(async () => {
    const already = posters.get(attachmentGuid);
    if (already) return already;
    let player: ReturnType<typeof createVideoPlayer> | null = null;
    try {
      player = createVideoPlayer(localPath);
      const [first] = await player.generateThumbnailsAsync([0], { maxWidth: 600 });
      if (!first) return null;
      posters.set(attachmentGuid, first);
      // Oldest first: Map keeps insertion order, so the first key is the least recently made.
      if (posters.size > MAX_CACHED_POSTERS) {
        const oldest = posters.keys().next().value;
        if (oldest !== undefined) posters.delete(oldest);
      }
      return first;
    } catch {
      // Unsupported codec, unreadable file or a released player: keep the gray poster.
      return null;
    } finally {
      try {
        player?.release();
      } catch {
        // Already released.
      }
    }
  });
  // A failed request must not stall the ones queued behind it.
  queue = run.catch(() => undefined);
  return run;
}
