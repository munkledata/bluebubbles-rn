import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type AppStateStatus,
} from 'react-native';
import type { FindMyDevice, FindMyFriend } from '@core/findmy';
import { useFindMyStore } from '@state/findmyStore';
import { useLockStore } from '@state/lockStore';
import { hasCoordinates, resolveDisplayPoint, safeOpenUrl, type DisplayPoint } from '@utils';
import { Screen, ScreenHeader, useTheme } from '@ui';
import {
  FindMyMap,
  MAX_FINDMY_MAP_MARKERS,
  type MapFocusRequest,
  type MapMarker,
} from '@ui/findmy/FindMyMap';
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
  const locked = useLockStore((s) => s.locked);
  const [tab, setTab] = useState<'devices' | 'items' | 'people'>('devices');
  const [mapFocusRequest, setMapFocusRequest] = useState<MapFocusRequest | null>(null);
  const [routeFocused, setRouteFocused] = useState(false);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const focusRevisionRef = useRef(0);
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
      setRouteFocused(true);
      return () => {
        routeFocusedRef.current = false;
        setRouteFocused(false);
        setMapFocusRequest(null);
        activeMapOpenRef.current = null;
      };
    }, []),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

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

  const refreshFindMy = useCallback(async (): Promise<void> => {
    setMapFocusRequest(null);
    await refresh();
  }, [refresh]);

  // The backend is a read-only cache (no location push events). Poll only while this route is
  // focused AND the app is active; returning to it gets an immediate refresh.
  useFindMyPolling(refreshFindMy);

  // Every located entity becomes a map marker only after the coordinate pair passes the shared
  // geographic validator. Short source/index ids stay unique without sending server-owned ids
  // across the native bridge. A partial location must never fall through to accidental (0, 0).
  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    const push = (id: string, lat: number | null, lng: number | null, name: string) => {
      if (out.length >= MAX_FINDMY_MAP_MARKERS) return;
      const pt = resolveDisplayPoint(lat, lng);
      if (!pt.visible) return;
      out.push({
        id,
        lat: pt.latitude,
        lng: pt.longitude,
        label: name,
      });
    };
    devices.forEach((device, index) =>
      push(`d:${index}`, device.latitude, device.longitude, device.name),
    );
    items.forEach((item, index) => push(`i:${index}`, item.latitude, item.longitude, item.name));
    friends.forEach((friend, index) =>
      push(`p:${index}`, friend.latitude, friend.longitude, friend.name),
    );
    return out;
  }, [devices, items, friends]);

  const mappedMarkerIds = useMemo(() => new Set(markers.map(({ id }) => id)), [markers]);
  const focusMapMarker = useCallback((id: string): void => {
    focusRevisionRef.current += 1;
    setMapFocusRequest({ id, revision: focusRevisionRef.current });
  }, []);

  const rows = tab === 'devices' ? devices : tab === 'items' ? items : friends;

  return (
    <Screen>
      <ScreenHeader
        title="Find My"
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={() => void refreshFindMy()}
            hitSlop={8}
            disabled={refreshing}
            accessibilityRole="button"
            accessibilityLabel="Refresh Find My"
            accessibilityState={{ disabled: refreshing, busy: refreshing }}
          >
            <Text numberOfLines={1} style={[styles.refresh, { color: theme.color.tint }]}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Text>
          </Pressable>
        }
      />

      {markers.length > 0 && routeFocused && appState === 'active' && !locked ? (
        <FindMyMap markers={markers} focusRequest={mapFocusRequest} />
      ) : null}

      <View style={[styles.tabs, { borderBottomColor: theme.color.separator }]}>
        {(['devices', 'items', 'people'] as const).map((t) => (
          <Pressable
            key={t}
            onPress={() => setTab(t)}
            style={styles.tab}
            accessibilityRole="tab"
            accessibilityLabel={t === 'devices' ? 'Devices' : t === 'items' ? 'Items' : 'People'}
            accessibilityState={{ selected: tab === t }}
          >
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
            onRefresh={() => void refreshFindMy()}
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
          ? devices.map((d, index) => (
              <DeviceRow
                key={`${d.id}:${index}`}
                device={d}
                onFocus={
                  mappedMarkerIds.has(`d:${index}`) ? () => focusMapMarker(`d:${index}`) : undefined
                }
                onOpenLocation={openInMaps}
              />
            ))
          : tab === 'items'
            ? items.map((d, index) => (
                <DeviceRow
                  key={`${d.id}:${index}`}
                  device={d}
                  onFocus={
                    mappedMarkerIds.has(`i:${index}`)
                      ? () => focusMapMarker(`i:${index}`)
                      : undefined
                  }
                  onOpenLocation={openInMaps}
                />
              ))
            : friends.map((f, index) => (
                <FriendRow
                  key={`${f.id}:${index}`}
                  friend={f}
                  onFocus={
                    mappedMarkerIds.has(`p:${index}`)
                      ? () => focusMapMarker(`p:${index}`)
                      : undefined
                  }
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
  onFocus?: () => void;
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
      onPress={point.visible && onFocus ? onFocus : undefined}
      disabled={!point.visible || !onFocus}
      accessible={false}
      importantForAccessibility="no"
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
        <Pressable
          onPress={() => onOpenLocation(point, name)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Open ${name} in Maps`}
        >
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
  onFocus?: () => void;
  onOpenLocation: (point: DisplayPoint, label: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const point = resolveDisplayPoint(friend.latitude, friend.longitude);
  const located = hasCoordinates(friend.latitude, friend.longitude);
  const name = friend.name;
  const detail = friend.address ?? (located ? 'Location available' : 'No location');
  return (
    <Pressable
      onPress={point.visible && onFocus ? onFocus : undefined}
      disabled={!point.visible || !onFocus}
      accessible={false}
      importantForAccessibility="no"
      style={[styles.row, { borderBottomColor: theme.color.separator }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: theme.color.label }]}>{name}</Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>{detail}</Text>
      </View>
      {point.visible ? (
        <Pressable
          onPress={() => onOpenLocation(point, name)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Open ${name} in Maps`}
        >
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
