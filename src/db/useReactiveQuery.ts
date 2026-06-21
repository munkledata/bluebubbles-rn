import { useEffect, useRef, useState } from 'react';
import { logger } from '@core/secure';
import { getRawDatabase } from './database';

export interface ReactiveState<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
}

// Coalesce a burst of writes (e.g. a sync batch fires the reactive callback many
// times) into a single re-query.
const DEBOUNCE_MS = 24;

/**
 * Runs `run()` once, then re-runs it (debounced) whenever any of `tables`
 * mutates — using op-sqlite's `reactiveExecute` purely as a change trigger (a
 * cheap sentinel query whose result we ignore). This keeps full typing: `run` is
 * any async function (a Drizzle call or `db.all` raw SQL). Unsubscribes on
 * unmount.
 *
 * Writes must flush op-sqlite's pending reactive queries for this to fire; the
 * drizzle adapter in db/database.ts does that automatically after each write.
 *
 * Pass `deps` for inputs that should re-create the subscription/query. `run` is
 * read from a ref, so it need not be memoized.
 */
export function useReactiveQuery<T>(
  run: () => Promise<T>,
  tables: string[],
  deps: unknown[] = [],
): ReactiveState<T> {
  const [state, setState] = useState<ReactiveState<T>>({
    data: null,
    isLoading: true,
    error: null,
  });
  const runRef = useRef(run);
  runRef.current = run;
  const tablesKey = tables.join(',');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const exec = async (): Promise<void> => {
      try {
        const data = await runRef.current();
        if (!cancelled) setState({ data, isLoading: false, error: null });
      } catch (e) {
        if (!cancelled) {
          setState({
            data: null,
            isLoading: false,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      }
    };
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void exec(), DEBOUNCE_MS);
    };

    void exec(); // initial load, immediate

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = getRawDatabase().reactiveExecute({
        query: 'SELECT 1',
        arguments: [],
        fireOn: tablesKey.split(',').map((table) => ({ table })),
        callback: schedule,
      });
    } catch (e) {
      logger.debug('[db] reactive subscribe failed', e);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablesKey, ...deps]);

  return state;
}
