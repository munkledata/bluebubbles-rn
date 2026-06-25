import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FindMyDevice, FindMyFriend } from '@core/findmy';
import { useFindMyStore } from '@state/findmyStore';
import { Screen, useTheme } from '@ui';

function openInMaps(lat: number | null, lng: number | null, label: string): void {
  if (lat == null || lng == null) return;
  void Linking.openURL(`geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label)})`);
}

/** Find My: devices + people with last location, battery, and "Open in Maps". */
export default function FindMyScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { devices, friends, items, loading, refreshing, error, load, refresh } = useFindMyStore();
  const [tab, setTab] = useState<'devices' | 'items' | 'people'>('devices');

  useEffect(() => {
    void load();
  }, [load]);

  const rows = tab === 'devices' ? devices : tab === 'items' ? items : friends;

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
        <Text style={[styles.title, { color: theme.color.label }]}>Find My</Text>
        <Pressable onPress={() => void refresh()} hitSlop={8} disabled={refreshing}>
          <Text style={[styles.refresh, { color: theme.color.tint }]}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Text>
        </Pressable>
      </View>

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
          ? devices.map((d) => <DeviceRow key={d.id} device={d} />)
          : tab === 'items'
            ? items.map((d) => <DeviceRow key={d.id} device={d} />)
            : friends.map((f) => <FriendRow key={f.id} friend={f} />)}
      </ScrollView>
    </Screen>
  );
}

function DeviceRow({ device }: { device: FindMyDevice }): React.JSX.Element {
  const theme = useTheme();
  const hasLoc = device.latitude != null && device.longitude != null;
  return (
    <Pressable
      onPress={() => openInMaps(device.latitude, device.longitude, device.name)}
      disabled={!hasLoc}
      style={[styles.row, { borderBottomColor: theme.color.separator }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: theme.color.label }]}>{device.name}</Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>
          {device.address ?? (hasLoc ? 'Location available' : 'No location')}
          {device.batteryLevel != null ? ` · 🔋 ${Math.round(device.batteryLevel * 100)}%` : ''}
        </Text>
      </View>
      {hasLoc ? <Text style={[styles.chev, { color: theme.color.tint }]}>Map ›</Text> : null}
    </Pressable>
  );
}

function FriendRow({ friend }: { friend: FindMyFriend }): React.JSX.Element {
  const theme = useTheme();
  const hasLoc = friend.latitude != null && friend.longitude != null;
  return (
    <Pressable
      onPress={() => openInMaps(friend.latitude, friend.longitude, friend.name)}
      disabled={!hasLoc}
      style={[styles.row, { borderBottomColor: theme.color.separator }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: theme.color.label }]}>{friend.name}</Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>
          {friend.address ?? 'No location'}
        </Text>
      </View>
      {hasLoc ? <Text style={[styles.chev, { color: theme.color.tint }]}>Map ›</Text> : null}
    </Pressable>
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
  refresh: { fontSize: 15 },
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
