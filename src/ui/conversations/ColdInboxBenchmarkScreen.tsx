import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deleteDevPerf01ColdFixture,
  openDevPerf01ColdFixture,
  prepareDevPerf01ColdFixture,
  type Perf01ColdFixtureHandle,
} from '@/services';
import type { InboxQueryTiming } from '@features/conversations/useChats';
import { useTheme } from '../theme';
import { ConversationListScreen, type InboxBenchmarkProbe } from './ConversationListScreen';

type Scale = 1_000 | 10_000;

// Navigation must not reset these guards. A process restart is required between seeding and
// measuring, and again between samples. The operator also verifies the native PID externally.
let preparedInThisProcess = false;
let measuredInThisProcess = false;

function markMeasuredInThisProcess(): void {
  measuredInThisProcess = true;
}

interface ActiveRun {
  chats: Scale;
  handle: Perf01ColdFixtureHandle;
  query?: InboxQueryTiming;
  publishedAtMs?: number;
  visible: boolean;
  finishing: boolean;
  timeout: ReturnType<typeof setTimeout>;
}

function rounded(value: number): number {
  return Number(value.toFixed(1));
}

/** One cold-process sample per launch; the fixed fixture remains until explicit cleanup. */
export function ColdInboxBenchmarkScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const activeRef = useRef<ActiveRun | null>(null);
  const [probe, setProbe] = useState<InboxBenchmarkProbe | null>(null);
  const [status, setStatus] = useState('Prepare a fixture, restart Gator, then measure it.');
  const [busy, setBusy] = useState(false);
  const [measuredThisProcess, setMeasuredThisProcess] = useState(measuredInThisProcess);

  useEffect(
    () => () => {
      const run = activeRef.current;
      activeRef.current = null;
      if (run) {
        clearTimeout(run.timeout);
        void run.handle.close();
      }
    },
    [],
  );

  const prepare = (chats: Scale): void => {
    if (busy || activeRef.current) return;
    setBusy(true);
    setStatus(`Preparing isolated ${chats.toLocaleString()}-chat fixture…`);
    void prepareDevPerf01ColdFixture(chats)
      .then(() => {
        preparedInThisProcess = true;
        setStatus(
          `${chats.toLocaleString()} chats prepared. Stop the app process, verify a new PID, relaunch, then return here to measure.`,
        );
      })
      .catch((cause: unknown) =>
        setStatus(cause instanceof Error ? cause.message : 'Fixture preparation failed.'),
      )
      .finally(() => setBusy(false));
  };

  const measure = (chats: Scale): void => {
    if (busy || activeRef.current || measuredInThisProcess) return;
    if (preparedInThisProcess) {
      setStatus(
        'This fixture was prepared in the current process. Stop Gator and verify a new PID before measuring.',
      );
      return;
    }
    let handle: Perf01ColdFixtureHandle;
    try {
      handle = openDevPerf01ColdFixture(chats);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : 'Could not open the cold fixture.');
      return;
    }
    markMeasuredInThisProcess();
    setMeasuredThisProcess(true);
    setStatus(`Measuring first ${chats.toLocaleString()}-chat page…`);
    const expectedGuid = `iMessage;-;benchmark-${chats - 1}`;
    const fail = (run: ActiveRun, message: string): void => {
      if (activeRef.current !== run) return;
      activeRef.current = null;
      clearTimeout(run.timeout);
      setProbe(null);
      setStatus(message);
      void run.handle.close();
    };
    const complete = (run: ActiveRun): void => {
      if (
        activeRef.current !== run ||
        run.finishing ||
        !run.query ||
        run.publishedAtMs == null ||
        !run.visible
      ) {
        return;
      }
      run.finishing = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (activeRef.current !== run || !run.query || run.publishedAtMs == null) return;
          clearTimeout(run.timeout);
          const frameFenceAtMs = performance.now();
          setStatus(
            `${chats.toLocaleString()} chats: DB open ${rounded(run.handle.openMs)} ms; first query ${rounded(run.query.finishedAtMs - run.query.startedAtMs)} ms; query→row publication ${rounded(run.publishedAtMs - run.query.startedAtMs)} ms; DB-open→row publication ${rounded(run.publishedAtMs - run.handle.openedAtMs)} ms; two-frame visibility fence ${rounded(frameFenceAtMs - run.handle.openedAtMs)} ms. Save this result, then restart before another sample.`,
          );
        }),
      );
    };
    const run: ActiveRun = {
      chats,
      handle,
      visible: false,
      finishing: false,
      timeout: setTimeout(() => {
        fail(run, 'PERF-01 cold row did not publish within 15 seconds; restart before retrying.');
      }, 15_000),
    };
    activeRef.current = run;
    setProbe({
      source: handle.source,
      onQueryTiming: (timing) => {
        if (activeRef.current !== run || run.query) return;
        if (timing.rowCount !== 50 || timing.firstGuid !== expectedGuid) {
          fail(run, 'PERF-01 cold fixture returned the wrong first page.');
          return;
        }
        run.query = timing;
        complete(run);
      },
      onTopRowPublished: (guid) => {
        if (activeRef.current !== run || guid !== expectedGuid || run.publishedAtMs != null) return;
        run.publishedAtMs = performance.now();
        complete(run);
      },
      onVisibleRows: (rows) => {
        if (activeRef.current !== run) return;
        run.visible = rows.some((row) => row.index === 0 && row.guid === expectedGuid);
        complete(run);
      },
    });
  };

  const cleanup = (): void => {
    if (busy) return;
    setBusy(true);
    const run = activeRef.current;
    activeRef.current = null;
    setProbe(null);
    if (run) clearTimeout(run.timeout);
    void (async () => {
      try {
        await run?.handle.close();
        const failures: string[] = [];
        for (const chats of [1_000, 10_000] as const) {
          try {
            deleteDevPerf01ColdFixture(chats);
          } catch (cause) {
            failures.push(
              `${chats.toLocaleString()}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
            );
          }
        }
        setStatus(
          failures.length
            ? `Fixture cleanup incomplete: ${failures.join('; ')}`
            : 'Both disposable PERF-01 cold fixtures were deleted.',
        );
      } catch (cause) {
        setStatus(cause instanceof Error ? cause.message : 'Fixture cleanup failed.');
      } finally {
        setBusy(false);
      }
    })();
  };

  const action = (label: string, onPress: () => void, disabled = false): React.JSX.Element => (
    <Pressable
      key={label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, { backgroundColor: theme.color.tint, opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.color.background }]}>
      {probe ? (
        <View style={styles.list}>
          <ConversationListScreen benchmark={probe} />
        </View>
      ) : (
        <View style={styles.list} />
      )}
      <ScrollView
        style={[styles.panel, { backgroundColor: theme.color.secondaryBackground }]}
        contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
      >
        <Text selectable style={[styles.status, { color: theme.color.label }]}>
          {status}
        </Text>
        <View style={styles.actions}>
          {action('Prepare 1,000', () => prepare(1_000), busy || !!probe)}
          {action('Prepare 10,000', () => prepare(10_000), busy || !!probe)}
          {action('Measure 1,000', () => measure(1_000), busy || measuredThisProcess)}
          {action('Measure 10,000', () => measure(10_000), busy || measuredThisProcess)}
          {action('Delete fixtures', cleanup, busy)}
          {action('Back', () => router.back(), busy)}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1 },
  panel: { flexGrow: 0, maxHeight: 320, paddingHorizontal: 16, paddingTop: 12 },
  status: { fontSize: 14, marginBottom: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  buttonText: { color: '#fff', fontWeight: '600' },
});
