import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { FindMyDevice, FindMyFriend } from '@core/findmy';
import { useFindMyStore } from '@state/findmyStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { redactTitle } from '@utils';
import { Screen, ScreenHeader, useTheme } from '@ui';
import { FindMyMap, type MapMarker } from '@ui/findmy/FindMyMap';

function openInMaps(lat: number | null, lng: number | null, label: string): void {
  if (lat == null || lng == null) return;
  void Linking.openURL(`geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label)})`);
}

/** Find My: an interactive OSM map + devices/items/people with last location and battery. */
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
  const redacted = useRedactedModeStore((s) => s.enabled);
  const [tab, setTab] = useState<'devices' | 'items' | 'people'>('devices');
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-ish locations: the Gator Find My backend is a read-only cache (no location push events),
  // so instead of a socket subscription we poll a server refresh every 60s while this screen is
  // open. The store's `refreshing` guard coalesces overlapping refreshes.
  useEffect(() => {
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Marker id namespaces the source so a device + friend can't collide; the list rows reuse it.
  const midDevice = (d: FindMyDevice, k: 'd' | 'i'): string => `${k}:${d.id}`;
  const midFriend = (f: FindMyFriend): string => `p:${f.id}`;

  // Every located entity becomes a map marker; redacted mode masks the popup label.
  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    const push = (
      id: string,
      lat: number | null,
      lng: number | null,
      name: string,
      kind: string,
    ) => {
      if (lat != null && lng != null) out.push({ id, lat, lng, label: redacted ? kind : name });
    };
    devices.forEach((d) => push(midDevice(d, 'd'), d.latitude, d.longitude, d.name, 'Device'));
    items.forEach((d) => push(midDevice(d, 'i'), d.latitude, d.longitude, d.name, 'Item'));
    friends.forEach((f) => push(midFriend(f), f.latitude, f.longitude, f.name, 'Person'));
    return out;
  }, [devices, items, friends, redacted]);

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
                redacted={redacted}
                onFocus={() => setFocusId(midDevice(d, 'd'))}
              />
            ))
          : tab === 'items'
            ? items.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  redacted={redacted}
                  onFocus={() => setFocusId(midDevice(d, 'i'))}
                />
              ))
            : friends.map((f) => (
                <FriendRow
                  key={f.id}
                  friend={f}
                  redacted={redacted}
                  onFocus={() => setFocusId(midFriend(f))}
                />
              ))}
      </ScrollView>
    </Screen>
  );
}

function DeviceRow({
  device,
  redacted,
  onFocus,
}: {
  device: FindMyDevice;
  redacted: boolean;
  onFocus: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const hasLoc = device.latitude != null && device.longitude != null;
  const name = redacted ? redactTitle(device.name, true) : device.name;
  return (
    <Pressable
      onPress={hasLoc ? onFocus : undefined}
      disabled={!hasLoc}
      style={[styles.row, { borderBottomColor: theme.color.separator }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: theme.color.label }]}>{name}</Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>
          {redacted
            ? hasLoc
              ? 'Location available'
              : 'No location'
            : (device.address ?? (hasLoc ? 'Location available' : 'No location'))}
          {device.batteryLevel != null ? ` · 🔋 ${Math.round(device.batteryLevel * 100)}%` : ''}
        </Text>
      </View>
      {hasLoc ? (
        <Pressable onPress={() => openInMaps(device.latitude, device.longitude, name)} hitSlop={10}>
          <Text style={[styles.chev, { color: theme.color.tint }]}>Open ↗</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function FriendRow({
  friend,
  redacted,
  onFocus,
}: {
  friend: FindMyFriend;
  redacted: boolean;
  onFocus: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const hasLoc = friend.latitude != null && friend.longitude != null;
  const name = redacted ? redactTitle(friend.name, true) : friend.name;
  return (
    <Pressable
      onPress={hasLoc ? onFocus : undefined}
      disabled={!hasLoc}
      style={[styles.row, { borderBottomColor: theme.color.separator }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: theme.color.label }]}>{name}</Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>
          {redacted
            ? hasLoc
              ? 'Location available'
              : 'No location'
            : (friend.address ?? 'No location')}
        </Text>
      </View>
      {hasLoc ? (
        <Pressable onPress={() => openInMaps(friend.latitude, friend.longitude, name)} hitSlop={10}>
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
