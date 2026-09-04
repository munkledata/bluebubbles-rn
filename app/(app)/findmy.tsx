import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { FindMyDevice, FindMyFriend } from '@core/findmy';
import { useFindMyStore } from '@state/findmyStore';
import { hasCoordinates, resolveDisplayPoint, safeOpenUrl, type DisplayPoint } from '@utils';
import { Screen, ScreenHeader, useTheme } from '@ui';
import { FindMyMap, type MapMarker } from '@ui/findmy/FindMyMap';
import { showExternalOpenFailure } from '@ui/toast/external-open-feedback';
import { useFindMyPolling } from '@/features/findmy/use-find-my-polling';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';

/** Find My: devices/items/people with last location, battery, and explicit system-map actions. */
export default function FindMyScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const devices = useFindMyStore((s) => s.devices);
  const friends = useFindMyStore((s) => s.friends);
  const items = useFindMyStore((s) => s.items);
  const loading = useFindMyStore((s) => s.loading);
  const refreshing = useFindMyStore((s) => s.refreshing);
  const error = useFindMyStore((s) => s.error);
  const load = useFindMyStore((s) => s.load);
  const refresh = useFindMyStore((s) => s.refresh);
  const [tab, setTab] = useState<'devices' | 'items' | 'people'>('devices');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const mountedRef = useRef(true);
  const routeFocusedRef = useRef(false);
  const activeMapOpenRef = useRef<{ token: symbol; url: string } | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeMapOpenRef.current = null;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      routeFocusedRef.current = true;
      return () => {
        routeFocusedRef.current = false;
        activeMapOpenRef.current = null;
      };
    }, []),
  );

  /**
   * Hand one validated point to Android Maps and keep any delayed failure feedback owned by this
   * focused route/account. One route-wide operation may run at a time, so repeated taps cannot
   * launch duplicate native work or enqueue duplicate failure toasts.
   */
  const openInMaps = useCallback(
    (point: DisplayPoint, label: string): void => {
      const operationIsCurrent = (): boolean =>
        mountedRef.current && routeFocusedRef.current && accountLease.isCurrent();
      if (!point.visible || !operationIsCurrent()) return;
      const { latitude, longitude } = point;
      const url = `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(label)})`;
      if (activeMapOpenRef.current) return;
      const token = Symbol('find-my-map-open');
      activeMapOpenRef.current = { token, url };
      void (async () => {
        try {
          const opened = await safeOpenUrl(url);
          if (!opened && activeMapOpenRef.current?.token === token && operationIsCurrent()) {
            showExternalOpenFailure();
          }
        } catch {
          if (activeMapOpenRef.current?.token === token && operationIsCurrent()) {
            showExternalOpenFailure();
          }
        } finally {
          if (activeMapOpenRef.current?.token === token) activeMapOpenRef.current = null;
        }
      })();
    },
    [accountLease],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The backend is a read-only cache (no location push events). Poll only while this route is
  // focused AND the app is active; returning to it gets an immediate refresh.
  useFindMyPolling(refresh);

  // Marker id namespaces the source so a device + friend can't collide; the list rows reuse it.
  const midDevice = (d: FindMyDevice, k: 'd' | 'i'): string => `${k}:${d.id}`;
  const midFriend = (f: FindMyFriend): string => `p:${f.id}`;

  // Every located entity becomes a map marker only after the coordinate pair passes the shared
  // finite-value validator. A partial location must never fall through to an accidental (0, 0).
  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    const push = (id: string, lat: number | null, lng: number | null, name: string) => {
      const pt = resolveDisplayPoint(lat, lng);
      if (!pt.visible) return;
      out.push({
        id,
        lat: pt.latitude,
        lng: pt.longitude,
        label: name,
      });
    };
    devices.forEach((d) => push(midDevice(d, 'd'), d.latitude, d.longitude, d.name));
    items.forEach((d) => push(midDevice(d, 'i'), d.latitude, d.longitude, d.name));
    friends.forEach((f) => push(midFriend(f), f.latitude, f.longitude, f.name));
    return out;
  }, [devices, items, friends]);

  const rows = tab === 'devices' ? devices : tab === 'items' ? items : friends;

  return (
    <Screen>
      <ScreenHeader
        title="Find My"
        onBack={() => router.back()}
        right={
          <Pressable onPress={() => void refresh()} hitSlop={8} disabled={refreshing}>
            <Text numberOfLines={1} style={[styles.refresh, { color: theme.color.tint }]}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Text>
          </Pressable>
        }
      />

      {markers.length > 0 ? <FindMyMap markers={markers} focusId={focusId} /> : null}

      <View style={[styles.tabs, { borderBottomColor: theme.color.separator }]}>
        {(['devices', 'items', 'people'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={styles.tab}>
            <Text
              style={[
                styles.tabText,
                { color: tab === t ? theme.color.tint : theme.color.secondaryLabel },
              ]}
            >
              {t === 'devices' ? 'Devices' : t === 'items' ? 'Items' : 'People'}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={theme.color.tint}
          />
        }
      >
        {error ? (
          <Text style={[styles.empty, { color: theme.color.destructive }]}>{error}</Text>
        ) : null}
        {!error && rows.length === 0 ? (
          <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>
            {loading
              ? 'Loading…'
              : tab === 'devices'
                ? 'No devices'
                : tab === 'items'
                  ? 'No items'
                  : 'No people'}
          </Text>
        ) : null}
        {tab === 'devices'
          ? devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                onFocus={() => setFocusId(midDevice(d, 'd'))}
                onOpenLocation={openInMaps}
              />
            ))
          : tab === 'items'
            ? items.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  onFocus={() => setFocusId(midDevice(d, 'i'))}
                  onOpenLocation={openInMaps}
                />
              ))
            : friends.map((f) => (
                <FriendRow
                  key={f.id}
                  friend={f}
                  onFocus={() => setFocusId(midFriend(f))}
                  onOpenLocation={openInMaps}
                />
              ))}
      </ScrollView>
    </Screen>
  );
}

function DeviceRow({
  device,
  onFocus,
  onOpenLocation,
}: {
  device: FindMyDevice;
  onFocus: () => void;
  onOpenLocation: (point: DisplayPoint, label: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const point = resolveDisplayPoint(device.latitude, device.longitude);
  const located = hasCoordinates(device.latitude, device.longitude);
  const name = device.name;
  const detail = device.address ?? (located ? 'Location available' : 'No location');
  const batteryLevel = device.batteryLevel;
  const battery =
    typeof batteryLevel === 'number' && Number.isFinite(batteryLevel)
      ? Math.round(batteryLevel * 100)
      : null;
  return (
    // One validated point drives focus and native-map admission so those paths cannot drift apart.
    <Pressable
      onPress={point.visible ? onFocus : undefined}
      disabled={!point.visible}
      style={[styles.row, { borderBottomColor: theme.color.separator }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: theme.color.label }]}>{name}</Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>
          {detail}
          {battery != null ? ` · 🔋 ${battery}%` : ''}
        </Text>
      </View>
      {point.visible ? (
        <Pressable onPress={() => onOpenLocation(point, name)} hitSlop={10}>
          <Text style={[styles.chev, { color: theme.color.tint }]}>Open ↗</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function FriendRow({
  friend,
  onFocus,
  onOpenLocation,
}: {
  friend: FindMyFriend;
  onFocus: () => void;
  onOpenLocation: (point: DisplayPoint, label: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const point = resolveDisplayPoint(friend.latitude, friend.longitude);
  const located = hasCoordinates(friend.latitude, friend.longitude);
  const name = friend.name;
  const detail = friend.address ?? (located ? 'Location available' : 'No location');
  return (
    <Pressable
      onPress={point.visible ? onFocus : undefined}
      disabled={!point.visible}
      style={[styles.row, { borderBottomColor: theme.color.separator }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: theme.color.label }]}>{name}</Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>{detail}</Text>
      </View>
      {point.visible ? (
        <Pressable onPress={() => onOpenLocation(point, name)} hitSlop={10}>
          <Text style={[styles.chev, { color: theme.color.tint }]}>Open ↗</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  refresh: { fontSize: 15, textAlign: 'right' },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabText: { fontSize: 15, fontWeight: '600' },
  content: { paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1 },
  name: { fontSize: 16, fontWeight: '500' },
  sub: { fontSize: 13, marginTop: 3 },
  chev: { fontSize: 15, fontWeight: '500' },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
