import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runDevPerf02InboxBenchmark, type Perf02RenderFixtureSource } from '@/services';
import type { InboxQueryTiming } from '@features/conversations/useChats';
import { useTheme } from '../theme';
import { ConversationListScreen, type InboxBenchmarkProbe } from './ConversationListScreen';

const INITIAL_SAMPLES = 20;
const ARRIVAL_SAMPLES = 20;
const SUSTAINED_BURST_END = 100;
const SUSTAINED_BURST_INTERVAL_MS = 40;
const MAX_DEVICE_QUERY_START_GAP_MS = 500;
const MAX_DEVICE_PUBLICATION_GAP_MS = 750;
const GATE_TIMEOUT_MS = 12_000;

interface Display {
  id: number;
  source: Perf02RenderFixtureSource;
  chats: 1_000 | 10_000;
  scrollToIndex?: number;
  scrollRequest?: number;
}

interface Measurement {
  queryStartDelayMs: number;
  queryMs: number;
  publicationMs: number;
  publicationAfterQueryMs: number;
  afterQueryMs: number;
  frameFenceMs: number;
  visibleMs: number;
  queryStarts: number;
  publications: number;
  maxQueryStartGapMs: number;
  maxPublicationGapMs: number;
}

interface Gate {
  id: number;
  kind: 'initial' | 'scroll' | 'deep' | 'arrival' | 'sustained';
  expectedGuid?: string;
  targetIndex?: number;
  minimumRows?: number;
  scrollRequest?: number;
  scrollSettled: boolean;
  startedAtMs: number;
  windowStartedAtMs: number;
  query?: InboxQueryTiming;
  queryStartedAt: number[];
  publications: { guid: string; atMs: number }[];
  visibleRows: readonly { guid: string; index: number | null }[];
  completing: boolean;
  interimQueries: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: Measurement) => void;
  reject: (error: Error) => void;
}

interface ScaleReport {
  chats: number;
  initialP95Ms: number;
  initialPublicationP95Ms: number;
  queryP95Ms: number;
  initialAfterQueryP95Ms: number;
  arrivalP95Ms: number;
  arrivalPublicationP95Ms: number;
  arrivalStartDelayP95Ms: number;
  arrivalQueryP95Ms: number;
  arrivalPublicationAfterQueryP95Ms: number;
  arrivalAfterQueryP95Ms: number;
  frameFenceP95Ms: number;
  sustainedFinalVisibleMs: number;
  sustainedQueryStarts: number;
  sustainedPublications: number;
  sustainedMaxQueryStartGapMs: number;
  sustainedMaxPublicationGapMs: number;
  maxLoadedRows: number;
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

function maximumGap(startedAtMs: number, observations: readonly number[]): number {
  let previous = startedAtMs;
  let maximum = 0;
  for (const observedAtMs of observations) {
    maximum = Math.max(maximum, observedAtMs - previous);
    previous = observedAtMs;
  }
  return rounded(maximum);
}

function arrivedChatGuid(revision: number): string {
  const chatId = revision + Math.floor((revision - 1) / 19);
  return `iMessage;-;benchmark-${chatId}`;
}

/** DEV-only physical Android probe using the real inbox hook, FlashList, and tile tree. */
export function PerfInboxBenchmarkScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const mountedRef = useRef(true);
  const nextIdRef = useRef(0);
  const maxLoadedRowsRef = useRef(0);
  const gateRef = useRef<Gate | null>(null);
  const continueRef = useRef<(() => void) | null>(null);
  const unmountResolveRef = useRef<(() => void) | null>(null);
  const [display, setDisplay] = useState<Display | null>(null);
  const [status, setStatus] = useState('Preparing disposable fixture…');
  const [reports, setReports] = useState<ScaleReport[]>([]);
  const [canContinue, setCanContinue] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (display !== null) return;
    // Passive effects run after the old list's subscription cleanup has committed.
    unmountResolveRef.current?.();
    unmountResolveRef.current = null;
  }, [display]);

  const settleGate = useCallback((gate: Gate, result: Measurement): void => {
    if (gateRef.current !== gate) return;
    gateRef.current = null;
    clearTimeout(gate.timeout);
    gate.resolve(result);
  }, []);

  const tryComplete = useCallback(
    (gate: Gate): void => {
      if (gateRef.current !== gate || gate.completing) return;
      let publishedAtMs: number | undefined;
      if (gate.kind === 'scroll') {
        if (
          !gate.scrollSettled ||
          !gate.query ||
          gate.query.rowCount < (gate.minimumRows ?? 0) ||
          !gate.visibleRows.some(
            (row) => row.index != null && row.index >= (gate.targetIndex ?? 0) - 2,
          )
        ) {
          return;
        }
      } else if (gate.kind === 'deep') {
        if (
          !gate.scrollSettled ||
          gate.visibleRows.length === 0 ||
          !gate.expectedGuid ||
          gate.visibleRows.some((row) => row.guid === gate.expectedGuid) ||
          !gate.visibleRows.some(
            (row) => row.index != null && row.index >= (gate.targetIndex ?? 0) - 2,
          )
        ) {
          return;
        }
      } else {
        const expectedGuid = gate.kind === 'initial' ? gate.query?.firstGuid : gate.expectedGuid;
        const expectedPublication = gate.publications.find(
          (publication) => publication.guid === expectedGuid,
        );
        if (!gate.query || !expectedGuid || !expectedPublication) {
          return;
        }
        publishedAtMs = expectedPublication.atMs;
        // Initial draw and deep re-land must actually bring row 0 into the viewport. During a
        // sustained burst that viewport remains at index 0, so FlashList may not emit another
        // "visible indices changed" callback; the committed row-0 identity is authoritative.
        if (
          gate.kind !== 'sustained' &&
          !gate.visibleRows.some((row) => row.guid === expectedGuid && row.index === 0)
        )
          return;
        if (
          (gate.kind === 'arrival' || gate.kind === 'sustained') &&
          gate.query.firstGuid !== expectedGuid
        ) {
          return;
        }
      }
      gate.completing = true;
      const observedAtMs = performance.now();
      const resolvedPublishedAtMs = publishedAtMs ?? observedAtMs;
      // Two display frames after FlashList reports the row as viewable approximate visible draw.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (gateRef.current !== gate) return;
          const visibleAtMs = performance.now();
          const publicationTimes = gate.publications.map((publication) => publication.atMs);
          const measurementStartMs =
            gate.kind === 'initial' ? gate.query!.startedAtMs : gate.startedAtMs;
          settleGate(gate, {
            queryStartDelayMs: gate.query
              ? Math.max(0, gate.query.startedAtMs - gate.startedAtMs)
              : 0,
            queryMs: gate.query ? gate.query.finishedAtMs - gate.query.startedAtMs : 0,
            publicationMs: Math.max(0, resolvedPublishedAtMs - measurementStartMs),
            publicationAfterQueryMs: gate.query
              ? Math.max(0, resolvedPublishedAtMs - gate.query.finishedAtMs)
              : 0,
            afterQueryMs: gate.query ? Math.max(0, observedAtMs - gate.query.finishedAtMs) : 0,
            frameFenceMs: visibleAtMs - observedAtMs,
            visibleMs: visibleAtMs - measurementStartMs,
            queryStarts: gate.queryStartedAt.length,
            publications: gate.publications.length,
            maxQueryStartGapMs: maximumGap(gate.windowStartedAtMs, gate.queryStartedAt),
            maxPublicationGapMs: maximumGap(gate.windowStartedAtMs, publicationTimes),
          });
        }),
      );
    },
    [settleGate],
  );

  const onQueryTiming = useCallback(
    (id: number, timing: InboxQueryTiming): void => {
      maxLoadedRowsRef.current = Math.max(maxLoadedRowsRef.current, timing.rowCount);
      const gate = gateRef.current;
      if (!gate || gate.id !== id || gate.kind === 'deep') return;
      gate.queryStartedAt.push(timing.startedAtMs);
      if (gate.kind === 'scroll') {
        gate.query = timing;
        tryComplete(gate);
        return;
      }
      if (gate.kind === 'initial' && timing.rowCount !== 50) return;
      if (gate.kind === 'sustained' && timing.firstGuid !== gate.expectedGuid) {
        gate.interimQueries += 1;
        return;
      }
      if (gate.kind === 'arrival' && timing.firstGuid !== gate.expectedGuid) return;
      gate.query = timing;
      tryComplete(gate);
    },
    [tryComplete],
  );

  const onVisibleRows = useCallback(
    (id: number, rows: readonly { guid: string; index: number | null }[]): void => {
      const gate = gateRef.current;
      if (!gate || gate.id !== id) return;
      gate.visibleRows = rows;
      tryComplete(gate);
    },
    [tryComplete],
  );

  const onTopRowPublished = useCallback(
    (id: number, guid: string): void => {
      const gate = gateRef.current;
      if (!gate || gate.id !== id || gate.kind === 'deep' || gate.kind === 'scroll') return;
      gate.publications.push({ guid, atMs: performance.now() });
      tryComplete(gate);
    },
    [tryComplete],
  );

  const onScrollSettled = useCallback(
    (id: number, request: number, succeeded: boolean): void => {
      const gate = gateRef.current;
      if (!gate || gate.id !== id || gate.scrollRequest !== request) return;
      if (!succeeded) {
        clearTimeout(gate.timeout);
        gateRef.current = null;
        gate.reject(new Error('PERF-02 FlashList scroll request failed.'));
        return;
      }
      gate.scrollSettled = true;
      tryComplete(gate);
    },
    [tryComplete],
  );

  const waitFor = useCallback(
    (
      id: number,
      kind: Gate['kind'],
      options: {
        expectedGuid?: string;
        targetIndex?: number;
        minimumRows?: number;
        scrollRequest?: number;
      } = {},
    ): Promise<Measurement> =>
      new Promise((resolve, reject) => {
        if (gateRef.current) {
          reject(new Error('PERF-02 measurement overlap.'));
          return;
        }
        const gate: Gate = {
          id,
          kind,
          expectedGuid: options.expectedGuid,
          targetIndex: options.targetIndex,
          minimumRows: options.minimumRows,
          scrollRequest: options.scrollRequest,
          scrollSettled: options.scrollRequest == null,
          startedAtMs: performance.now(),
          windowStartedAtMs: performance.now(),
          visibleRows: [],
          queryStartedAt: [],
          publications: [],
          completing: false,
          interimQueries: 0,
          timeout: setTimeout(() => {
            if (gateRef.current !== gate) return;
            gateRef.current = null;
            reject(
              new Error(
                `PERF-02 ${kind} visibility timed out (query: ${gate.query?.firstGuid ?? 'none'}, published: ${gate.publications.at(-1)?.guid ?? 'none'}, visible: ${gate.visibleRows[0]?.guid ?? 'none'}, interim queries: ${gate.interimQueries}).`,
              ),
            );
          }, GATE_TIMEOUT_MS),
          resolve,
          reject,
        };
        gateRef.current = gate;
      }),
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const abort = new AbortController();
    const cancel = (reason: string): void => {
      if (abort.signal.aborted) return;
      abort.abort();
      const gate = gateRef.current;
      if (gate) {
        clearTimeout(gate.timeout);
        gateRef.current = null;
        gate.reject(new Error(reason));
      }
      continueRef.current?.();
      continueRef.current = null;
      unmountResolveRef.current?.();
      unmountResolveRef.current = null;
      if (mountedRef.current) {
        setCanContinue(false);
        setDisplay(null);
        setError(reason);
      }
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active')
        cancel('PERF-02 measurement cancelled when Android left the foreground.');
    });
    const runScale = async (
      source: Perf02RenderFixtureSource,
      chats: 1_000 | 10_000,
    ): Promise<void> => {
      maxLoadedRowsRef.current = 0;
      const initial: Measurement[] = [];
      setStatus(`${chats.toLocaleString()} chats: ${INITIAL_SAMPLES} initial draw samples…`);
      for (let sample = 1; sample <= INITIAL_SAMPLES; sample += 1) {
        if (abort.signal.aborted) throw new Error('PERF-02 benchmark was cancelled.');
        const id = ++nextIdRef.current;
        const visible = waitFor(id, 'initial');
        setDisplay({ id, source, chats });
        initial.push(await visible);
      }

      const id = nextIdRef.current;
      const topGuid = `iMessage;-;benchmark-${chats - 1}`;
      setStatus(`${chats.toLocaleString()} chats: loading four bounded pages…`);
      const scrollSteps = [
        // Enter the last few rows of each loaded prefix to trigger FlashList's real
        // onEndReached path; a mid-page jump is not guaranteed to request the next page.
        { index: 43, rows: 100 },
        { index: 93, rows: 150 },
        { index: 143, rows: 200 },
      ] as const;
      for (let step = 0; step < scrollSteps.length; step += 1) {
        const target = scrollSteps[step]!;
        const scrolled = waitFor(id, 'scroll', {
          targetIndex: target.index,
          minimumRows: target.rows,
          scrollRequest: step + 1,
        });
        setDisplay((current) =>
          current ? { ...current, scrollToIndex: target.index, scrollRequest: step + 1 } : current,
        );
        await scrolled;
      }
      const deep = waitFor(id, 'deep', {
        expectedGuid: topGuid,
        targetIndex: 175,
        scrollRequest: 4,
      });
      setDisplay((current) =>
        current ? { ...current, scrollToIndex: 175, scrollRequest: 4 } : current,
      );
      await deep;

      const arrivals: Measurement[] = [];
      setStatus(`${chats.toLocaleString()} chats: ${ARRIVAL_SAMPLES} deep re-land samples…`);
      for (let revision = 1; revision <= ARRIVAL_SAMPLES; revision += 1) {
        if (revision > 1) {
          const away = waitFor(id, 'deep', {
            expectedGuid: arrivedChatGuid(revision - 1),
            targetIndex: 175,
            scrollRequest: revision + 3,
          });
          setDisplay((current) =>
            current ? { ...current, scrollToIndex: 175, scrollRequest: revision + 3 } : current,
          );
          await away;
        }
        const arrival = waitFor(id, 'arrival', {
          expectedGuid: arrivedChatGuid(revision),
        });
        await source.bump(revision);
        arrivals.push(await arrival);
      }

      setStatus(`${chats.toLocaleString()} chats: sustained native writes…`);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const sustained = waitFor(id, 'sustained', {
        expectedGuid: arrivedChatGuid(SUSTAINED_BURST_END),
      });
      for (let revision = ARRIVAL_SAMPLES + 1; revision <= SUSTAINED_BURST_END; revision += 1) {
        if (revision === SUSTAINED_BURST_END && gateRef.current) {
          gateRef.current.startedAtMs = performance.now();
        }
        await source.bump(revision);
        if (revision < SUSTAINED_BURST_END) {
          await new Promise((resolve) => setTimeout(resolve, SUSTAINED_BURST_INTERVAL_MS));
        }
      }
      const sustainedResult = await sustained;
      if (sustainedResult.queryStarts < 2 || sustainedResult.publications < 2) {
        throw new Error('PERF-02 sustained writes did not publish intermediate inbox states.');
      }
      if (sustainedResult.maxQueryStartGapMs > MAX_DEVICE_QUERY_START_GAP_MS) {
        throw new Error('PERF-02 sustained writes starved the native query refresh.');
      }
      if (sustainedResult.maxPublicationGapMs > MAX_DEVICE_PUBLICATION_GAP_MS) {
        throw new Error('PERF-02 sustained writes starved rendered publication.');
      }
      if (maxLoadedRowsRef.current !== 200) {
        throw new Error('PERF-02 long scroll did not retain exactly four requested pages.');
      }
      const report: ScaleReport = {
        chats,
        initialP95Ms: rounded(p95(initial.map((sample) => sample.visibleMs))),
        initialPublicationP95Ms: rounded(p95(initial.map((sample) => sample.publicationMs))),
        queryP95Ms: rounded(p95(initial.map((sample) => sample.queryMs))),
        initialAfterQueryP95Ms: rounded(p95(initial.map((sample) => sample.afterQueryMs))),
        arrivalP95Ms: rounded(p95(arrivals.map((sample) => sample.visibleMs))),
        arrivalPublicationP95Ms: rounded(p95(arrivals.map((sample) => sample.publicationMs))),
        arrivalStartDelayP95Ms: rounded(p95(arrivals.map((sample) => sample.queryStartDelayMs))),
        arrivalQueryP95Ms: rounded(p95(arrivals.map((sample) => sample.queryMs))),
        arrivalPublicationAfterQueryP95Ms: rounded(
          p95(arrivals.map((sample) => sample.publicationAfterQueryMs)),
        ),
        arrivalAfterQueryP95Ms: rounded(p95(arrivals.map((sample) => sample.afterQueryMs))),
        frameFenceP95Ms: rounded(
          p95([...initial, ...arrivals].map((sample) => sample.frameFenceMs)),
        ),
        sustainedFinalVisibleMs: rounded(sustainedResult.visibleMs),
        sustainedQueryStarts: sustainedResult.queryStarts,
        sustainedPublications: sustainedResult.publications,
        sustainedMaxQueryStartGapMs: sustainedResult.maxQueryStartGapMs,
        sustainedMaxPublicationGapMs: sustainedResult.maxPublicationGapMs,
        maxLoadedRows: maxLoadedRowsRef.current,
      };
      setReports((current) => [...current, report]);
      setStatus(`${chats.toLocaleString()} chats complete. Sample Android memory, then continue.`);
      setCanContinue(true);
      await new Promise<void>((resolve) => {
        continueRef.current = resolve;
      });
      continueRef.current = null;
      setCanContinue(false);
      setDisplay(null);
      await new Promise<void>((resolve) => {
        unmountResolveRef.current = resolve;
      });
    };

    void runDevPerf02InboxBenchmark(runScale, abort.signal)
      .then(() => {
        if (mountedRef.current) setStatus('Measurement complete; disposable database deleted.');
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current || abort.signal.aborted) return;
        abort.abort();
        continueRef.current?.();
        continueRef.current = null;
        setCanContinue(false);
        setDisplay(null);
        setError(cause instanceof Error ? cause.message : 'Unknown measurement error.');
      });
    return () => {
      mountedRef.current = false;
      appStateSubscription.remove();
      cancel('PERF-02 benchmark was cancelled.');
    };
  }, [waitFor]);

  const probe = useMemo<InboxBenchmarkProbe | undefined>(
    () =>
      display
        ? {
            source: display.source,
            scrollToIndex: display.scrollToIndex,
            scrollRequest: display.scrollRequest,
            onQueryTiming: (timing) => onQueryTiming(display.id, timing),
            onVisibleRows: (rows) => onVisibleRows(display.id, rows),
            onTopRowPublished: (guid) => onTopRowPublished(display.id, guid),
            onScrollSettled: (request, succeeded) =>
              onScrollSettled(display.id, request, succeeded),
          }
        : undefined,
    [display, onQueryTiming, onScrollSettled, onTopRowPublished, onVisibleRows],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.color.background }]}>
      {probe ? (
        <View style={styles.list}>
          <ConversationListScreen key={display?.id} benchmark={probe} />
        </View>
      ) : null}
      <View
        style={[
          styles.panel,
          {
            backgroundColor: theme.color.secondaryBackground,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        <Text style={[styles.status, { color: theme.color.label }]}>{error ?? status}</Text>
        {reports.map((report) => (
          <Text key={report.chats} style={{ color: theme.color.secondaryLabel }}>
            {report.chats.toLocaleString()}: draw p95 {report.initialP95Ms} ms, query p95{' '}
            {report.queryP95Ms} ms, publication p95 {report.initialPublicationP95Ms} ms, draw
            after-query p95 {report.initialAfterQueryP95Ms} ms, re-land p95 {report.arrivalP95Ms} ms
            / publication {report.arrivalPublicationP95Ms} ms (start wait{' '}
            {report.arrivalStartDelayP95Ms}, query {report.arrivalQueryP95Ms}, publication
            after-query {report.arrivalPublicationAfterQueryP95Ms}, completion gate after-query{' '}
            {report.arrivalAfterQueryP95Ms}), frame fence {report.frameFenceP95Ms} ms, sustained
            final {report.sustainedFinalVisibleMs} ms, query starts {report.sustainedQueryStarts},
            row publications {report.sustainedPublications}, max query/publication gaps{' '}
            {report.sustainedMaxQueryStartGapMs}/{report.sustainedMaxPublicationGapMs} ms, max rows{' '}
            {report.maxLoadedRows}
          </Text>
        ))}
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" onPress={() => router.back()}>
            <Text style={{ color: theme.color.tint }}>Back</Text>
          </Pressable>
          {canContinue ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                continueRef.current?.();
              }}
            >
              <Text style={{ color: theme.color.tint }}>Continue</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1 },
  panel: { paddingHorizontal: 16, paddingVertical: 12, gap: 6 },
  status: { fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 4 },
});
