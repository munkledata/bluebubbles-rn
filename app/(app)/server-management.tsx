import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { serverApi } from '@core/api';
import { isUnimplementedEndpoint } from '@core/api/errors';
import { http, startSync } from '@/services';
import { useSessionStore } from '@state/sessionStore';
import { useSyncStore } from '@state/syncStore';
import { Screen, useTheme } from '@ui';

type Totals = { messages?: number; images?: number; videos?: number };

/** F-9: server administration — status, restarts, update check, manual sync, logs, stats. */
export default function ServerManagementScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const setServerInfo = useSessionStore((s) => s.setServerInfo);
  const syncStatus = useSyncStore((s) => s.status);
  // Select each primitive separately — an object-returning selector `(s) => ({...})` allocates a
  // fresh object every render, which useSyncExternalStore reads as a changed snapshot → infinite
  // re-render loop ("Maximum update depth exceeded"). zustand has no auto-shallow-compare.
  const syncChats = useSyncStore((s) => s.chats);
  const syncMessages = useSyncStore((s) => s.messages);

  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight action
  const [latency, setLatency] = useState<number | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [logs, setLogs] = useState<string | null>(null);

  // Measure round-trip latency on mount; guard against setState after unmount.
  useEffect(() => {
    let alive = true;
    const t0 = Date.now();
    void serverApi
      .ping(http)
      .then(() => {
        if (alive) {
          setLatency(Date.now() - t0);
          setReachable(true);
        }
      })
      .catch(() => {
        if (alive) {
          setReachable(false);
          setLatency(null);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // Statistics ARE served on the password path (admin-command dispatcher) — load them on mount.
  // Best-effort: on failure the section just shows placeholders, not an error.
  useEffect(() => {
    let alive = true;
    void serverApi
      .serverStatTotals(http)
      .then((t) => {
        if (alive) setTotals(t);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Refresh the cached server info (version / macOS / private-API). On a hydrated boot the
  // `connected` action never ran, so the session store still has serverInfo=null → "Unknown";
  // fetching it here populates the STATUS section (and the app-wide `privateApiEnabled` gate).
  useEffect(() => {
    let alive = true;
    void serverApi
      .serverInfo(http)
      .then((info) => {
        if (alive) setServerInfo(info);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [setServerInfo]);

  // Whether the connected server implements the admin routes (restart/update/stats/logs).
  // Gator implements none of them, so we hide those actions rather than fail with a 404.
  const adminSupported = serverApi.SERVER_MANAGEMENT_SUPPORTED;

  // Distinguish "this server doesn't support the action" from a real connection failure so
  // the copy isn't misleading (the old code blamed every 404 on the connection).
  const failCopy = (label: string, e: unknown): string =>
    isUnimplementedEndpoint(e)
      ? `${label} isn’t supported on this server.`
      : `Couldn’t ${label.toLowerCase()}. Check your connection.`;

  // Run an admin action with an in-flight guard; reports the outcome.
  const run = (label: string, fn: () => Promise<unknown>, okMsg: string): void => {
    if (busy) return;
    setBusy(label);
    void fn()
      .then(() => Alert.alert('Server', okMsg))
      .catch((e: unknown) => Alert.alert('Server', failCopy(label, e)))
      .finally(() => setBusy(null));
  };

  const confirmThen = (
    label: string,
    message: string,
    fn: () => Promise<unknown>,
    okMsg: string,
    destructive = false,
  ): void => {
    Alert.alert(label, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: label,
        style: destructive ? 'destructive' : 'default',
        onPress: () => run(label, fn, okMsg),
      },
    ]);
  };

  const onCheckUpdate = (): void => {
    if (busy) return;
    setBusy('Check for Updates');
    void serverApi
      .checkUpdate(http)
      .then((res) => {
        const available = res?.available;
        Alert.alert(
          'Updates',
          available ? 'A newer server version is available.' : 'Your server is up to date.',
        );
      })
      .catch((e: unknown) => Alert.alert('Server', failCopy('Check for updates', e)))
      .finally(() => setBusy(null));
  };

  const onLoadStats = (): void => {
    if (busy) return;
    setBusy('Load Stats');
    void serverApi
      .serverStatTotals(http)
      .then((res) => setTotals((res as Totals) ?? {}))
      .catch((e: unknown) => Alert.alert('Server', failCopy('Load statistics', e)))
      .finally(() => setBusy(null));
  };

  const onViewLogs = (): void => {
    if (busy) return;
    setBusy('View Logs');
    void serverApi
      .serverLogs(http, 500)
      .then((res) => {
        setLogs(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
      })
      .catch((e: unknown) => Alert.alert('Server', failCopy('Fetch logs', e)))
      .finally(() => setBusy(null));
  };

  const onSyncNow = (): void => {
    if (busy || syncStatus === 'syncing') return;
    void startSync();
  };

  return (
    <Screen>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.back, { color: theme.color.tint }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>Server Management</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Section label="STATUS" theme={theme}>
          <InfoRow label="Connection" theme={theme}>
            {reachable == null ? 'Checking…' : reachable ? 'Reachable' : 'Unreachable'}
            {latency != null ? ` · ${latency} ms` : ''}
          </InfoRow>
          <InfoRow label="Server version" theme={theme}>
            {serverInfo?.server_version ?? 'Unknown'}
          </InfoRow>
          <InfoRow label="macOS" theme={theme}>
            {serverInfo?.os_version ?? 'Unknown'}
          </InfoRow>
          <InfoRow label="Private API" theme={theme}>
            {serverInfo?.private_api ? 'Enabled' : 'Disabled'}
          </InfoRow>
          <InfoRow label="Proxy" theme={theme}>
            {serverInfo?.proxy_service ?? 'Direct'}
          </InfoRow>
          <InfoRow label="Sync" theme={theme}>
            {syncStatus === 'syncing'
              ? `Syncing… (${syncChats} chats, ${syncMessages} msgs)`
              : syncStatus === 'done'
                ? `Up to date (${syncMessages} msgs)`
                : syncStatus === 'error'
                  ? 'Error'
                  : 'Idle'}
          </InfoRow>
        </Section>

        <Section label="ACTIONS" theme={theme}>
          <ActionRow
            label="Sync Now"
            theme={theme}
            disabled={syncStatus === 'syncing'}
            onPress={onSyncNow}
          />
          {adminSupported ? (
            <>
              <ActionRow
                label="Restart iMessage"
                theme={theme}
                disabled={!!busy}
                busy={busy === 'Restart iMessage'}
                onPress={() =>
                  confirmThen(
                    'Restart iMessage',
                    'Restart the Messages app on the Mac?',
                    () => serverApi.restartImessage(http),
                    'Messages is restarting.',
                  )
                }
              />
              <ActionRow
                label="Restart Services"
                theme={theme}
                disabled={!!busy}
                busy={busy === 'Restart Services'}
                onPress={() =>
                  confirmThen(
                    'Restart Services',
                    'Soft-restart the server services (Private API)?',
                    () => serverApi.softRestart(http),
                    'Services are restarting.',
                  )
                }
              />
              <ActionRow
                label="Restart Server"
                theme={theme}
                destructive
                disabled={!!busy}
                busy={busy === 'Restart Server'}
                onPress={() =>
                  confirmThen(
                    'Restart Server',
                    'Fully restart the server process? This will briefly drop your connection.',
                    () => serverApi.hardRestart(http),
                    'The server is restarting — reconnecting shortly.',
                    true,
                  )
                }
              />
              <ActionRow
                label="Check for Updates"
                theme={theme}
                disabled={!!busy}
                busy={busy === 'Check for Updates'}
                onPress={onCheckUpdate}
              />
              <ActionRow
                label="View Server Logs"
                theme={theme}
                disabled={!!busy}
                busy={busy === 'View Logs'}
                onPress={onViewLogs}
              />
            </>
          ) : (
            <View style={[styles.row, { borderTopColor: theme.color.separator }]}>
              <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel, textAlign: 'left' }]}>
                Restart, update check, and logs are managed from the server console (not exposed to
                remote clients).
              </Text>
            </View>
          )}
        </Section>

        <Section label="STATISTICS" theme={theme}>
          <InfoRow label="Messages" theme={theme}>
            {totals ? String(totals.messages ?? 0) : '—'}
          </InfoRow>
          <InfoRow label="Photos" theme={theme}>
            {totals ? String(totals.images ?? 0) : '—'}
          </InfoRow>
          <InfoRow label="Videos" theme={theme}>
            {totals ? String(totals.videos ?? 0) : '—'}
          </InfoRow>
          <ActionRow
            label="Refresh Statistics"
            theme={theme}
            disabled={!!busy}
            busy={busy === 'Load Stats'}
            onPress={onLoadStats}
          />
        </Section>
      </ScrollView>

      <Modal visible={logs != null} animationType="slide" onRequestClose={() => setLogs(null)}>
        <Screen>
          <View
            style={[
              styles.header,
              { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
            ]}
          >
            <Pressable onPress={() => setLogs(null)} hitSlop={8}>
              <Text style={[styles.back, { color: theme.color.tint }]}>Done</Text>
            </Pressable>
            <Text style={[styles.title, { color: theme.color.label }]}>Server Logs</Text>
            <View style={styles.spacer} />
          </View>
          <ScrollView contentContainerStyle={styles.logBody} horizontal={false}>
            <Text style={[styles.logText, { color: theme.color.secondaryLabel }]} selectable>
              {logs}
            </Text>
          </ScrollView>
        </Screen>
      </Modal>
    </Screen>
  );
}

function Section({
  label,
  theme,
  children,
}: {
  label: string;
  theme: ReturnType<typeof useTheme>;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel }]}>{label}</Text>
      <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
        {children}
      </View>
    </>
  );
}

function InfoRow({
  label,
  theme,
  children,
}: {
  label: string;
  theme: ReturnType<typeof useTheme>;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.row, { borderTopColor: theme.color.separator }]}>
      <Text style={[styles.rowLabel, { color: theme.color.label }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.color.secondaryLabel }]} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

function ActionRow({
  label,
  theme,
  onPress,
  disabled,
  busy,
  destructive,
}: {
  label: string;
  theme: ReturnType<typeof useTheme>;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  destructive?: boolean;
}): React.JSX.Element {
  const color = destructive ? theme.color.destructive : theme.color.tint;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.row, { borderTopColor: theme.color.separator, opacity: disabled ? 0.4 : 1 }]}
    >
      <Text style={[styles.rowLabel, { color }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel }]}>
        {busy ? '…' : '›'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { fontSize: 17 },
  title: { fontSize: 17, fontWeight: '600' },
  spacer: { width: 50 },
  content: { paddingVertical: 12, paddingBottom: 40 },
  sectionLabel: { fontSize: 13, marginLeft: 30, marginBottom: 6, marginTop: 22 },
  group: { marginHorizontal: 16, borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowLabel: { fontSize: 16 },
  rowValue: { fontSize: 15, flexShrink: 1, textAlign: 'right' },
  logBody: { padding: 14 },
  logText: { fontSize: 11, fontFamily: 'Menlo', lineHeight: 16 },
});
