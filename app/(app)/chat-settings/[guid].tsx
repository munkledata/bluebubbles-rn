import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { chatsApi } from '@core/api';
import { getDatabase } from '@db/database';
import {
  deleteChatLocal,
  getChatParticipants,
  persistServerChat,
  setChatCustomization,
  setChatMute,
} from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { http } from '@/services';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { isGroupRow, resolveTitle } from '@utils';
import { Screen, useTheme } from '@ui';

/** Preset accent colors for the per-chat bubble color (plus "Default"). */
const SWATCHES = ['#1982FC', '#34C759', '#AF52DE', '#FF2D55', '#FF9500', '#5E81AC'];

/** Per-chat customization: custom name, accent color, mute. */
export default function ChatSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { guid } = useLocalSearchParams<{ guid: string }>();
  const { data } = useChatHeader(guid);

  // Local input state seeded once from the row; writes persist immediately.
  const [name, setName] = useState<string | null>(null);
  const customName = name ?? data?.customName ?? '';
  const muted = data?.muteType === 'mute';
  const accent = data?.customColor ?? null;
  // The placeholder shows what the title would be WITHOUT a custom name.
  const serverTitle = data ? resolveTitle({ ...data, customName: null }) : '';

  const isGroup = data ? isGroupRow(data) : false;
  const divider = {
    borderTopColor: theme.color.separator,
    borderTopWidth: StyleSheet.hairlineWidth,
  };

  // SERVER-GATED (private API): leave on the server, then drop the chat locally.
  const leaveGroup = (): void => {
    Alert.alert('Leave Group', 'Leave this conversation on the server and remove it here?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await chatsApi.leaveChat(http, guid);
              await deleteChatLocal(getDatabase(), guid);
              router.back();
            } catch {
              Alert.alert(
                'Leave Group',
                'Couldn’t leave — the server needs the private API enabled.',
              );
            }
          })();
        },
      },
    ]);
  };

  // ── Group management (SERVER-GATED, Private API) ────────────────────────────
  // Members are reactive on the DB: add/remove/rename handlers persist the server
  // chat (writes chat_handles + handles), so this auto-updates — no manual refresh.
  const { data: membersData } = useReactiveQuery<{ address: string; name: string }[]>(
    () => getChatParticipants(getDatabase(), guid),
    ['chat_handles', 'handles', 'chats'],
    [guid],
  );
  const members = membersData ?? [];
  const [renaming, setRenaming] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addAddress, setAddAddress] = useState('');
  const [busy, setBusy] = useState(false);

  const groupError = (): void =>
    Alert.alert('Group', 'Couldn’t update — the server needs the Private API enabled.');

  const doRename = (): void => {
    if (!groupName.trim() || busy) return;
    setBusy(true);
    void chatsApi
      .renameChat(http, guid, groupName.trim())
      .then((chat) => persistServerChat(getDatabase(), chat)) // write the new name locally
      .then(() => {
        setRenaming(false);
        setGroupName('');
      })
      .catch(groupError)
      .finally(() => setBusy(false));
  };
  const doAdd = (): void => {
    if (!addAddress.trim() || busy) return;
    setBusy(true);
    void chatsApi
      .updateParticipant(http, guid, 'add', addAddress.trim())
      .then((chat) => persistServerChat(getDatabase(), chat)) // reflect the new member locally
      .then(() => {
        setAdding(false);
        setAddAddress('');
      })
      .catch(groupError)
      .finally(() => setBusy(false));
  };
  const doRemove = (address: string, who: string): void => {
    Alert.alert('Remove', `Remove ${who} from the group?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          void chatsApi
            .updateParticipant(http, guid, 'remove', address)
            .then((chat) => persistServerChat(getDatabase(), chat)) // prune the member locally
            .catch(groupError)
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  const saveName = (text: string): void => {
    setName(text);
    void setChatCustomization(getDatabase(), guid, { customName: text });
  };
  const pickColor = (color: string | null): void => {
    void setChatCustomization(getDatabase(), guid, { customColor: color });
  };
  const toggleMute = (on: boolean): void => {
    void setChatMute(getDatabase(), guid, on ? 'mute' : null);
  };
  const resetAll = (): void => {
    setName('');
    void setChatCustomization(getDatabase(), guid, { customName: null, customColor: null });
    void setChatMute(getDatabase(), guid, null);
  };

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
        <Text style={[styles.title, { color: theme.color.label }]}>Details</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel }]}>NAME</Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <TextInput
            value={customName}
            onChangeText={saveName}
            placeholder={serverTitle || 'Custom name'}
            placeholderTextColor={theme.color.tertiaryLabel}
            style={[styles.input, { color: theme.color.label }]}
          />
        </View>

        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}>
          BUBBLE COLOR
        </Text>
        <View
          style={[
            styles.group,
            styles.swatchRow,
            { backgroundColor: theme.color.secondaryBackground },
          ]}
        >
          <Pressable
            onPress={() => pickColor(null)}
            style={[
              styles.swatch,
              styles.defaultSwatch,
              { borderColor: theme.color.separator },
              accent == null && styles.swatchOn,
            ]}
          >
            <Text style={[styles.defaultMark, { color: theme.color.secondaryLabel }]}>✕</Text>
          </Pressable>
          {SWATCHES.map((c) => (
            <Pressable
              key={c}
              onPress={() => pickColor(c)}
              style={[styles.swatch, { backgroundColor: c }, accent === c && styles.swatchOn]}
            />
          ))}
        </View>

        <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}>
          NOTIFICATIONS
        </Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Mute</Text>
            <Switch
              value={muted}
              onValueChange={toggleMute}
              accessibilityLabel="Mute notifications for this chat"
            />
          </View>
        </View>

        {isGroup ? (
          <>
            <Text
              style={[styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }]}
            >
              GROUP · {members.length} PEOPLE
            </Text>
            <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
              {members.map((m, i) => (
                <View key={`${m.address}-${i}`} style={[styles.row, i > 0 && divider]}>
                  <Text
                    numberOfLines={1}
                    style={[styles.rowLabel, { color: theme.color.label, flex: 1 }]}
                  >
                    {m.name}
                  </Text>
                  <Pressable
                    onPress={() => doRemove(m.address, m.name)}
                    disabled={busy}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${m.name}`}
                  >
                    <Text style={[styles.remove, { color: theme.color.destructive }]}>✕</Text>
                  </Pressable>
                </View>
              ))}

              {adding ? (
                <View style={[styles.row, divider]}>
                  <TextInput
                    value={addAddress}
                    onChangeText={setAddAddress}
                    placeholder="Phone or email"
                    placeholderTextColor={theme.color.tertiaryLabel}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoFocus
                    style={[styles.rowLabel, { flex: 1, color: theme.color.label }]}
                  />
                  <Pressable onPress={doAdd} disabled={busy || !addAddress.trim()} hitSlop={8}>
                    <Text
                      style={{
                        color: addAddress.trim() ? theme.color.tint : theme.color.tertiaryLabel,
                        fontSize: 16,
                      }}
                    >
                      Add
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable onPress={() => setAdding(true)} style={[styles.row, divider]}>
                  <Text style={[styles.rowLabel, { color: theme.color.tint }]}>Add Person…</Text>
                </Pressable>
              )}

              {renaming ? (
                <View style={[styles.row, divider]}>
                  <TextInput
                    value={groupName}
                    onChangeText={setGroupName}
                    placeholder="New group name"
                    placeholderTextColor={theme.color.tertiaryLabel}
                    autoFocus
                    style={[styles.rowLabel, { flex: 1, color: theme.color.label }]}
                  />
                  <Pressable onPress={doRename} disabled={busy || !groupName.trim()} hitSlop={8}>
                    <Text
                      style={{
                        color: groupName.trim() ? theme.color.tint : theme.color.tertiaryLabel,
                        fontSize: 16,
                      }}
                    >
                      Save
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable onPress={() => setRenaming(true)} style={[styles.row, divider]}>
                  <Text style={[styles.rowLabel, { color: theme.color.tint }]}>Rename Group…</Text>
                </Pressable>
              )}

              <Pressable
                onPress={leaveGroup}
                style={[styles.row, divider]}
                accessibilityRole="button"
                accessibilityLabel="Leave group"
              >
                <Text style={[styles.rowLabel, { color: theme.color.destructive }]}>
                  Leave Group
                </Text>
              </Pressable>
            </View>
          </>
        ) : null}

        <Pressable onPress={resetAll} style={styles.reset}>
          <Text style={[styles.resetText, { color: theme.color.destructive }]}>
            Reset to default
          </Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { fontSize: 17, width: 70 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  spacer: { width: 70 },
  content: { padding: 16 },
  sectionLabel: { fontSize: 13, marginBottom: 6, marginLeft: 12 },
  group: { borderRadius: 12, overflow: 'hidden' },
  input: { paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, padding: 16 },
  swatch: { width: 36, height: 36, borderRadius: 18 },
  defaultSwatch: {
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  defaultMark: { fontSize: 16 },
  swatchOn: { borderWidth: 3, borderColor: '#FFFFFF' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowLabel: { fontSize: 16 },
  remove: { fontSize: 18, paddingHorizontal: 4 },
  reset: { alignItems: 'center', paddingVertical: 24 },
  resetText: { fontSize: 16 },
});
