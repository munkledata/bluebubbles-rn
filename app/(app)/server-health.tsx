import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useLayoutEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { serverApi } from '@core/api';
import { isUnimplementedEndpoint } from '@core/api/errors';
import type { RcsStatus, ServerAlert } from '@core/api/endpoints/server';
import { deriveRcsHealth, deriveRcsHealthFromStatus, type RcsSeverity } from '@core/realtime';
import { http } from '@/services';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { useSessionStore } from '@state/sessionStore';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { showToast } from '@ui/toast';
import { InfoRow, NavRow, NoteRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

const yesNo = (v: boolean | null | undefined): string => (v == null ? '—' : v ? 'Yes' : 'No');
const okBad = (v: boolean | null | undefined): string =>
  v == null ? '—' : v ? 'Connected' : 'Not connected';

/** See ServerManagementScreen: reads use an isolated cache key and discard late old-account data. */
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

function formatUptime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Server Health / diagnostics — surfaces the server's read-only status channels so the user can
 *  see helper connectivity, Find My key state, push config, tunnel/TLS, uptime, and alerts. */
export default function ServerHealthScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const healthQueryPrefix = ['server', 'health', accountLease.generation] as const;
  const alertsQueryKey = [...healthQueryPrefix, 'alerts'] as const;
  const [clearingAlerts, setClearingAlerts] = useState(false);

  // Lease currentness revokes callbacks immediately but is not reactive. Commit a monotonic retired
  // state so an old mounted route removes all account-owned diagnostics and actions without waiting
  // for a session-store or query update to happen to rerender it.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
      }),
    [accountLease],
  );
  const accountCurrent = !accountRetired && accountLease.isCurrent();
  // RCS bridge (Google Messages): the capability boolean gates the section (absent on older
  // servers → hidden). The rich, accurate health block comes from the NON-admin `get-rcs-status`
  // channel (fetched below); the live `rcs-alert` socket event is kept as an immediacy override so
  // a fresh alert updates the card between refetches.
  const rcsCapability = accountCurrent ? serverInfo?.rcs : undefined;
  const rcsLastAlert = useRcsHealthStore((s) => s.lastAlertType);
  const rcsLastAlertAt = useRcsHealthStore((s) => s.lastAlertAt);

  // Each read is its own query — a failure just leaves that card at "—" (data stays undefined),
  // never blocks the rest. The `?? null` coercions matter: most of these endpoints can resolve
  // `undefined` (nullish zod schemas), which TanStack Query treats as an error.
  const queryClient = useQueryClient();
  const healthQueries = useQueries({
    queries: [
      {
        queryKey: [...healthQueryPrefix, 'private-api'],
        queryFn: () =>
          readForAccount(
            accountLease,
            async () => (await serverApi.privateApiStatus(http)) ?? null,
          ),
      },
      {
        queryKey: [...healthQueryPrefix, 'env'],
        queryFn: () =>
          readForAccount(accountLease, async () => (await serverApi.serverEnv(http)) ?? null),
      },
      {
        queryKey: [...healthQueryPrefix, 'findmy-keys'],
        queryFn: () =>
          readForAccount(
            accountLease,
            async () => (await serverApi.findMyKeysStatus(http)) ?? null,
          ),
      },
      {
        queryKey: [...healthQueryPrefix, 'fcm'],
        queryFn: () =>
          readForAccount(accountLease, async () => (await serverApi.fcmStatus(http)) ?? null),
      },
      {
        queryKey: [...healthQueryPrefix, 'zrok'],
        queryFn: () =>
          readForAccount(accountLease, async () => (await serverApi.zrokStatus(http)) ?? null),
      },
      {
        queryKey: [...healthQueryPrefix, 'public-ip'],
        queryFn: () => readForAccount(accountLease, () => serverApi.publicIp(http)),
      },
      {
        queryKey: [...healthQueryPrefix, 'tls'],
        queryFn: () =>
          readForAccount(accountLease, async () => (await serverApi.tlsStatus(http)) ?? null),
      },
      {
        queryKey: [...healthQueryPrefix, 'admin'],
        queryFn: () =>
          readForAccount(accountLease, async () => (await serverApi.adminStatus(http)) ?? null),
      },
      {
        queryKey: alertsQueryKey,
        queryFn: () => readForAccount(accountLease, () => serverApi.serverAlerts(http)),
      },
      // Older servers lack the `get-rcs-status` channel (reject / `[]` sentinel → schema fail):
      // the query stays errored so the RCS row degrades to the capability-only signal.
      {
        queryKey: [...healthQueryPrefix, 'rcs'],
        queryFn: () =>
          readForAccount(accountLease, async () => (await serverApi.rcsStatus(http)) ?? null),
      },
    ],
  });
  const [paQ, envQ, keysQ, fcmQ, zrokQ, ipQ, tlsQ, adminQ, alertsQ, rcsQ] = healthQueries;
  const visibleServerInfo = accountCurrent ? serverInfo : null;
  const pa = accountCurrent ? paQ.data : null;
  const env = accountCurrent ? envQ.data : null;
  const keys = accountCurrent ? keysQ.data : null;
  const fcm = accountCurrent ? fcmQ.data : null;
  const zrok = accountCurrent ? zrokQ.data : null;
  const ip = accountCurrent ? (ipQ.data ?? null) : null;
  const tls = accountCurrent ? tlsQ.data : null;
  const admin = accountCurrent ? adminQ.data : null;
  const alerts = accountCurrent ? (alertsQ.data ?? []) : [];
  // The live `get-rcs-status` block + when it last resolved (to decide whether a socket alert is
  // fresher than the fetch). No data = channel unavailable (older server) → capability-only.
  const rcs = accountCurrent ? (rcsQ.data ?? null) : null;
  const rcsFetchedAt = accountCurrent && rcsQ.dataUpdatedAt > 0 ? rcsQ.dataUpdatedAt : null;
  const refreshing = accountCurrent && healthQueries.some((q) => q.isFetching);
  // True when EVERY read failed → the server isn't answering the health channels at all (offline
  // or too old). Shown as a banner so an empty screen reads as a server issue, not an app bug.
  const allFailed = accountCurrent && healthQueries.every((q) => q.isError);
  // Every failure was a dispatcher 404 (remapped to Unimplemented): the server predates the admin
  // dispatcher, or a reverse proxy blocks /admin/* — a config problem, not connectivity.
  const allUnsupported = allFailed && healthQueries.every((q) => isUnimplementedEndpoint(q.error));

  const load = useCallback((): void => {
    if (!accountLease.isCurrent()) return;
    void queryClient.invalidateQueries({
      queryKey: ['server', 'health', accountLease.generation],
    });
  }, [accountLease, queryClient]);

  const onClearAlerts = (): void => {
    if (clearingAlerts || !accountLease.isCurrent()) return;
    setClearingAlerts(true);
    void (async () => {
      try {
        await runTrackedRealtimeWork(accountLease, async (activeLease) => {
          if (!activeLease.isCurrent()) return;
          await serverApi.clearServerAlerts(http);
          if (!activeLease.isCurrent()) return;
          queryClient.setQueryData<ServerAlert[]>(alertsQueryKey, []);
        });
      } catch {
        if (accountLease.isCurrent()) showToast('Could not clear server alerts.');
      } finally {
        if (accountLease.isCurrent()) setClearingAlerts(false);
      }
    })();
  };

  const tlsMode = tls
    ? String(tls.mode ?? tls.tls_mode ?? (tls.enabled ? 'enabled' : 'off'))
    : null;
  const tlsDomain = tls ? (tls.domain ?? tls.tls_domain ?? tls.commonName) : null;

  return (
    <Screen>
      <ScreenHeader
        title="Server Health"
        onBack={() => router.back()}
        right={
          accountCurrent ? (
            <Pressable onPress={load} hitSlop={8} disabled={refreshing} accessibilityRole="button">
              <Text style={[styles.action, { color: theme.color.tint }]} numberOfLines={1}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Text>
            </Pressable>
          ) : null
        }
      />

      {!accountCurrent ? (
        <View style={styles.accountChanged}>
          <Text
            accessibilityRole="text"
            accessibilityLabel="Server account changed. Go back and reopen Server Health."
            style={[styles.accountChangedText, { color: theme.color.secondaryLabel }]}
          >
            Server account changed. Go back and reopen Server Health.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={load} tintColor={theme.color.tint} />
          }
        >
          {allFailed ? (
            <View style={[styles.banner, { backgroundColor: theme.color.secondaryBackground }]}>
              <Text style={[styles.hint, { color: theme.color.destructive }]}>
                {allUnsupported
                  ? 'This server doesn’t expose health reporting. It may be an older version, or a proxy may be blocking its admin endpoints.'
                  : 'The server isn’t responding to health checks. It may be offline, or running an older version that doesn’t report these details.'}
              </Text>
            </View>
          ) : null}
          <SettingsSection label="PRIVATE API">
            <InfoRow
              label="Messages helper"
              value={pa?.enabled === false ? 'Disabled' : okBad(pa?.connected)}
            />
            <InfoRow
              label="FaceTime helper"
              value={pa?.ft_enabled === false ? 'Disabled' : okBad(pa?.ft_connected)}
            />
          </SettingsSection>

          <SettingsSection label="FIND MY KEYS" style={styles.gap}>
            <InfoRow label="LocalStorage (friends)" value={keyState(keys?.LocalStorage)} />
            <InfoRow label="FMIP (devices)" value={keyState(keys?.FMIP)} />
            <InfoRow label="FMF (people cache)" value={keyState(keys?.FMF)} />
            {env?.findmyNeedsKeys ? (
              <NoteRow text="macOS 14.4+ encrypts the Find My caches — import keys on the server console if a key above is missing, or Find My tabs stay empty." />
            ) : null}
          </SettingsSection>

          <SettingsSection label="PUSH (FCM)" style={styles.gap}>
            <InfoRow label="Configured" value={yesNo(fcm?.configured)} />
            {fcm?.projectId ? <InfoRow label="Project" value={fcm.projectId} /> : null}
          </SettingsSection>

          <SettingsSection label="ENVIRONMENT" style={styles.gap}>
            <InfoRow
              label="Server version"
              value={env?.version ?? visibleServerInfo?.server_version ?? 'Unknown'}
            />
            <InfoRow label="macOS" value={visibleServerInfo?.os_version ?? 'Unknown'} />
            <InfoRow label="Node" value={env?.node ?? 'Unknown'} />
            <InfoRow label="Uptime" value={formatUptime(admin?.uptimeMs)} />
          </SettingsSection>

          <SettingsSection label="CONNECTION" style={styles.gap}>
            <InfoRow
              label="Tunnel (zrok)"
              value={zrok?.running ? 'Running' : zrok?.available ? 'Available' : 'Off'}
            />
            {zrok?.url ? <InfoRow label="Tunnel URL" value={zrok.url} /> : null}
            <InfoRow label="Public IP" value={ip ?? '—'} />
            <InfoRow
              label="TLS"
              value={`${tlsMode ?? '—'}${
                typeof tlsDomain === 'string' && tlsDomain ? ` · ${tlsDomain}` : ''
              }`}
            />
          </SettingsSection>

          {rcsCapability == null ? null : (
            <RcsBridgeSection
              capability={rcsCapability}
              status={rcs}
              statusFetchedAt={rcsFetchedAt}
              lastAlertType={rcsLastAlert}
              lastAlertAt={rcsLastAlertAt}
              onReauthed={load}
              accountLease={accountLease}
            />
          )}

          <SettingsSection label="ALERTS" style={styles.gap}>
            {alerts.length === 0 ? (
              <InfoRow label="Server alerts" value="None" />
            ) : (
              alerts.map((a) => (
                <View key={a.id} style={styles.row}>
                  <Text style={[styles.alertText, { color: theme.color.label }]} numberOfLines={3}>
                    {a.value ?? a.type ?? 'Alert'}
                  </Text>
                </View>
              ))
            )}
            {alerts.length > 0 ? (
              <NavRow
                label={clearingAlerts ? 'Clearing Alerts…' : 'Clear Alerts'}
                chevron={false}
                disabled={clearingAlerts}
                onPress={onClearAlerts}
              />
            ) : null}
          </SettingsSection>
        </ScrollView>
      )}
    </Screen>
  );
}

function keyState(
  k: { present?: boolean | null; valid?: boolean | null } | null | undefined,
): string {
  if (!k || k.present == null) return '—';
  if (!k.present) return 'Not imported';
  return k.valid ? 'Imported ✓' : 'Invalid';
}

/** Map an RCS-health severity to a status-value colour from the theme (no orange token exists,
 *  so warn + error both use `destructive`; the distinct copy carries the difference). */
function severityColor(severity: RcsSeverity, theme: ReturnType<typeof useTheme>): string {
  switch (severity) {
    case 'ok':
      return theme.color.bubble.smsBackground; // green — healthy
    case 'warn':
    case 'error':
      return theme.color.destructive; // red — needs attention
    case 'off':
    default:
      return theme.color.tertiaryLabel; // muted — bridge turned off
  }
}

/** The RCS bridge (Google Messages) status row. Only rendered when the server advertises the `rcs`
 *  capability. Prefers the live `get-rcs-status` block (accurate enabled/paired/connected/
 *  phoneResponding, plus phoneID) as the source of truth, with the live `rcs-alert` socket signal
 *  as an immediacy override when it's fresher than the last fetch — so a fresh alert updates the
 *  card between refetches, and a dashboard re-auth recovers on the next refetch (connected flips
 *  back true) with NO recovery alert needed. Falls back to the capability-only signal when the
 *  channel is unavailable (older server). The auth fix lives on the Mac server dashboard (a cookie
 *  paste), not in the app. */
function RcsBridgeSection({
  capability,
  status,
  statusFetchedAt,
  lastAlertType,
  lastAlertAt,
  onReauthed,
  accountLease,
}: {
  capability: boolean;
  status: RcsStatus;
  statusFetchedAt: number | null;
  lastAlertType: string | null;
  lastAlertAt: number | null;
  onReauthed: () => void;
  accountLease: RealtimeDeliveryLease;
}): React.JSX.Element {
  const theme = useTheme();
  // A socket alert is an immediacy override only when it arrived AFTER the block was fetched —
  // otherwise a stale alert would defeat the block's reauth-recovery.
  const freshAlert =
    lastAlertType != null &&
    lastAlertAt != null &&
    statusFetchedAt != null &&
    lastAlertAt > statusFetchedAt
      ? lastAlertType
      : null;
  const health =
    status != null
      ? deriveRcsHealthFromStatus(status, freshAlert)
      : // No block (older server / fetch failed): degrade to the capability + last-alert signal.
        deriveRcsHealth(capability, lastAlertType);
  const phoneID = status?.phoneID;
  return (
    <SettingsSection label="RCS BRIDGE" style={styles.gap}>
      <View style={styles.row}>
        <Text style={[styles.rowLabel, { color: theme.color.label }]}>Google Messages</Text>
        <Text
          style={[styles.rowValue, { color: severityColor(health.severity, theme) }]}
          numberOfLines={1}
          accessibilityLabel={`RCS bridge ${health.status}`}
        >
          {health.status}
        </Text>
      </View>
      {phoneID ? <InfoRow label="Phone" value={phoneID} /> : null}
      {health.detail ? <NoteRow text={health.detail} /> : null}
      {capability ? <RcsReconnectRow onDone={onReauthed} accountLease={accountLease} /> : null}
    </SettingsSection>
  );
}

/**
 * "Reconnect" — asks the SERVER to re-authenticate the RCS bridge with its own Firefox cookies.
 *
 * Before this, every RCS health state that needed action said "re-authenticate on the server
 * dashboard" — advice you cannot follow from the phone that is showing it. The fix is not to move
 * Google credentials onto the device (they never leave the Mac); it is to let the phone ask the
 * server to do locally what the dashboard button already does.
 */
function RcsReconnectRow({
  onDone,
  accountLease,
}: {
  onDone: () => void;
  accountLease: RealtimeDeliveryLease;
}): React.JSX.Element {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (busy || !accountLease.isCurrent()) return;
    setBusy(true);
    try {
      await runTrackedRealtimeWork(accountLease, async (activeLease) => {
        if (!activeLease.isCurrent()) return;
        const res = await serverApi.rcsReauthNow(http);
        if (!activeLease.isCurrent()) return;
        // Be honest about the three distinct outcomes — "staged" is NOT a success yet.
        showToast(
          res.staged
            ? 'Bridge is down — fresh cookies saved, they will apply when it restarts.'
            : res.connected
              ? 'RCS bridge reconnected.'
              : 'Cookies applied — the bridge is still connecting.',
        );
        onDone();
      });
    } catch {
      if (accountLease.isCurrent()) showToast('Could not reconnect the RCS bridge.');
    } finally {
      if (accountLease.isCurrent()) setBusy(false);
    }
  }, [accountLease, busy, onDone]);

  return (
    <Pressable onPress={run} disabled={busy} style={styles.row} accessibilityRole="button">
      <Text style={[styles.rowLabel, { color: theme.color.label }]}>Reconnect</Text>
      {busy ? (
        <ActivityIndicator />
      ) : (
        <Text style={[styles.action, { color: theme.color.tint }]}>Re-authenticate</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: { fontSize: 15, textAlign: 'right' },
  content: { padding: 16, paddingBottom: 40 },
  accountChanged: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  accountChangedText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
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
  hint: { fontSize: 12, lineHeight: 17 },
  banner: { borderRadius: 12, padding: 14, marginBottom: 8 },
  alertText: { fontSize: 14, flex: 1 },
});
