import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { memoryLogSink, projectErrorReportTimestamp, type LogEntry } from '@core/secure';
import { useForegroundBootState } from '@features/boot/useForegroundBootState';
import { resolvePersistentLogCleanupIssue } from '@/services/boot/foregroundBoot';
import { fileLogSink } from '@/services/logging/fileLogSink';
import { formatDiagnosticLogsForShare } from '@/services/logging/shareLogs';
import { formatTime } from '@utils';
import { Screen, ScreenHeader, useTheme } from '@ui';
import { showDialog } from '@ui/dialog/dialogStore';

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

/** Entries matching the level filter ('info' folds in debug — both are chatty diagnostics). */
export function filterLogEntries(entries: LogEntry[], filter: LevelFilter): LogEntry[] {
  if (filter === 'all') return entries;
  if (filter === 'info') return entries.filter((e) => e.level === 'info' || e.level === 'debug');
  return entries.filter((e) => e.level === filter);
}

/** Never let a corrupt legacy timestamp crash the diagnostic screen. */
export function formatLogEntryTime(timestamp: number): string {
  const safeTimestamp = projectErrorReportTimestamp(timestamp);
  return safeTimestamp === 0 ? 'UNKNOWN TIME' : formatTime(safeTimestamp);
}

/**
 * In-app log viewer over the logger's memory buffer (Settings → App Logs): level filter chips,
 * finite diagnostic Share (attach to a bug report), and Clear. ERROR and selected INFO event rows
 * are strictly projected; arbitrary non-error rows exist only in development and never cross the
 * share boundary.
 */
export default function LogsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const bootState = useForegroundBootState();
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [isClearing, setIsClearing] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  // The buffer isn't reactive — snapshot on mount / after clear; Refresh re-snapshots.
  const [entries, setEntries] = useState<LogEntry[]>(() => memoryLogSink.entries());
  const refresh = useCallback(() => setEntries(memoryLogSink.entries()), []);

  const visible = filterLogEntries(entries, filter);
  const shareableDiagnostics = useMemo(() => formatDiagnosticLogsForShare(entries), [entries]);
  const persistentCleanupIssue = bootState.issues.some(
    (issue) => issue.stage === 'persistent-logs' && issue.code === 'persistent-log-init-failed',
  );
  const cleanupMessage =
    'Older App Logs could not be verified safely. Tap Clear to remove the saved log file.';

  const levelColor = (level: LogEntry['level']): string =>
    level === 'error'
      ? theme.color.destructive
      : level === 'warn'
        ? '#FF9500'
        : theme.color.secondaryLabel;

  const onShare = (): void => {
    if (!shareableDiagnostics || isClearing || isSharing) return;
    setIsSharing(true);
    void Share.share({ message: shareableDiagnostics })
      .catch(() => {
        showDialog('App Logs', 'Gator could not open the share sheet. Please try again.');
      })
      .finally(() => {
        setIsSharing(false);
      });
  };

  const onClear = (): void => {
    if (isClearing || isSharing) return;
    setIsClearing(true);
    void fileLogSink
      .clear()
      .then((cleared) => {
        if (cleared) {
          // Keep the current snapshot visible until native storage confirms that the plaintext
          // file is gone. A failed Clear must not make the UI claim success.
          memoryLogSink.clear();
          refresh();
          // Retire the process-owned issue even if it appeared while native Clear was pending.
          // A late boot-time rejection also observes the sink's confirmed-cleanup fence.
          resolvePersistentLogCleanupIssue();
        } else {
          showDialog(
            'App Logs',
            'Gator could not remove the saved log file. Restart the app and tap Clear again before sharing this device.',
          );
        }
      })
      .catch(() => {
        showDialog(
          'App Logs',
          'Gator could not remove the saved log file. Restart the app and tap Clear again before sharing this device.',
        );
      })
      .finally(() => {
        setIsClearing(false);
      });
  };

  return (
    <Screen>
      <ScreenHeader
        title="App Logs"
        onBack={() => router.back()}
        right={
          <Pressable onPress={refresh} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.headerAction, { color: theme.color.tint }]}>Refresh</Text>
          </Pressable>
        }
      />

      {persistentCleanupIssue ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={cleanupMessage}
          style={[
            styles.cleanupWarning,
            {
              backgroundColor: theme.color.secondaryBackground,
              borderColor: theme.color.destructive,
            },
          ]}
        >
          <Text style={[styles.cleanupTitle, { color: theme.color.destructive }]}>
            Cleanup needed
          </Text>
          <Text style={[styles.cleanupMessage, { color: theme.color.label }]}>
            {cleanupMessage}
          </Text>
        </View>
      ) : null}

      <View style={styles.controls}>
        <View testID="log-filter-controls" style={styles.filterControls}>
          {(['all', 'info', 'warn', 'error'] as const).map((f) => (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              style={[
                styles.chip,
                {
                  backgroundColor:
                    filter === f ? theme.color.tint : theme.color.secondaryBackground,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === f }}
            >
              <Text style={{ color: filter === f ? '#fff' : theme.color.label, fontSize: 13 }}>
                {f.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
        <View testID="log-action-controls" style={styles.actionControls}>
          <Pressable
            style={styles.actionButton}
            onPress={onShare}
            disabled={!shareableDiagnostics || isClearing || isSharing}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{
              disabled: !shareableDiagnostics || isClearing || isSharing,
              busy: isSharing,
            }}
          >
            <Text
              style={[
                styles.controlAction,
                {
                  color:
                    shareableDiagnostics && !isClearing && !isSharing
                      ? theme.color.tint
                      : theme.color.tertiaryLabel,
                },
              ]}
            >
              Share diagnostics
            </Text>
          </Pressable>
          <Pressable
            style={styles.actionButton}
            onPress={onClear}
            disabled={isClearing || isSharing}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ disabled: isClearing || isSharing, busy: isClearing }}
          >
            <Text
              style={[
                styles.controlAction,
                { color: isClearing ? theme.color.tertiaryLabel : theme.color.destructive },
              ]}
            >
              Clear
            </Text>
          </Pressable>
        </View>
      </View>

      <FlashList
        data={visible}
        keyExtractor={(e: LogEntry, i: number) => `${e.timestamp}-${i}`}
        renderItem={({ item }: { item: LogEntry }) => (
          <View style={[styles.row, { borderBottomColor: theme.color.separator }]}>
            <Text style={[styles.rowHead, { color: levelColor(item.level) }]}>
              {item.level.toUpperCase()} · {formatLogEntryTime(item.timestamp)}
            </Text>
            <Text selectable style={[styles.rowMsg, { color: theme.color.label }]}>
              {item.message}
              {item.meta ? ` ${item.meta}` : ''}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>
            No log entries yet
          </Text>
        }
        contentContainerStyle={styles.listContent}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerAction: { fontSize: 15, textAlign: 'right' },
  cleanupWarning: {
    marginHorizontal: 14,
    marginTop: 10,
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
  },
  cleanupTitle: { fontSize: 15, fontWeight: '700', marginBottom: 4 },
  cleanupMessage: { fontSize: 14, lineHeight: 19 },
  controls: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  filterControls: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 16,
  },
  chip: {
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButton: {
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: 4,
    justifyContent: 'center',
  },
  controlAction: { fontSize: 15, fontWeight: '600' },
  row: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  rowHead: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
  rowMsg: { fontSize: 13, lineHeight: 18 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
  listContent: { paddingBottom: 24 },
});
