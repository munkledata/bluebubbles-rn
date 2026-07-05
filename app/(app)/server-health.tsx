import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { serverApi } from '@core/api';
import type {
  AdminStatus,
  FcmStatus,
  FindMyKeysStatus,
  PrivateApiStatus,
  RcsStatus,
  ServerAlert,
  ServerEnv,
  TlsStatus,
  ZrokStatus,
} from '@core/api/endpoints/server';
import { deriveRcsHealth, deriveRcsHealthFromStatus, type RcsSeverity } from '@core/realtime';
import { http } from '@/services';
import { useSessionStore } from '@state/sessionStore';
import { useRcsHealthStore } from '@state/rcsHealthStore';
import { Screen, useTheme } from '@ui';

const yesNo = (v: boolean | null | undefined): string => (v == null ? '—' : v ? 'Yes' : 'No');
const okBad = (v: boolean | null | undefined): string => (v == null ? '—' : v ? 'Connected' : 'Not connected');

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
  const insets = useSafeAreaInsets();
  const serverInfo = useSessionStore((s) => s.serverInfo);
  // RCS bridge (Google Messages): the capability boolean gates the section (absent on older
  // servers → hidden). The rich, accurate health block comes from the NON-admin `get-rcs-status`
  // channel (fetched below); the live `rcs-alert` socket event is kept as an immediacy override so
  // a fresh alert updates the card between refetches.
  const rcsCapability = serverInfo?.rcs;
  const rcsLastAlert = useRcsHealthStore((s) => s.lastAlertType);
  const rcsLastAlertAt = useRcsHealthStore((s) => s.lastAlertAt);

  const [pa, setPa] = useState<PrivateApiStatus>(null);
  const [env, setEnv] = useState<ServerEnv>(null);
  const [keys, setKeys] = useState<FindMyKeysStatus>(null);
  const [fcm, setFcm] = useState<FcmStatus>(null);
  const [zrok, setZrok] = useState<ZrokStatus>(null);
  const [ip, setIp] = useState<string | null>(null);
  const [tls, setTls] = useState<TlsStatus>(null);
  const [admin, setAdmin] = useState<AdminStatus>(null);
  const [alerts, setAlerts] = useState<ServerAlert[]>([]);
  // The live `get-rcs-status` block + when it last resolved (to decide whether a socket alert is
  // fresher than the fetch). `null` block = channel unavailable (older server) → capability-only.
  const [rcs, setRcs] = useState<RcsStatus>(null);
  const [rcsFetchedAt, setRcsFetchedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((): void => {
    setRefreshing(true);
    // Each read is independent — a failure just leaves that card at "—", never blocks the rest.
    void Promise.allSettled([
      serverApi.privateApiStatus(http).then(setPa, () => {}),
      serverApi.serverEnv(http).then(setEnv, () => {}),
      serverApi.findMyKeysStatus(http).then(setKeys, () => {}),
      serverApi.fcmStatus(http).then(setFcm, () => {}),
      serverApi.zrokStatus(http).then(setZrok, () => {}),
      serverApi.publicIp(http).then(setIp, () => {}),
      serverApi.tlsStatus(http).then(setTls, () => {}),
      serverApi.adminStatus(http).then(setAdmin, () => {}),
      serverApi.serverAlerts(http).then(setAlerts, () => {}),
      // Older servers lack the `get-rcs-status` channel (reject / `[]` sentinel → schema fail):
      // leave the block null so the RCS row degrades to the capability-only signal.
      serverApi.rcsStatus(http).then(
        (r) => {
          setRcs(r);
          setRcsFetchedAt(Date.now());
        },
        () => {},
      ),
    ]).finally(() => setRefreshing(false));
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional on-mount fetch (sets
  // the refreshing flag, then fills each card as its read resolves).
  useEffect(() => load(), [load]);

  const onClearAlerts = (): void => {
    void serverApi.clearServerAlerts(http).finally(() => setAlerts([]));
  };

  const tlsMode = tls ? String(tls.mode ?? tls.tls_mode ?? (tls.enabled ? 'enabled' : 'off')) : null;
  const tlsDomain = tls ? (tls.domain ?? tls.tls_domain ?? tls.commonName) : null;

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
        <Text style={[styles.title, { color: theme.color.label }]}>Server Health</Text>
        <Pressable onPress={load} hitSlop={8} disabled={refreshing}>
          <Text style={[styles.action, { color: theme.color.tint }]}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={load} tintColor={theme.color.tint} />
        }
      >
        <Section label="PRIVATE API" theme={theme}>
          <InfoRow label="Messages helper" theme={theme}>
            {pa?.enabled === false ? 'Disabled' : okBad(pa?.connected)}
          </InfoRow>
          <InfoRow label="FaceTime helper" theme={theme}>
            {pa?.ft_enabled === false ? 'Disabled' : okBad(pa?.ft_connected)}
          </InfoRow>
        </Section>

        <Section label="FIND MY KEYS" theme={theme}>
          <InfoRow label="LocalStorage (friends)" theme={theme}>
            {keyState(keys?.LocalStorage)}
          </InfoRow>
          <InfoRow label="FMIP (devices)" theme={theme}>
            {keyState(keys?.FMIP)}
          </InfoRow>
          <InfoRow label="FMF (people cache)" theme={theme}>
            {keyState(keys?.FMF)}
          </InfoRow>
          {env?.findmyNeedsKeys ? (
            <View style={[styles.hintRow, { borderTopColor: theme.color.separator }]}>
              <Text style={[styles.hint, { color: theme.color.tertiaryLabel }]}>
                macOS 14.4+ encrypts the Find My caches — import keys on the server console if a
                key above is missing, or Find My tabs stay empty.
              </Text>
            </View>
          ) : null}
        </Section>

        <Section label="PUSH (FCM)" theme={theme}>
          <InfoRow label="Configured" theme={theme}>
            {yesNo(fcm?.configured)}
          </InfoRow>
          {fcm?.projectId ? (
            <InfoRow label="Project" theme={theme}>
              {fcm.projectId}
            </InfoRow>
          ) : null}
        </Section>

        <Section label="ENVIRONMENT" theme={theme}>
          <InfoRow label="Server version" theme={theme}>
            {env?.version ?? serverInfo?.server_version ?? 'Unknown'}
          </InfoRow>
          <InfoRow label="macOS" theme={theme}>
            {serverInfo?.os_version ?? 'Unknown'}
          </InfoRow>
          <InfoRow label="Node" theme={theme}>
            {env?.node ?? 'Unknown'}
          </InfoRow>
          <InfoRow label="Uptime" theme={theme}>
            {formatUptime(admin?.uptimeMs)}
          </InfoRow>
        </Section>

        <Section label="CONNECTION" theme={theme}>
          <InfoRow label="Tunnel (zrok)" theme={theme}>
            {zrok?.running ? 'Running' : zrok?.available ? 'Available' : 'Off'}
          </InfoRow>
          {zrok?.url ? (
            <InfoRow label="Tunnel URL" theme={theme}>
              {zrok.url}
            </InfoRow>
          ) : null}
          <InfoRow label="Public IP" theme={theme}>
            {ip ?? '—'}
          </InfoRow>
          <InfoRow label="TLS" theme={theme}>
            {tlsMode ?? '—'}
            {typeof tlsDomain === 'string' && tlsDomain ? ` · ${tlsDomain}` : ''}
          </InfoRow>
        </Section>

        {rcsCapability == null ? null : (
          <RcsBridgeSection
            capability={rcsCapability}
            status={rcs}
            statusFetchedAt={rcsFetchedAt}
            lastAlertType={rcsLastAlert}
            lastAlertAt={rcsLastAlertAt}
            theme={theme}
          />
        )}

        <Section label="ALERTS" theme={theme}>
          {alerts.length === 0 ? (
            <InfoRow label="Server alerts" theme={theme}>
              None
            </InfoRow>
          ) : (
            <>
              {alerts.map((a) => (
                <View key={a.id} style={[styles.row, { borderTopColor: theme.color.separator }]}>
                  <Text style={[styles.alertText, { color: theme.color.label }]} numberOfLines={3}>
                    {a.value ?? a.type ?? 'Alert'}
                  </Text>
                </View>
              ))}
              <Pressable
                onPress={onClearAlerts}
                style={[styles.row, { borderTopColor: theme.color.separator }]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.tint }]}>Clear Alerts</Text>
              </Pressable>
            </>
          )}
        </Section>
      </ScrollView>
    </Screen>
  );
}

function keyState(k: { present?: boolean | null; valid?: boolean | null } | null | undefined): string {
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
  theme,
}: {
  capability: boolean;
  status: RcsStatus;
  statusFetchedAt: number | null;
  lastAlertType: string | null;
  lastAlertAt: number | null;
  theme: ReturnType<typeof useTheme>;
}): React.JSX.Element {
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
    <Section label="RCS BRIDGE" theme={theme}>
      <View style={[styles.row, { borderTopColor: theme.color.separator }]}>
        <Text style={[styles.rowLabel, { color: theme.color.label }]}>Google Messages</Text>
        <Text
          style={[styles.rowValue, { color: severityColor(health.severity, theme) }]}
          numberOfLines={1}
          accessibilityLabel={`RCS bridge ${health.status}`}
        >
          {health.status}
        </Text>
      </View>
      {phoneID ? (
        <View style={[styles.row, { borderTopColor: theme.color.separator }]}>
          <Text style={[styles.rowLabel, { color: theme.color.label }]}>Phone</Text>
          <Text
            style={[styles.rowValue, { color: theme.color.secondaryLabel }]}
            numberOfLines={1}
          >
            {phoneID}
          </Text>
        </View>
      ) : null}
      {health.detail ? (
        <View style={[styles.hintRow, { borderTopColor: theme.color.separator }]}>
          <Text style={[styles.hint, { color: theme.color.tertiaryLabel }]}>{health.detail}</Text>
        </View>
      ) : null}
    </Section>
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
      <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>{children}</View>
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
  action: { fontSize: 15 },
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
  hintRow: { paddingVertical: 10, paddingHorizontal: 14, borderTopWidth: StyleSheet.hairlineWidth },
  hint: { fontSize: 12, lineHeight: 17 },
  alertText: { fontSize: 14, flex: 1 },
});
