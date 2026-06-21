import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Modal,
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
  getChatTheme,
  listChatAttachmentsByKind,
  persistServerChat,
  setChatCustomization,
  setChatMute,
  setChatTheme,
  type AttachmentRow,
  type ChatMediaByKind,
} from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { http } from '@/services';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { isGroupRow, resolveTitle, safeOpenUrl } from '@utils';
import { Screen, ThemeStudio, useTheme } from '@ui';
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
        Alert.alert(
          'Background set',
          'Adaptive theming needs an app update before it can colour-match this image. The background was applied.',
        );
      }
    })();
  };

  const clearChatTheme = (): void => {
    void setChatTheme(getDatabase(), guid, { themeTokens: null, backgroundUri: null });
  };

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
          CHAT THEME
        </Text>
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          <Pressable onPress={() => setStudioOpen(true)} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Chat Theme…</Text>
            <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel }]}>
              {hasChatTheme ? 'Custom' : 'Default'}
            </Text>
          </Pressable>
          <Pressable onPress={pickBackground} style={[styles.row, divider]}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Set Background…</Text>
            <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel }]}>
              {hasBackground ? 'On' : 'None'}
            </Text>
          </Pressable>
          <Pressable onPress={generateThemeFromBackground} style={[styles.row, divider]}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>
              Generate theme from background
            </Text>
          </Pressable>
          {hasChatTheme || hasBackground ? (
            <Pressable onPress={clearChatTheme} style={[styles.row, divider]}>
              <Text style={[styles.rowLabel, { color: theme.color.destructive }]}>
                Clear chat theme / background
              </Text>
            </Pressable>
          ) : null}
        </View>

        <MediaSections
          media={mediaData}
          onOpenMedia={(g) => router.push(`/media/${encodeURIComponent(g)}`)}
        />

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

/** A single attachment thumbnail in the shared-media strip (image preview or kind glyph). */
function MediaThumb({
  att,
  kind,
  glyph,
  redacted,
  onPress,
}: {
  att: AttachmentRow;
  kind: 'photo' | 'video';
  glyph: string;
  redacted: boolean;
  onPress?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  // Redacted mode: never render the actual media (shoulder-surf / screenshot safety) —
  // show a neutral glyph tile instead. expo-image can't decode a video file, so a video
  // renders ONLY its blurhash poster (no file source) or the ▶ glyph fallback; feeding
  // the video uri to <Image source> would just show a blank tile.
  const showImage = !redacted && kind === 'photo' && !!att.localPath;
  const videoPoster = !redacted && kind === 'video' && !!att.blurhash;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[styles.thumb, { backgroundColor: theme.color.groupedBackground }]}
      accessibilityRole="image"
    >
      {showImage ? (
        <Image
          source={{ uri: att.localPath! }}
          placeholder={att.blurhash ? { blurhash: att.blurhash } : null}
          contentFit="cover"
          style={styles.thumbImg}
        />
      ) : videoPoster ? (
        // Poster-only: blurhash as the image (NO video source) with a play glyph overlay.
        <>
          <Image
            placeholder={{ blurhash: att.blurhash! }}
            contentFit="cover"
            style={styles.thumbImg}
          />
          <Text style={[styles.thumbGlyph, styles.thumbGlyphOverlay]}>▶</Text>
        </>
      ) : (
        <Text style={styles.thumbGlyph}>{glyph}</Text>
      )}
    </Pressable>
  );
}

/**
 * Conversation-details shared media (Phase 2.1): horizontal thumbnail strips for
 * Photos + Videos (tap → media viewer), and count rows for Documents + Links
 * (links open via the safe URL opener). Renders nothing when the chat has no media.
 */
function MediaSections({
  media,
  onOpenMedia,
}: {
  media: ChatMediaByKind | null | undefined;
  onOpenMedia: (attachmentGuid: string) => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  // Redacted (privacy) mode: mirror the rest of the app — never surface link URLs or
  // photo/video previews here. Thumbnails fall back to neutral kind tiles (MediaThumb)
  // and link URLs are replaced by a placeholder so a screenshot leaks nothing.
  const redacted = useRedactedModeStore((s) => s.enabled);
  if (!media) return null;
  const { photos, videos, documents, links } = media;
  if (!photos.length && !videos.length && !documents.length && !links.length) return null;

  const labelStyle = [styles.sectionLabel, { color: theme.color.secondaryLabel, marginTop: 24 }];
  const rowValueStyle = [styles.rowValue, { color: theme.color.tertiaryLabel }];

  return (
    <>
      <Text style={labelStyle}>SHARED MEDIA</Text>
      {photos.length > 0 ? (
        <>
          <Text style={[styles.mediaStripLabel, { color: theme.color.tertiaryLabel }]}>
            Photos · {photos.length}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
            {photos.map((a) => (
              <MediaThumb
                key={a.guid}
                att={a}
                kind="photo"
                glyph="🖼"
                redacted={redacted}
                onPress={() => onOpenMedia(a.guid)}
              />
            ))}
          </ScrollView>
        </>
      ) : null}
      {videos.length > 0 ? (
        <>
          <Text style={[styles.mediaStripLabel, { color: theme.color.tertiaryLabel }]}>
            Videos · {videos.length}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
            {videos.map((a) => (
              <MediaThumb
                key={a.guid}
                att={a}
                kind="video"
                glyph="▶"
                redacted={redacted}
                onPress={() => onOpenMedia(a.guid)}
              />
            ))}
          </ScrollView>
        </>
      ) : null}
      {documents.length > 0 || links.length > 0 ? (
        <View style={[styles.group, { backgroundColor: theme.color.secondaryBackground }]}>
          {documents.length > 0 ? (
            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: theme.color.label }]}>Documents</Text>
              <Text style={rowValueStyle}>{documents.length}</Text>
            </View>
          ) : null}
          {links.length > 0 ? (
            <View>
              <View
                style={[
                  styles.row,
                  documents.length > 0 && {
                    borderTopColor: theme.color.separator,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Text style={[styles.rowLabel, { color: theme.color.label }]}>Links</Text>
                <Text style={rowValueStyle}>{links.length}</Text>
              </View>
              {links.slice(0, 5).map((l) => (
                <Pressable
                  key={l.messageGuid}
                  onPress={() => void safeOpenUrl(l.url)}
                  style={[
                    styles.row,
                    {
                      borderTopColor: theme.color.separator,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <Text numberOfLines={1} style={[styles.linkText, { color: theme.color.tint }]}>
                    {redacted ? '[link]' : l.url}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </>
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
  rowValue: { fontSize: 15 },
  remove: { fontSize: 18, paddingHorizontal: 4 },
  reset: { alignItems: 'center', paddingVertical: 24 },
  resetText: { fontSize: 16 },
  mediaStripLabel: { fontSize: 13, marginLeft: 12, marginBottom: 6, marginTop: 4 },
  strip: { marginBottom: 8 },
  thumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    marginRight: 8,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImg: { width: '100%', height: '100%' },
  thumbGlyph: { fontSize: 26 },
  // Play glyph drawn over a video's blurhash poster (the strip tile is centered).
  thumbGlyphOverlay: {
    position: 'absolute',
    color: '#FFFFFF',
    textShadowColor: '#000000',
    textShadowRadius: 3,
  },
  linkText: { fontSize: 15, flex: 1 },
});
