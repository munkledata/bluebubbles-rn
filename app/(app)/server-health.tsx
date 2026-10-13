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
import type { ServerAlert } from '@core/api/endpoints/server';
import { deriveRcsHealth, RCS_ALERT_TYPES, type RcsSeverity } from '@core/realtime';
import { isScopedDeviceCredential } from '@core/secure';
import { accountHttp, http } from '@/services';
import {
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import {
  captureSessionTransportLease,
  type SessionTransportLease,
  useSessionStore,
} from '@state/sessionStore';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { showToast } from '@ui/toast';
import { InfoRow, NavRow, NoteRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

const yesNo = (v: boolean | null | undefined): string => (v == null ? '—' : v ? 'Yes' : 'No');

/**
 * Isolate a health read to both the account and the exact approved server URL that started it.
 * The revision also lives in the query key; this final fence turns a delayed old-URL result/error
 * into null instead of letting it populate even that retired cache entry.
 */
async function readForTransport<T>(
  accountLease: RealtimeDeliveryLease,
  expectedTransportRevision: number,
  read: (transportLease: SessionTransportLease) => Promise<T>,
): Promise<T | null> {
  if (!accountLease.isCurrent()) return null;
  const transportLease = captureSessionTransportLease();
  if (transportLease.revision !== expectedTransportRevision || !transportLease.isCurrent()) {
    return null;
  }
  try {
    const value = await read(transportLease);
    return accountLease.isCurrent() && transportLease.isCurrent() ? value : null;
  } catch (error) {
    if (!accountLease.isCurrent() || !transportLease.isCurrent()) return null;
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
 *  see retired-feature status, Find My key state, push config, connection/TLS, uptime, and alerts. */
export default function ServerHealthScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const serverInfo = useSessionStore((s) => s.serverInfo);
  const password = useSessionStore((s) => s.password);
  const transportRevision = useSessionStore((s) => s.transportRevision);
  const accountLease = useScreenAccountLease();
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const healthQueryPrefix = [
    'server',
    'health',
    accountLease.generation,
    transportRevision,
  ] as const;
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
  const scopedCredentialSession = accountCurrent && isScopedDeviceCredential(password);
  // RCS bridge (Google Messages): the capability boolean gates the section (absent on older
  // servers → hidden). The detailed status route is local-admin-only, so remote clients use the
  // capability plus the latest live `rcs-alert` signal instead of attempting an impossible read.
  const rcsCapability = accountCurrent ? serverInfo?.rcs : undefined;
  const rcsLastAlert = useRcsHealthStore((s) => s.lastAlertType);

  // Each read is its own query — a failure just leaves that card at "—" (data stays undefined),
  // never blocks the rest. The `?? null` coercions matter: most of these endpoints can resolve
  // `undefined` (nullish zod schemas), which TanStack Query treats as an error.
  const queryClient = useQueryClient();
  const healthQueries = useQueries({
    queries: [
      {
        queryKey: [...healthQueryPrefix, 'env'],
        queryFn: ({ signal }) =>
          readForTransport(
            accountLease,
            transportRevision,
            async () => (await serverApi.serverEnv(http, signal)) ?? null,
          ),
      },
      {
        queryKey: [...healthQueryPrefix, 'findmy-keys'],
        queryFn: ({ signal }) =>
          readForTransport(
            accountLease,
            transportRevision,
            async () => (await serverApi.findMyKeysStatus(http, signal)) ?? null,
          ),
      },
      {
        queryKey: [...healthQueryPrefix, 'fcm'],
        enabled: !scopedCredentialSession,
        queryFn: ({ signal }) =>
          readForTransport(
            accountLease,
            transportRevision,
            async () => (await serverApi.fcmStatus(http, signal)) ?? null,
          ),
      },
      {
        queryKey: [...healthQueryPrefix, 'public-ip'],
        queryFn: ({ signal }) =>
          readForTransport(accountLease, transportRevision, () => serverApi.publicIp(http, signal)),
      },
      {
        queryKey: [...healthQueryPrefix, 'tls'],
        queryFn: ({ signal }) =>
          readForTransport(
            accountLease,
            transportRevision,
            async () => (await serverApi.tlsStatus(http, signal)) ?? null,
          ),
      },
      {
        queryKey: [...healthQueryPrefix, 'admin'],
        queryFn: ({ signal }) =>
          readForTransport(
            accountLease,
            transportRevision,
            async () => (await serverApi.adminStatus(http, signal)) ?? null,
          ),
      },
      {
        queryKey: alertsQueryKey,
        enabled: !scopedCredentialSession,
        queryFn: ({ signal }) =>
          readForTransport(accountLease, transportRevision, () =>
            serverApi.serverAlerts(http, signal),
          ),
      },
    ],
  });
  const [envQ, keysQ, fcmQ, ipQ, tlsQ, adminQ, alertsQ] = healthQueries;
  const visibleServerInfo = accountCurrent ? serverInfo : null;
  const env = accountCurrent ? envQ.data : null;
  const keys = accountCurrent ? keysQ.data : null;
  const fcm = accountCurrent && !scopedCredentialSession ? fcmQ.data : null;
  const ip = accountCurrent ? (ipQ.data ?? null) : null;
  const tls = accountCurrent ? tlsQ.data : null;
  const admin = accountCurrent ? adminQ.data : null;
  const alerts = accountCurrent && !scopedCredentialSession ? (alertsQ.data ?? null) : null;
  const alertsPlaceholder = scopedCredentialSession
    ? 'Mac dashboard only'
    : alertsQ.isError && isUnimplementedEndpoint(alertsQ.error)
      ? 'Unavailable'
      : '—';
  const attemptedHealthQueries = scopedCredentialSession
    ? healthQueries.filter((_query, index) => index !== 2 && index !== 6)
    : healthQueries;
  const refreshing = accountCurrent && attemptedHealthQueries.some((q) => q.isFetching);
  // True when EVERY read failed → the server isn't answering the health channels at all (offline
  // or too old). Shown as a banner so an empty screen reads as a server issue, not an app bug.
  const allFailed = accountCurrent && attemptedHealthQueries.every((q) => q.isError);
  // Every typed route was absent. That is version/proxy compatibility, not proof that the server
  // is offline.
  const allUnsupported =
    allFailed && attemptedHealthQueries.every((q) => isUnimplementedEndpoint(q.error));

  const load = useCallback((): void => {
    if (!accountLease.isCurrent()) return;
    void queryClient.invalidateQueries({
      queryKey: ['server', 'health', accountLease.generation, transportRevision],
    });
  }, [accountLease, queryClient, transportRevision]);

  const onClearAlerts = (): void => {
    if (clearingAlerts || scopedCredentialSession || !accountLease.isCurrent()) return;
    const requestTransport = captureSessionTransportLease();
    if (requestTransport.revision !== transportRevision || !requestTransport.isCurrent()) return;
    setClearingAlerts(true);
    void (async () => {
      try {
        await runTrackedRealtimeWork(accountLease, async (activeLease) => {
          if (!activeLease.isCurrent() || !requestTransport.isCurrent()) return;
          await serverApi.clearServerAlerts(accountHttp(activeLease));
          if (!activeLease.isCurrent() || !requestTransport.isCurrent()) return;
          queryClient.setQueryData<ServerAlert[]>(alertsQueryKey, []);
        });
      } catch {
        if (accountLease.isCurrent() && requestTransport.isCurrent()) {
          showToast('Could not clear server alerts.');
        }
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
                  ? 'This server doesn’t expose health reporting. It may be an older version, or a proxy may be blocking its health endpoints.'
                  : 'The server isn’t responding to health checks. It may be offline, or running an older version that doesn’t report these details.'}
              </Text>
            </View>
          ) : null}
          <SettingsSection label="LEGACY PRIVATE API">
            <InfoRow label="Broad Messages transport" value="Retired; narrow features are gated" />
            <InfoRow label="Broad FaceTime transport" value="Retired; narrow features are gated" />
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
            <InfoRow
              label="Configured"
              value={scopedCredentialSession ? 'Mac dashboard only' : yesNo(fcm?.configured)}
            />
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
            <InfoRow label="Proxy" value={visibleServerInfo?.proxy_service ?? 'Direct'} />
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
              lastAlertType={rcsLastAlert}
              onReauthed={load}
              accountLease={accountLease}
              transportRevision={transportRevision}
            />
          )}

          <SettingsSection label="ALERTS" style={styles.gap}>
            {alerts == null ? (
              <InfoRow label="Server alerts" value={alertsPlaceholder} />
            ) : alerts.length === 0 ? (
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
            {alerts != null && alerts.length > 0 ? (
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

/** The RCS bridge (Google Messages) status row. The detailed status route is local-admin-only, so
 *  the remote app uses the advertised capability plus the latest live socket alert. */
function RcsBridgeSection({
  capability,
  lastAlertType,
  onReauthed,
  accountLease,
  transportRevision,
}: {
  capability: boolean;
  lastAlertType: string | null;
  onReauthed: () => void;
  accountLease: RealtimeDeliveryLease;
  transportRevision: number;
}): React.JSX.Element {
  const theme = useTheme();
  const health = deriveRcsHealth(capability, lastAlertType);
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
      {health.detail ? <NoteRow text={health.detail} /> : null}
      {capability ? (
        <RcsReconnectRow
          onDone={onReauthed}
          accountLease={accountLease}
          transportRevision={transportRevision}
        />
      ) : null}
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
  transportRevision,
}: {
  onDone: () => void;
  accountLease: RealtimeDeliveryLease;
  transportRevision: number;
}): React.JSX.Element {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    if (busy || !accountLease.isCurrent()) return;
    const requestTransport = captureSessionTransportLease();
    if (requestTransport.revision !== transportRevision || !requestTransport.isCurrent()) return;
    setBusy(true);
    try {
      await runTrackedRealtimeWork(accountLease, async (activeLease) => {
        if (!activeLease.isCurrent() || !requestTransport.isCurrent()) return;
        const healthBeforeRequest = useRcsHealthStore.getState();
        const res = await serverApi.rcsReauthNow(accountHttp(activeLease));
        if (!activeLease.isCurrent() || !requestTransport.isCurrent()) return;
        // A confirmed connection supersedes only the GAIA auth alert that prompted this request.
        // It does not prove a phone-offline/fatal condition recovered, and it must not overwrite a
        // newer socket signal that arrived while the request was in flight.
        if (
          res.connected &&
          healthBeforeRequest.lastAlertType === RCS_ALERT_TYPES.gaiaLoggedOut &&
          useRcsHealthStore.getState() === healthBeforeRequest
        ) {
          useRcsHealthStore.getState().setAlert(RCS_ALERT_TYPES.browserActive);
        }
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
      if (accountLease.isCurrent() && requestTransport.isCurrent()) {
        showToast('Could not reconnect the RCS bridge.');
      }
    } finally {
      if (accountLease.isCurrent()) setBusy(false);
    }
  }, [accountLease, busy, onDone, transportRevision]);

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
