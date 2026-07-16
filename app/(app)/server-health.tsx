import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { serverApi } from '@core/api';
import type { RcsStatus, ServerAlert } from '@core/api/endpoints/server';
import { deriveRcsHealth, deriveRcsHealthFromStatus, type RcsSeverity } from '@core/realtime';
import { http } from '@/services';
import { useSessionStore } from '@state/sessionStore';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { InfoRow, NavRow, NoteRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

const yesNo = (v: boolean | null | undefined): string => (v == null ? '—' : v ? 'Yes' : 'No');
const okBad = (v: boolean | null | undefined): string =>
  v == null ? '—' : v ? 'Connected' : 'Not connected';

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
  // RCS bridge (Google Messages): the capability boolean gates the section (absent on older
  // servers → hidden). The rich, accurate health block comes from the NON-admin `get-rcs-status`
  // channel (fetched below); the live `rcs-alert` socket event is kept as an immediacy override so
  // a fresh alert updates the card between refetches.
  const rcsCapability = serverInfo?.rcs;
  const rcsLastAlert = useRcsHealthStore((s) => s.lastAlertType);
  const rcsLastAlertAt = useRcsHealthStore((s) => s.lastAlertAt);

  // Each read is its own query — a failure just leaves that card at "—" (data stays undefined),
  // never blocks the rest. The `?? null` coercions matter: most of these endpoints can resolve
  // `undefined` (nullish zod schemas), which TanStack Query treats as an error.
  const queryClient = useQueryClient();
  const healthQueries = useQueries({
    queries: [
      {
        queryKey: ['server', 'health', 'private-api'],
        queryFn: async () => (await serverApi.privateApiStatus(http)) ?? null,
      },
      {
        queryKey: ['server', 'health', 'env'],
        queryFn: async () => (await serverApi.serverEnv(http)) ?? null,
      },
      {
        queryKey: ['server', 'health', 'findmy-keys'],
        queryFn: async () => (await serverApi.findMyKeysStatus(http)) ?? null,
      },
      {
        queryKey: ['server', 'health', 'fcm'],
        queryFn: async () => (await serverApi.fcmStatus(http)) ?? null,
      },
      {
        queryKey: ['server', 'health', 'zrok'],
        queryFn: async () => (await serverApi.zrokStatus(http)) ?? null,
      },
      {
        queryKey: ['server', 'health', 'public-ip'],
        queryFn: () => serverApi.publicIp(http),
      },
      {
        queryKey: ['server', 'health', 'tls'],
        queryFn: async () => (await serverApi.tlsStatus(http)) ?? null,
      },
      {
        queryKey: ['server', 'health', 'admin'],
        queryFn: async () => (await serverApi.adminStatus(http)) ?? null,
      },
      {
        queryKey: ['server', 'health', 'alerts'],
        queryFn: () => serverApi.serverAlerts(http),
      },
      // Older servers lack the `get-rcs-status` channel (reject / `[]` sentinel → schema fail):
      // the query stays errored so the RCS row degrades to the capability-only signal.
      {
        queryKey: ['server', 'health', 'rcs'],
        queryFn: async () => (await serverApi.rcsStatus(http)) ?? null,
      },
    ],
  });
  const [paQ, envQ, keysQ, fcmQ, zrokQ, ipQ, tlsQ, adminQ, alertsQ, rcsQ] = healthQueries;
  const pa = paQ.data;
  const env = envQ.data;
  const keys = keysQ.data;
  const fcm = fcmQ.data;
  const zrok = zrokQ.data;
  const ip = ipQ.data ?? null;
  const tls = tlsQ.data;
  const admin = adminQ.data;
  const alerts = alertsQ.data ?? [];
  // The live `get-rcs-status` block + when it last resolved (to decide whether a socket alert is
  // fresher than the fetch). No data = channel unavailable (older server) → capability-only.
  const rcs = rcsQ.data ?? null;
  const rcsFetchedAt = rcsQ.dataUpdatedAt > 0 ? rcsQ.dataUpdatedAt : null;
  const refreshing = healthQueries.some((q) => q.isFetching);
  // True when EVERY read failed → the server isn't answering the health channels at all (offline
  // or too old). Shown as a banner so an empty screen reads as a server issue, not an app bug.
  const allFailed = healthQueries.every((q) => q.isError);

  const load = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', 'health'] });
  }, [queryClient]);

  const onClearAlerts = (): void => {
    void serverApi
      .clearServerAlerts(http)
      .finally(() => queryClient.setQueryData<ServerAlert[]>(['server', 'health', 'alerts'], []));
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
          <Pressable onPress={load} hitSlop={8} disabled={refreshing}>
            <Text style={[styles.action, { color: theme.color.tint }]} numberOfLines={1}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Text>
          </Pressable>
        }
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={load} tintColor={theme.color.tint} />
        }
      >
        {allFailed ? (
          <View style={[styles.banner, { backgroundColor: theme.color.secondaryBackground }]}>
            <Text style={[styles.hint, { color: theme.color.destructive }]}>
              The server isn’t responding to health checks. It may be offline, or running an older
              version that doesn’t report these details.
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
            value={env?.version ?? serverInfo?.server_version ?? 'Unknown'}
          />
          <InfoRow label="macOS" value={serverInfo?.os_version ?? 'Unknown'} />
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
            <NavRow label="Clear Alerts" chevron={false} onPress={onClearAlerts} />
          ) : null}
        </SettingsSection>
      </ScrollView>
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
}: {
  capability: boolean;
  status: RcsStatus;
  statusFetchedAt: number | null;
  lastAlertType: string | null;
  lastAlertAt: number | null;
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
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  action: { fontSize: 15, textAlign: 'right' },
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
  hint: { fontSize: 12, lineHeight: 17 },
  banner: { borderRadius: 12, padding: 14, marginBottom: 8 },
  alertText: { fontSize: 14, flex: 1 },
});
