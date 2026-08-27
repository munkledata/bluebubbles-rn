import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { serverApi } from '@core/api';
import { isUnimplementedEndpoint } from '@core/api/errors';
import { buildSetupQr } from '@features/setup/qr';
import { cancelFullRepair, http, startFullRepair, startSync } from '@/services';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { useSessionStore } from '@state/sessionStore';
import { useSyncStore, type SyncRepairStatus } from '@state/syncStore';
import { InfoRow, PairingQr, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

/**
 * Read-only queries do not hold Disconnect open. Their generation-specific cache key isolates the
 * eventual TanStack Query commit; this guard also turns a late old-account result/error into null
 * so the retired screen cannot render it or copy it into app-wide state.
 */
async function readForAccount<T>(
  lease: RealtimeDeliveryLease,
  read: () => Promise<T>,
): Promise<T | null> {
  if (!lease.isCurrent()) return null;
  try {
    const value = await read();
    return lease.isCurrent() ? value : null;
  } catch (error) {
    if (!lease.isCurrent()) return null;
    throw error;
  }
}

type ModalAnimationType = 'none' | 'slide';

interface LogsModalState {
  text: string;
  animationType: ModalAnimationType;
}

function useReduceMotionPreferenceRef(): React.RefObject<boolean | null> {
  const reduceMotion = useRef<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    let receivedPreferenceEvent = false;
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      receivedPreferenceEvent = true;
      if (mounted) reduceMotion.current = enabled;
    });

    void AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (mounted && !receivedPreferenceEvent) reduceMotion.current = enabled;
      },
      () => {
        // If the native query is unavailable, retain the existing slide behavior for future opens.
        if (mounted && !receivedPreferenceEvent) reduceMotion.current = false;
      },
    );

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

function modalAnimationFor(reduceMotion: boolean | null): ModalAnimationType {
  return reduceMotion === false ? 'slide' : 'none';
}

function repairStatusCopy(status: SyncRepairStatus, phase: string | null): string {
  if (status === 'idle') return 'Not run';
  if (status === 'queued') return phase ?? 'Waiting';
  if (status === 'running') return phase ?? 'Running';
  if (status === 'cancelling') return 'Stopping after current request';
  if (status === 'cancelled') return 'Stopped — safe to restart';
  if (status === 'done') return 'Complete';
  return 'Failed — safe to restart';
}

/** F-9: server administration — status, restarts, update check, manual sync, logs, stats. */
export default function ServerManagementScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const reduceMotion = useReduceMotionPreferenceRef();
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
  const repairStatus = useSyncStore((s) => s.repairStatus);
  const repairPhase = useSyncStore((s) => s.repairPhase);
  const repairLog = useSyncStore((s) => s.repairLog);
  // Every query/callback created by this screen belongs to the account that mounted it. A global
  // confirm dialog can retain its button callback after navigation, so checking only mounted state
  // is insufficient.
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());

  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight action
  const [logsModal, setLogsModal] = useState<LogsModalState | null>(null);
  const [qrModal, setQrModal] = useState<ModalAnimationType | null>(null);

  // The lease revokes callbacks synchronously, but currentness is not reactive. Force an old
  // mounted route to unmount credential/log subtrees as soon as its account generation retires.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
        setLogsModal(null);
        setQrModal(null);
      }),
    [accountLease],
  );

  const accountCurrent = !accountRetired && accountLease.isCurrent();

  // The pairing payload embeds the PASSWORD — build it in memory only, never log it,
  // and only hand it to the reveal-gated PairingQr inside the modal.
  let pairingPayload: string | null = null;
  if (accountCurrent && origin && password) {
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
    queryKey: ['server', 'ping', accountLease.generation],
    queryFn: ({ signal }) =>
      readForAccount(accountLease, async () => {
        const t0 = Date.now();
        await serverApi.ping(http, signal);
        return Date.now() - t0;
      }),
    retry: false,
    staleTime: 0,
  });
  const latency = accountLease.isCurrent() ? (pingQuery.data ?? null) : null;
  const reachable = !accountLease.isCurrent()
    ? null
    : pingQuery.isSuccess && pingQuery.data != null
      ? true
      : pingQuery.isError
        ? false
        : null;

  // Statistics ARE served on the password path (admin-command dispatcher) — loaded on mount.
  // On total failure we flag an INLINE error in the section (no modal alert); a partial result
  // (some channels missing on an older server) still shows the numbers it could load.
  const statsQuery = useQuery({
    queryKey: ['server', 'stats', accountLease.generation],
    queryFn: ({ signal }) =>
      readForAccount(accountLease, () => serverApi.serverStatTotals(http, signal)),
  });
  const totals = accountLease.isCurrent() ? (statsQuery.data ?? null) : null;
  const statsError = accountLease.isCurrent() && statsQuery.isError;
  // All-channels-404 (no dispatcher, or a reverse proxy blocking /admin/*) is surfaced as
  // Unimplemented by serverStatTotals — show honest copy instead of blaming the connection.
  const statsUnsupported = statsError && isUnimplementedEndpoint(statsQuery.error);

  // Refresh the cached server info (version / macOS / private-API). On a hydrated boot the
  // `connected` action never ran, so the session store still has serverInfo=null → "Unknown";
  // fetching it here populates the STATUS section (and the app-wide `privateApiEnabled` gate).
  const infoQuery = useQuery({
    queryKey: ['server', 'info', accountLease.generation],
    queryFn: ({ signal }) => readForAccount(accountLease, () => serverApi.serverInfo(http, signal)),
  });
  const latestServerInfo = infoQuery.data;
  useEffect(() => {
    if (latestServerInfo && accountLease.isCurrent()) setServerInfo(latestServerInfo);
  }, [accountLease, latestServerInfo, setServerInfo]);

  // Distinguish "this server doesn't support the action" from a real connection failure so
  // the copy isn't misleading (the old code blamed every 404 on the connection).
  const failCopy = (label: string, e: unknown): string =>
    isUnimplementedEndpoint(e)
      ? `${label} isn’t supported on this server.`
      : `Couldn’t ${label.toLowerCase()}. Check your connection.`;

  // Run an admin action with an in-flight guard; reports the outcome.
  const run = (label: string, fn: () => Promise<unknown>, okMsg: string): void => {
    if (busy || !accountLease.isCurrent()) return;
    setBusy(label);
    void (async () => {
      try {
        await runTrackedRealtimeWork(accountLease, async (activeLease) => {
          if (!activeLease.isCurrent()) return;
          await fn();
          if (activeLease.isCurrent()) showDialog('Server', okMsg);
        });
      } catch (e) {
        if (accountLease.isCurrent()) showDialog('Server', failCopy(label, e));
      } finally {
        if (accountLease.isCurrent()) setBusy(null);
      }
    })();
  };

  const confirmThen = (
    label: string,
    message: string,
    fn: () => Promise<unknown>,
    okMsg: string,
    destructive = false,
  ): void => {
    if (!accountLease.isCurrent()) return;
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
    if (busy || !accountLease.isCurrent()) return;
    setBusy('Load Stats');
    // `refetch` never rejects — success/failure land in `statsQuery.data` / `.isError`.
    void statsQuery.refetch().finally(() => {
      if (accountLease.isCurrent()) setBusy(null);
    });
  };

  const onViewLogs = (): void => {
    if (busy || !accountLease.isCurrent()) return;
    setBusy('View Logs');
    void (async () => {
      try {
        await runTrackedRealtimeWork(accountLease, async (activeLease) => {
          if (!activeLease.isCurrent()) return;
          const res = await serverApi.serverLogs(http, 500);
          if (activeLease.isCurrent()) {
            const nextModal = {
              text: res.trim() ? res : 'No recent log lines.',
              animationType: modalAnimationFor(reduceMotion.current),
            };
            setLogsModal((current) => current ?? nextModal);
          }
        });
      } catch (e) {
        if (accountLease.isCurrent()) {
          showDialog('Server', failCopy('Fetch logs', e));
        }
      } finally {
        if (accountLease.isCurrent()) setBusy(null);
      }
    })();
  };

  const onSyncNow = (): void => {
    if (busy || syncStatus === 'syncing' || !accountLease.isCurrent()) return;
    void startSync();
  };

  const repairActive =
    repairStatus === 'queued' || repairStatus === 'running' || repairStatus === 'cancelling';

  const onStartRepair = (): void => {
    if (busy || repairActive || !accountLease.isCurrent()) return;
    const restarting = repairStatus === 'cancelled' || repairStatus === 'error';
    showDialog(
      restarting ? 'Restart Local Cache Repair' : 'Repair Local Cache',
      'Re-download every chat and message from your server without disconnecting. Pins, custom names, wallpapers, themes, reminders, drafts, and deleted-chat protections stay in place. This can take a while.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: restarting ? 'Restart Repair' : 'Start Repair',
          onPress: () => {
            if (accountLease.isCurrent()) void startFullRepair();
          },
        },
      ],
    );
  };

  const onCancelRepair = (): void => {
    if (!accountLease.isCurrent() || repairStatus === 'cancelling') return;
    cancelFullRepair();
  };

  // Format a stat with thousands separators; em-dash until stats have loaded.
  const statVal = (n?: number): string => (totals ? (n ?? 0).toLocaleString() : '—');

  // Share the server URL (the share sheet includes Copy) — avoids a clipboard native dep.
  const onShareUrl = (): void => {
    if (!origin || !accountLease.isCurrent()) return;
    void Share.share({ message: origin }).catch(() => {});
  };

  // A retired screen must not adopt account B's store values before Expo Router unmounts it.
  const visibleServerInfo = accountCurrent ? serverInfo : null;
  const visibleOrigin = accountCurrent ? origin : null;
  const visibleSyncStatus = accountCurrent ? syncStatus : 'idle';
  const visibleSyncChats = accountCurrent ? syncChats : 0;
  const visibleSyncMessages = accountCurrent ? syncMessages : 0;
  const visibleRepairStatus = accountCurrent ? repairStatus : 'idle';
  const visibleRepairPhase = accountCurrent ? repairPhase : null;
  const visibleRepairLog = accountCurrent ? repairLog : [];
  const visibleRepairActive =
    visibleRepairStatus === 'queued' ||
    visibleRepairStatus === 'running' ||
    visibleRepairStatus === 'cancelling';

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
          <InfoRow label="Server version" value={visibleServerInfo?.server_version ?? 'Unknown'} />
          <InfoRow label="macOS" value={visibleServerInfo?.os_version ?? 'Unknown'} />
          <InfoRow
            label="Private API"
            value={visibleServerInfo?.private_api ? 'Enabled' : 'Disabled'}
          />
          <InfoRow label="Proxy" value={visibleServerInfo?.proxy_service ?? 'Direct'} />
          <Pressable
            onPress={onShareUrl}
            disabled={!visibleOrigin}
            accessibilityRole="button"
            accessibilityLabel={`Share server URL ${visibleOrigin ?? 'Unknown'}`}
            style={styles.row}
          >
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Server URL</Text>
            <Text
              style={[
                styles.rowValue,
                { color: visibleOrigin ? theme.color.tint : theme.color.secondaryLabel },
              ]}
              numberOfLines={1}
            >
              {visibleOrigin ?? 'Unknown'}
            </Text>
          </Pressable>
          <InfoRow
            label="Sync"
            value={
              visibleSyncStatus === 'syncing'
                ? `Syncing… (${visibleSyncChats} chats, ${visibleSyncMessages} msgs)`
                : visibleSyncStatus === 'done'
                  ? `Up to date (${visibleSyncMessages} msgs)`
                  : visibleSyncStatus === 'error'
                    ? 'Error'
                    : 'Idle'
            }
          />
        </SettingsSection>

        <SettingsSection label="ACTIONS" style={styles.gap}>
          <ActionRow label="Sync Now" disabled={syncStatus === 'syncing'} onPress={onSyncNow} />
          <ActionRow
            label="Server Health"
            onPress={() => {
              if (accountLease.isCurrent()) router.push('/server-health');
            }}
          />
          <ActionRow
            label="Show Pairing QR"
            onPress={() => {
              if (accountLease.isCurrent()) {
                const animationType = modalAnimationFor(reduceMotion.current);
                setQrModal((current) => current ?? animationType);
              }
            }}
          />
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

        <SettingsSection label="LOCAL CACHE REPAIR" style={styles.gap}>
          <View style={styles.repairIntro}>
            <Text style={[styles.repairDescription, { color: theme.color.secondaryLabel }]}>
              Re-download server data without disconnecting or erasing your local choices.
            </Text>
          </View>
          {visibleRepairStatus !== 'idle' ? (
            <>
              <InfoRow
                label="Repair status"
                value={repairStatusCopy(visibleRepairStatus, visibleRepairPhase)}
              />
              <InfoRow
                label="Repair progress"
                value={`${visibleSyncChats.toLocaleString()} chats · ${visibleSyncMessages.toLocaleString()} messages`}
              />
              {visibleRepairLog.length > 0 ? (
                <View style={styles.repairLog}>
                  {visibleRepairLog.map((line, index) => (
                    <Text
                      key={`${index}-${line}`}
                      style={[styles.repairLogLine, { color: theme.color.secondaryLabel }]}
                    >
                      {line}
                    </Text>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
          <ActionRow
            label={
              visibleRepairActive
                ? visibleRepairStatus === 'cancelling'
                  ? 'Stopping Repair…'
                  : 'Cancel Repair'
                : visibleRepairStatus === 'cancelled' || visibleRepairStatus === 'error'
                  ? 'Restart Repair'
                  : 'Repair Local Cache'
            }
            disabled={visibleRepairStatus === 'cancelling' || !!busy}
            busy={visibleRepairStatus === 'cancelling'}
            onPress={visibleRepairActive ? onCancelRepair : onStartRepair}
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
                {statsUnsupported
                  ? 'This server doesn’t expose statistics. It may be an older version, or a proxy may be blocking its admin endpoints.'
                  : 'Couldn’t load statistics. Check your connection, then tap Refresh.'}
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
      {accountCurrent && qrModal ? (
        <Modal
          visible
          animationType={qrModal}
          onRequestClose={() => setQrModal(null)}
          testID="pairing-qr-modal"
        >
          <Screen>
            <ScreenHeader
              title="Pairing QR"
              right={
                <Pressable
                  onPress={() => setQrModal(null)}
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

      {accountCurrent && logsModal ? (
        <Modal
          visible
          animationType={logsModal.animationType}
          onRequestClose={() => setLogsModal(null)}
          testID="server-logs-modal"
        >
          <Screen>
            <ScreenHeader
              title="Server Logs"
              right={
                <Pressable
                  onPress={() => setLogsModal(null)}
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
                {logsModal.text}
              </Text>
            </ScrollView>
          </Screen>
        </Modal>
      ) : null}
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
      accessibilityRole="button"
      accessibilityLabel={label}
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
  repairIntro: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  repairDescription: { fontSize: 14, lineHeight: 20 },
  repairLog: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8, gap: 4 },
  repairLogLine: { fontSize: 12, lineHeight: 17 },
  done: { fontSize: 17, textAlign: 'right' },
  logBody: { padding: 14 },
  logText: { fontSize: 11, fontFamily: 'Menlo', lineHeight: 16 },
});
