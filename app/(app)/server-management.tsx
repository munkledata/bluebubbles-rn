import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { serverApi } from '@core/api';
import { isUnimplementedEndpoint } from '@core/api/errors';
import { buildSetupQr } from '@features/setup/qr';
import { http, startSync } from '@/services';
import { useSessionStore } from '@state/sessionStore';
import { useSyncStore } from '@state/syncStore';
import { InfoRow, PairingQr, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

/** F-9: server administration — status, restarts, update check, manual sync, logs, stats. */
export default function ServerManagementScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const setServerInfo = useSessionStore((s) => s.setServerInfo);
  const origin = useSessionStore((s) => s.origin);
  const password = useSessionStore((s) => s.password);
  const syncStatus = useSyncStore((s) => s.status);
  // Select each primitive separately — an object-returning selector `(s) => ({...})` allocates a
  // fresh object every render, which useSyncExternalStore reads as a changed snapshot → infinite
  // re-render loop ("Maximum update depth exceeded"). zustand has no auto-shallow-compare.
  const syncChats = useSyncStore((s) => s.chats);
  const syncMessages = useSyncStore((s) => s.messages);

  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight action
  const [logs, setLogs] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);

  // The pairing payload embeds the PASSWORD — build it in memory only, never log it,
  // and only hand it to the reveal-gated PairingQr inside the modal.
  let pairingPayload: string | null = null;
  if (origin && password) {
    try {
      pairingPayload = buildSetupQr(origin, password);
    } catch {
      pairingPayload = null; // malformed origin — the modal shows the "connect first" copy
    }
  }

  // Round-trip latency probe. `retry: false` mirrors the endpoint's fail-fast intent — a
  // reachability check must not mask a down server by silently retrying, and
  // `staleTime: 0` makes every visit re-probe instead of showing a cached answer.
  const pingQuery = useQuery({
    queryKey: ['server', 'ping'],
    queryFn: async () => {
      const t0 = Date.now();
      await serverApi.ping(http);
      return Date.now() - t0;
    },
    retry: false,
    staleTime: 0,
  });
  const latency = pingQuery.data ?? null;
  const reachable = pingQuery.isSuccess ? true : pingQuery.isError ? false : null;

  // Statistics ARE served on the password path (admin-command dispatcher) — loaded on mount.
  // On total failure we flag an INLINE error in the section (no modal alert); a partial result
  // (some channels missing on an older server) still shows the numbers it could load.
  const statsQuery = useQuery({
    queryKey: ['server', 'stats'],
    queryFn: () => serverApi.serverStatTotals(http),
  });
  const totals = statsQuery.data ?? null;
  const statsError = statsQuery.isError;

  // Refresh the cached server info (version / macOS / private-API). On a hydrated boot the
  // `connected` action never ran, so the session store still has serverInfo=null → "Unknown";
  // fetching it here populates the STATUS section (and the app-wide `privateApiEnabled` gate).
  const infoQuery = useQuery({
    queryKey: ['server', 'info'],
    queryFn: () => serverApi.serverInfo(http),
  });
  const latestServerInfo = infoQuery.data;
  useEffect(() => {
    if (latestServerInfo) setServerInfo(latestServerInfo);
  }, [latestServerInfo, setServerInfo]);

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
      .then(() => showDialog('Server', okMsg))
      .catch((e: unknown) => showDialog('Server', failCopy(label, e)))
      .finally(() => setBusy(null));
  };

  const confirmThen = (
    label: string,
    message: string,
    fn: () => Promise<unknown>,
    okMsg: string,
    destructive = false,
  ): void => {
    showDialog(label, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: label,
        style: destructive ? 'destructive' : 'default',
        onPress: () => run(label, fn, okMsg),
      },
    ]);
  };

  const onLoadStats = (): void => {
    if (busy) return;
    setBusy('Load Stats');
    // `refetch` never rejects — success/failure land in `statsQuery.data` / `.isError`.
    void statsQuery.refetch().finally(() => setBusy(null));
  };

  const onViewLogs = (): void => {
    if (busy) return;
    setBusy('View Logs');
    void serverApi
      .serverLogs(http, 500)
      .then((res) => setLogs(res.trim() ? res : 'No recent log lines.'))
      .catch((e: unknown) => showDialog('Server', failCopy('Fetch logs', e)))
      .finally(() => setBusy(null));
  };

  const onSyncNow = (): void => {
    if (busy || syncStatus === 'syncing') return;
    void startSync();
  };

  // Format a stat with thousands separators; em-dash until stats have loaded.
  const statVal = (n?: number): string => (totals ? (n ?? 0).toLocaleString() : '—');

  // Share the server URL (the share sheet includes Copy) — avoids a clipboard native dep.
  const onShareUrl = (): void => {
    if (!origin) return;
    void Share.share({ message: origin }).catch(() => {});
  };

  return (
    <Screen>
      <ScreenHeader title="Server Management" onBack={() => router.back()} />

      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection label="STATUS">
          <InfoRow
            label="Connection"
            value={`${reachable == null ? 'Checking…' : reachable ? 'Reachable' : 'Unreachable'}${
              latency != null ? ` · ${latency} ms` : ''
            }`}
          />
          <InfoRow label="Server version" value={serverInfo?.server_version ?? 'Unknown'} />
          <InfoRow label="macOS" value={serverInfo?.os_version ?? 'Unknown'} />
          <InfoRow label="Private API" value={serverInfo?.private_api ? 'Enabled' : 'Disabled'} />
          <InfoRow label="Proxy" value={serverInfo?.proxy_service ?? 'Direct'} />
          <Pressable onPress={onShareUrl} disabled={!origin} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Server URL</Text>
            <Text
              style={[
                styles.rowValue,
                { color: origin ? theme.color.tint : theme.color.secondaryLabel },
              ]}
              numberOfLines={1}
            >
              {origin ?? 'Unknown'}
            </Text>
          </Pressable>
          <InfoRow
            label="Sync"
            value={
              syncStatus === 'syncing'
                ? `Syncing… (${syncChats} chats, ${syncMessages} msgs)`
                : syncStatus === 'done'
                  ? `Up to date (${syncMessages} msgs)`
                  : syncStatus === 'error'
                    ? 'Error'
                    : 'Idle'
            }
          />
        </SettingsSection>

        <SettingsSection label="ACTIONS" style={styles.gap}>
          <ActionRow label="Sync Now" disabled={syncStatus === 'syncing'} onPress={onSyncNow} />
          <ActionRow label="Server Health" onPress={() => router.push('/server-health')} />
          <ActionRow label="Show Pairing QR" onPress={() => setQrOpen(true)} />
          <ActionRow
            label="Restart iMessage"
            disabled={!!busy}
            busy={busy === 'Restart iMessage'}
            onPress={() =>
              confirmThen(
                'Restart iMessage',
                'Relaunch the Messages app on the Mac?',
                () => serverApi.restartImessage(http),
                'Messages is restarting.',
              )
            }
          />
          <ActionRow
            label="Restart Services"
            disabled={!!busy}
            busy={busy === 'Restart Services'}
            onPress={() =>
              confirmThen(
                'Restart Services',
                'Soft-restart the server services (Private API + tunnel)?',
                () => serverApi.softRestart(http),
                'Services are restarting.',
              )
            }
          />
          <ActionRow
            label="Restart Server"
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
            label="View Server Logs"
            disabled={!!busy}
            busy={busy === 'View Logs'}
            onPress={onViewLogs}
          />
        </SettingsSection>

        <SettingsSection label="STATISTICS" style={styles.gap}>
          <InfoRow label="Messages" value={statVal(totals?.messages)} />
          <InfoRow label="Chats" value={statVal(totals?.chats)} />
          <InfoRow label="iMessage Numbers" value={statVal(totals?.handles)} />
          <InfoRow label="Attachments" value={statVal(totals?.attachments)} />
          <InfoRow label="Photos" value={statVal(totals?.images)} />
          <InfoRow label="Videos" value={statVal(totals?.videos)} />
          <InfoRow label="Locations" value={statVal(totals?.locations)} />
          {statsError ? (
            <View style={styles.row}>
              <Text style={[styles.errorText, { color: theme.color.destructive }]}>
                Couldn’t load statistics. Check your connection, then tap Refresh.
              </Text>
            </View>
          ) : null}
          <ActionRow
            label="Refresh Statistics"
            disabled={!!busy}
            busy={busy === 'Load Stats'}
            onPress={onLoadStats}
          />
        </SettingsSection>
      </ScrollView>

      {/* Conditionally rendered (not just visible=false) so PairingQr fully unmounts on close,
          dropping any revealed QR state along with it. */}
      {qrOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setQrOpen(false)}>
          <Screen>
            <ScreenHeader
              title="Pairing QR"
              right={
                <Pressable
                  onPress={() => setQrOpen(false)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close pairing QR"
                >
                  <Text style={[styles.done, { color: theme.color.tint }]}>Done</Text>
                </Pressable>
              }
            />
            <PairingQr payload={pairingPayload} />
          </Screen>
        </Modal>
      ) : null}

      <Modal visible={logs != null} animationType="slide" onRequestClose={() => setLogs(null)}>
        <Screen>
          <ScreenHeader
            title="Server Logs"
            right={
              <Pressable
                onPress={() => setLogs(null)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Close server logs"
              >
                <Text style={[styles.done, { color: theme.color.tint }]}>Done</Text>
              </Pressable>
            }
          />
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

/** Tinted/destructive action row (kit padding): busy shows '…' in place of the chevron. */
function ActionRow({
  label,
  onPress,
  disabled,
  busy,
  destructive,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  destructive?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const color = destructive ? theme.color.destructive : theme.color.tint;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.row, { opacity: disabled ? 0.4 : 1 }]}
    >
      <Text style={[styles.rowLabel, { color }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel }]}>
        {busy ? '…' : '›'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  gap: { marginTop: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowLabel: { fontSize: 16 },
  rowValue: { fontSize: 15, flexShrink: 1, textAlign: 'right' },
  errorText: { fontSize: 14, flex: 1, lineHeight: 19 },
  done: { fontSize: 17, textAlign: 'right' },
  logBody: { padding: 14 },
  logText: { fontSize: 11, fontFamily: 'Menlo', lineHeight: 16 },
});
