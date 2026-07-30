import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { FindMyDevice, FindMyFriend } from '@core/findmy';
import { useFindMyStore } from '@state/findmyStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  hasCoordinates,
  redactBatteryPercent,
  redactLabel,
  redactLocationDetail,
  resolveDisplayPoint,
  safeOpenUrl,
  type DisplayPoint,
} from '@utils';
import { Screen, ScreenHeader, useTheme } from '@ui';
import { FindMyMap, FindMyMapHidden, type MapMarker } from '@ui/findmy/FindMyMap';

/**
 * Open the system maps app at a point.
 *
 * Takes a resolved {@link DisplayPoint} rather than raw store values ON PURPOSE: the type makes it
 * impossible to hand this function a coordinate that redacted mode was supposed to hide, which is
 * exactly the leak that used to exist here. Goes through `safeOpenUrl` (geo: is allowlisted)
 * instead of `Linking.openURL` so the scheme is validated at one place.
 */
function openInMaps(point: DisplayPoint, label: string): void {
  if (!point.visible) return;
  const { latitude, longitude } = point;
  void safeOpenUrl(
    `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(label)})`,
  );
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
  // FAIL CLOSED: treat "not yet hydrated" as redacted. The flag is read from kv asynchronously at
  // root mount, and this screen plots real home addresses — so a brief unredacted flash is the one
  // outcome worth designing against. Defence in depth (Find My is only reachable from home or
  // settings, both of which mount after hydrate) and it cannot flash the other way, since the
  // Find My data itself has not loaded yet either.
  const redacted = useRedactedModeStore((s) => s.enabled || !s.hydrated);
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

  // Every located entity becomes a map marker — but the COORDINATE is resolved first, so under
  // redaction nothing is pushed at all. Masking only the popup label (the old behaviour) still
  // plotted a real pin at a real address, which defeats the point of the mode.
  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    const push = (
      id: string,
      lat: number | null,
      lng: number | null,
      name: string,
      kind: string,
    ) => {
      const pt = resolveDisplayPoint(lat, lng, redacted);
      if (!pt.visible) return;
      // Label stays redacted too, as belt-and-braces for any future partial-visibility branch.
      out.push({
        id,
        lat: pt.latitude,
        lng: pt.longitude,
        label: redactLabel(name, kind, redacted),
      });
    };
    devices.forEach((d) => push(midDevice(d, 'd'), d.latitude, d.longitude, d.name, 'Device'));
    items.forEach((d) => push(midDevice(d, 'i'), d.latitude, d.longitude, d.name, 'Item'));
    friends.forEach((f) => push(midFriend(f), f.latitude, f.longitude, f.name, 'Person'));
    return out;
  }, [devices, items, friends, redacted]);

  // Carries no coordinate — just "is anything locatable", so the redacted screen can explain the
  // missing map instead of silently dropping a 260dp panel out of the layout.
  const anyLocated = useMemo(
    () => [...devices, ...items, ...friends].some((e) => hasCoordinates(e.latitude, e.longitude)),
    [devices, items, friends],
  );

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

      {/* `focusId` is masked too: a marker id can embed a device NAME, and it would otherwise ride
          into injectJavaScript. Under redaction there are no markers to recenter anyway. */}
      {markers.length > 0 ? (
        <FindMyMap markers={markers} focusId={redacted ? null : focusId} />
      ) : redacted && anyLocated ? (
        <FindMyMapHidden />
      ) : null}

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
                kind="Device"
                onFocus={() => setFocusId(midDevice(d, 'd'))}
              />
            ))
          : tab === 'items'
            ? items.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  redacted={redacted}
                  kind="Item"
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
  kind,
  onFocus,
}: {
  device: FindMyDevice;
  redacted: boolean;
  /** The items tab reuses this row, so the redacted placeholder must say "Item", not "Device". */
  kind: 'Device' | 'Item';
  onFocus: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const point = resolveDisplayPoint(device.latitude, device.longitude, redacted);
  const located = hasCoordinates(device.latitude, device.longitude);
  const name = redactLabel(device.name, kind, redacted);
  const detail = redactLocationDetail(device.address, located, redacted);
  const battery = redactBatteryPercent(device.batteryLevel, redacted);
  return (
    // Gated on `point.visible`, NOT `located`: under redaction there is no map to recenter, so the
    // row must be inert. One variable drives both gates so they cannot drift apart.
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
        <Pressable onPress={() => openInMaps(point, name)} hitSlop={10}>
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
  const point = resolveDisplayPoint(friend.latitude, friend.longitude, redacted);
  const located = hasCoordinates(friend.latitude, friend.longitude);
  const name = redactLabel(friend.name, 'Person', redacted);
  const detail = redactLocationDetail(friend.address, located, redacted);
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
        <Pressable onPress={() => openInMaps(point, name)} hitSlop={10}>
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
