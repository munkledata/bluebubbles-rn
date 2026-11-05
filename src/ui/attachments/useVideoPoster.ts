import { useCallback, useEffect, useState } from 'react';
import { loadVideoPoster } from '@/services/download/videoPosters';

export interface VideoPoster {
  /** Local URI of the server-made poster, or `null` while there is none to show. */
  readonly uri: string | null;
  /**
   * Call when the poster image fails to load (its file was cleared to keep the folder small, or
   * cannot be read). The tile fetches it once more; after a second failure it keeps its
   * blurhash/▶ look.
   */
  readonly onLoadError: () => void;
}

/**
 * A video attachment's server-made poster for one Shared Media tile. The tile keeps its
 * blurhash/▶ look until a poster arrives. Leaving the screen withdraws a request that is still
 * waiting its turn. Pass `enabled` only while the server reports `supports_video_poster`, and
 * never for RCS.
 */
export function useVideoPoster(guid: string, enabled: boolean): VideoPoster {
  const [loaded, setLoaded] = useState<{ readonly guid: string; readonly uri: string } | null>(
    null,
  );
  // 0 = first try, 1 = fetching again after a load error, 2 = gave up for this tile.
  const [attempt, setAttempt] = useState<{ readonly guid: string; readonly n: number }>({
    guid,
    n: 0,
  });
  const n = attempt.guid === guid ? attempt.n : 0;
  useEffect(() => {
    if (!enabled || n > 1) return undefined;
    const controller = new AbortController();
    void loadVideoPoster(guid, controller.signal, n === 1).then((uri) => {
      if (!controller.signal.aborted && uri) setLoaded({ guid, uri });
    });
    return () => controller.abort();
  }, [guid, enabled, n]);
  const onLoadError = useCallback(() => {
    setLoaded(null);
    setAttempt((previous) => ({ guid, n: (previous.guid === guid ? previous.n : 0) + 1 }));
  }, [guid]);
  const uri = enabled && n <= 1 && loaded?.guid === guid ? loaded.uri : null;
  return { uri, onLoadError };
}
