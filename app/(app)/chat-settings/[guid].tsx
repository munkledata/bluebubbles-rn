import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { chatsApi } from '@core/api';
import { getDatabase } from '@db/database';
import {
  deleteChatLocal,
  getChatParticipants,
  getChatTheme,
  listChatAttachmentsByKind,
  persistServerChat,
  setBackgroundIsLight,
  setChatCustomization,
  setChatMute,
  setChatTheme,
  type ChatMediaByKind,
} from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { computeBackgroundIsLight, http } from '@/services';
import { openChatNotificationSettings } from '@/services/notifications/notifeeService';
import { removeGroupIcon, uploadGroupIcon } from '@/services/chat/groupIcon';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { isGroupRow, resolveTitle } from '@utils';
import {
  NavRow,
  Screen,
  ScreenHeader,
  SettingsSection,
  SwitchRow,
  ThemeStudio,
  useTheme,
} from '@ui';
import { MediaSections } from '@ui/conversations/MediaSections';
import { adaptiveTokensFromImage } from '@ui/theme/adaptiveFromImage';
import { safeParseTokens, type ThemeTokens } from '@ui/theme/tokens';

/** Preset accent colors for the per-chat bubble color (plus "Default"). */
const SWATCHES = ['#1982FC', '#34C759', '#AF52DE', '#FF2D55', '#FF9500', '#5E81AC'];

/**
 * Copy a picked image into a STABLE app directory before we persist its path.
 *
 * ImagePicker hands back a uri inside an OS-managed cache dir that can be purged at
 * any time — persisting that path would silently lose the background later. We copy
 * the asset into {documents}/chat-bg/<guid>-<n><ext> (documents is not purged) and
 * return the new uri to store. The <n> suffix avoids clobbering a previously-set
 * background that's still referenced. Falls back to the original uri if the copy
 * fails (e.g. expo-file-system unavailable) so the feature still works best-effort.
 */
async function persistBackground(guid: string, srcUri: string): Promise<string> {
  try {
    const dir = new Directory(Paths.document, 'chat-bg');
    dir.create({ intermediates: true, idempotent: true });
    const src = new File(srcUri);
    const ext = src.extension || '.jpg';
    // Per-guid, monotonic-ish suffix so a re-pick doesn't overwrite the live file.
    const safeGuid = guid.replace(/[^A-Za-z0-9._-]/g, '_');
    const dest = new File(dir, `${safeGuid}-${Date.now()}${ext}`);
    await src.copy(dest);
    return dest.uri;
  } catch {
    // Copy unavailable/failed → store the original (transient) path as a last resort.
    return srcUri;
  }
}

/** Per-chat customization: custom name, accent color, mute. */
export default function ChatSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
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

  // SERVER-GATED (private API): leave on the server, then drop the chat locally.
  const leaveGroup = (): void => {
    showDialog('Leave Group', 'Leave this conversation on the server and remove it here?', [
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
              showDialog(
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

  // Per-chat theme + background (Phase 3.2). Reactive so the row subtitle reflects state.
  const { data: chatThemeData } = useReactiveQuery(
    () => getChatTheme(getDatabase(), guid),
    ['chats'],
    [guid],
  );
  const hasChatTheme = !!chatThemeData?.themeTokens;
  const hasBackground = !!chatThemeData?.backgroundUri;
  const [studioOpen, setStudioOpen] = useState(false);

  // Shared media (Phase 2.1): photos/videos/documents/links for the details sections.
  // Reactive on messages + attachments so a new shared item appears without a refresh.
  const { data: mediaData } = useReactiveQuery<ChatMediaByKind>(
    () => listChatAttachmentsByKind(getDatabase(), guid),
    ['messages', 'attachments'],
    [guid],
  );

  // The studio opens with the chat's stored theme, falling back to the active global theme.
  const studioTokens = (): ThemeTokens => safeParseTokens(chatThemeData?.themeTokens) ?? theme;

  const applyChatTheme = (tokens: ThemeTokens): void => {
    setStudioOpen(false);
    void setChatTheme(getDatabase(), guid, { themeTokens: JSON.stringify(tokens) });
  };

  const pickBackground = (): void => {
    void (async () => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (res.canceled || res.assets.length === 0) return;
      // Copy out of the purgeable ImagePicker cache into a stable app dir before storing.
      const stableUri = await persistBackground(guid, res.assets[0]!.uri);
      await setChatTheme(getDatabase(), guid, { backgroundUri: stableUri });
      // Record the wallpaper's luminance so overlay text stays legible on it.
      await setBackgroundIsLight(getDatabase(), guid, await computeBackgroundIsLight(stableUri));
    })();
  };

  // Phase 3.3: pick an image (with a crop) and derive a per-chat theme from its dominant
  // colour, setting the background AND the generated tokens together. If the native colour
  // extractor isn't linked yet (returns null), just set the background and explain.
  const generateThemeFromBackground = (): void => {
    void (async () => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 1,
      });
      if (res.canceled || res.assets.length === 0) return;
      const pickedUri = res.assets[0]!.uri;
      // Extract the seed colour from the picked asset, THEN copy it into a stable dir
      // (the ImagePicker cache path is purgeable) and persist that path.
      const tokens = await adaptiveTokensFromImage(pickedUri, theme.mode);
      const uri = await persistBackground(guid, pickedUri);
      if (tokens) {
        await setChatTheme(getDatabase(), guid, {
          themeTokens: JSON.stringify(tokens),
          backgroundUri: uri,
        });
      } else {
        await setChatTheme(getDatabase(), guid, { backgroundUri: uri });
        showDialog(
          'Background set',
          'Adaptive theming needs an app update before it can colour-match this image. The background was applied.',
        );
      }
      // Record the wallpaper's luminance so overlay text stays legible on it.
      await setBackgroundIsLight(getDatabase(), guid, await computeBackgroundIsLight(uri));
    })();
  };

  const clearChatTheme = (): void => {
    void (async () => {
      await setChatTheme(getDatabase(), guid, { themeTokens: null, backgroundUri: null });
      // Cleared the local override → drop its luminance; the synced background (if any) recomputes
      // its own on the next chat open (ensureSyncedBackground).
      await setBackgroundIsLight(getDatabase(), guid, null);
    })();
  };

  const [renaming, setRenaming] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addAddress, setAddAddress] = useState('');
  const [busy, setBusy] = useState(false);

  const groupError = (): void =>
    showDialog('Group', 'Couldn’t update — the server needs the Private API enabled.');

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
    showDialog('Remove', `Remove ${who} from the group?`, [
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
  // Pick a new group photo and upload it to the server (Private API sends it to everyone).
  const onChangeGroupPhoto = (): void => {
    void (async () => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.9,
      });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      try {
        await uploadGroupIcon(http, guid, {
          uri: a.uri,
          name: a.fileName ?? 'group-icon.jpg',
          mimeType: a.mimeType ?? 'image/jpeg',
        });
        showDialog('Group Photo', 'Photo updated — it may take a moment to sync to everyone.');
      } catch {
        showDialog('Group Photo', 'Couldn’t update the group photo.');
      }
    })();
  };
  const onRemoveGroupPhoto = (): void => {
    showDialog('Remove Photo', 'Remove this group’s photo?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void removeGroupIcon(http, guid)
            .then(() => showDialog('Group Photo', 'Photo removed.'))
            .catch(() => showDialog('Group Photo', 'Couldn’t remove the group photo.')),
      },
    ]);
  };
  const resetAll = (): void => {
    setName('');
    void setChatCustomization(getDatabase(), guid, { customName: null, customColor: null });
    void setChatMute(getDatabase(), guid, null);
  };

  return (
    <Screen>
      <ScreenHeader title="Details" onBack={() => router.back()} />

      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection label="NAME">
          <TextInput
            value={customName}
            onChangeText={saveName}
            placeholder={serverTitle || 'Custom name'}
            placeholderTextColor={theme.color.tertiaryLabel}
            style={[styles.input, { color: theme.color.label }]}
          />
        </SettingsSection>

        <SettingsSection label="BUBBLE COLOR" style={styles.gap}>
          <View style={styles.swatchRow}>
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
        </SettingsSection>

        <SettingsSection label="CHAT THEME" style={styles.gap}>
          <Pressable onPress={() => setStudioOpen(true)} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Chat Theme…</Text>
            <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel }]}>
              {hasChatTheme ? 'Custom' : 'Default'}
            </Text>
          </Pressable>
          <Pressable onPress={pickBackground} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Set Background…</Text>
            <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel }]}>
              {hasBackground ? 'On' : 'None'}
            </Text>
          </Pressable>
          <NavRow
            label="Generate theme from background"
            color="label"
            chevron={false}
            onPress={generateThemeFromBackground}
          />
          {hasChatTheme || hasBackground ? (
            <NavRow
              label="Clear chat theme / background"
              color="destructive"
              chevron={false}
              onPress={clearChatTheme}
            />
          ) : null}
        </SettingsSection>

        <MediaSections
          media={mediaData}
          onOpenMedia={(g) => router.push(`/media/${encodeURIComponent(g)}`)}
        />

        <SettingsSection label="NOTIFICATIONS" style={styles.gap}>
          <SwitchRow
            label="Mute"
            value={muted}
            onValueChange={toggleMute}
            accessibilityLabel="Mute notifications for this chat"
          />
          {Platform.OS === 'android' ? (
            <NavRow
              label="Notification Settings…"
              onPress={() =>
                void openChatNotificationSettings(guid, data ? resolveTitle(data) : 'Conversation')
              }
              accessibilityLabel="Open system notification settings for this conversation"
            />
          ) : null}
        </SettingsSection>

        {isGroup ? (
          <>
            <SettingsSection label="GROUP PHOTO" style={styles.gap}>
              <NavRow label="Change Photo…" onPress={onChangeGroupPhoto} disabled={busy} />
              <NavRow
                label="Remove Photo"
                color="destructive"
                chevron={false}
                onPress={onRemoveGroupPhoto}
                disabled={busy}
              />
            </SettingsSection>

            <SettingsSection label={`GROUP · ${members.length} PEOPLE`} style={styles.gap}>
              {members.map((m, i) => (
                <View key={`${m.address}-${i}`} style={styles.row}>
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
                <View style={styles.row}>
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
                <NavRow label="Add Person…" chevron={false} onPress={() => setAdding(true)} />
              )}

              {renaming ? (
                <View style={styles.row}>
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
                <NavRow label="Rename Group…" chevron={false} onPress={() => setRenaming(true)} />
              )}

              <NavRow
                label="Leave Group"
                color="destructive"
                chevron={false}
                onPress={leaveGroup}
                accessibilityLabel="Leave group"
              />
            </SettingsSection>
          </>
        ) : null}

        <Pressable onPress={resetAll} style={styles.reset}>
          <Text style={[styles.resetText, { color: theme.color.destructive }]}>
            Reset to default
          </Text>
        </Pressable>
      </ScrollView>

      {studioOpen ? (
        <Modal
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setStudioOpen(false)}
        >
          <ThemeStudio
            title="Chat Theme"
            initialTokens={studioTokens()}
            showName={false}
            onApply={(tokens) => applyChatTheme(tokens)}
            onCancel={() => setStudioOpen(false)}
          />
        </Modal>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  gap: { marginTop: 24 },
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
    paddingVertical: 14,
  },
  rowLabel: { fontSize: 16 },
  rowValue: { fontSize: 15 },
  remove: { fontSize: 18, paddingHorizontal: 4 },
  reset: { alignItems: 'center', paddingVertical: 24 },
  resetText: { fontSize: 16 },
});
