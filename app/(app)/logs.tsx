import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { memoryLogSink, type LogEntry } from '@core/secure';
import { fileLogSink } from '@/services/logging/fileLogSink';
import { formatTime } from '@utils';
import { Screen, ScreenHeader, useTheme } from '@ui';

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

/** Entries matching the level filter ('info' folds in debug — both are chatty diagnostics). */
export function filterLogEntries(entries: LogEntry[], filter: LevelFilter): LogEntry[] {
  if (filter === 'all') return entries;
  if (filter === 'info') return entries.filter((e) => e.level === 'info' || e.level === 'debug');
  return entries.filter((e) => e.level === filter);
}

/**
 * In-app log viewer over the redacting logger's memory buffer (Settings → App Logs): level
 * filter chips, Share (attach to a bug report), and Clear. Everything shown is already redacted.
 */
export default function LogsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [filter, setFilter] = useState<LevelFilter>('all');
  // The buffer isn't reactive — snapshot on mount / after clear; Refresh re-snapshots.
  const [entries, setEntries] = useState<LogEntry[]>(() => memoryLogSink.entries());
  const refresh = useCallback(() => setEntries(memoryLogSink.entries()), []);

  const visible = filterLogEntries(entries, filter);

  const levelColor = (level: LogEntry['level']): string =>
    level === 'error'
      ? theme.color.destructive
      : level === 'warn'
        ? '#FF9500'
        : theme.color.secondaryLabel;

  const onShare = (): void => {
    const text = visible
      .slice()
      .reverse() // chronological for reading
      .map(
        (e) =>
          `${new Date(e.timestamp).toISOString()} [${e.level}] ${e.message}${e.meta ? ` ${e.meta}` : ''}`,
      )
      .join('\n');
    if (text) void Share.share({ message: text });
  };

  const onClear = (): void => {
    memoryLogSink.clear();
    void fileLogSink.clear(); // also purge the on-disk history, not just this session's buffer
    refresh();
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

      <View style={styles.controls}>
        {(['all', 'info', 'warn', 'error'] as const).map((f) => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[
              styles.chip,
              {
                backgroundColor: filter === f ? theme.color.tint : theme.color.secondaryBackground,
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
        <View style={styles.controlsSpacer} />
        <Pressable onPress={onShare} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.controlAction, { color: theme.color.tint }]}>Share</Text>
        </Pressable>
        <Pressable onPress={onClear} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.controlAction, { color: theme.color.destructive }]}>Clear</Text>
        </Pressable>
      </View>

      <FlashList
        data={visible}
        keyExtractor={(e: LogEntry, i: number) => `${e.timestamp}-${i}`}
        renderItem={({ item }: { item: LogEntry }) => (
          <View style={[styles.row, { borderBottomColor: theme.color.separator }]}>
            <Text style={[styles.rowHead, { color: levelColor(item.level) }]}>
              {item.level.toUpperCase()} · {formatTime(item.timestamp)}
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
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  controlsSpacer: { flex: 1 },
  controlAction: { fontSize: 15, fontWeight: '600', marginLeft: 12 },
  row: { paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  rowHead: { fontSize: 11, fontWeight: '700', marginBottom: 2 },
  rowMsg: { fontSize: 13, lineHeight: 18 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
  listContent: { paddingBottom: 24 },
});
