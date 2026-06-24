import React, { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshControl, type RefreshControlProps } from 'react-native';
import { logger } from '@core/secure';
import { useTheme } from '../theme';

/**
 * Pull-to-refresh state + a ready-to-use, STABLE `refreshControl` element for a FlashList,
 * themed to the active preset (the RN default spinner is near-invisible on OLED-dark).
 *
 * `run` is invoked on pull and the spinner stays up until it settles; errors are swallowed
 * (logged) so it always clears, and an in-flight guard drops overlapping pulls.
 *
 * Two stability guarantees that matter for FlashList v2: `onRefresh` is stable across renders
 * (it reads `run` through a ref, so an inline `() => …` from the caller is fine), and the
 * returned `refreshControl` element keeps a stable identity except when `refreshing` flips.
 * FlashList's `useSecondaryProps` memoizes on the refreshControl's identity — handing it a
 * fresh element every render (the lists re-render constantly during sync) made it never commit
 * its layout ("Exceeded max renders without commit" → blank list).
 */
export function usePullToRefresh(
  run: () => Promise<unknown>,
  progressViewOffset?: number,
): { refreshing: boolean; onRefresh: () => void; refreshControl: React.ReactElement<RefreshControlProps> } {
  const theme = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;

  const onRefresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    void Promise.resolve()
      .then(() => runRef.current())
      .catch((e) => logger.warn('[refresh] failed', e))
      .finally(() => {
        inFlight.current = false;
        setRefreshing(false);
      });
  }, []);

  const refreshControl = useMemo(
    () => (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={theme.color.tint}
        colors={[theme.color.tint]}
        progressBackgroundColor={theme.color.secondaryBackground}
        progressViewOffset={progressViewOffset}
      />
    ),
    [refreshing, onRefresh, progressViewOffset, theme],
  );

  return { refreshing, onRefresh, refreshControl };
}
