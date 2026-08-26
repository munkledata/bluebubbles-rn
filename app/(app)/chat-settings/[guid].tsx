import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  Keyboard,
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
import { getDatabase } from '@db/database';
import {
  getChatParticipants,
  getChatTheme,
  listChatAttachmentsByKind,
  setBackgroundIsLight,
  setChatCustomizationWithinTransaction,
  setChatMuteWithinTransaction,
  setChatTheme,
  type ChatMediaByKind,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { computeBackgroundIsLight } from '@/services';
import { openChatNotificationSettings } from '@/services/notifications/notifeeService';
import {
  clearGroupPhoto,
  leaveGroupChat,
  renameGroupChat,
  setGroupPhoto,
  updateGroupParticipant,
} from '@/services/chat/groupManagement';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { isGroupRow, resolveTitle, safeOpenUrl } from '@utils';
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
import { useReduceMotionPreferenceRef } from '@ui/hooks/useReduceMotionPreference';
import { requestPhotoLibraryAccess } from '@ui/permissions/photoLibraryPermission';
import { adaptiveTokensFromImage } from '@ui/theme/adaptiveFromImage';
import {
  darkThemeOrFallback,
  isDarkThemeTokens,
  safeParseTokens,
  type ThemeTokens,
} from '@ui/theme/tokens';
/** Preset accent colors for the per-chat bubble color (plus "Default"). */
const SWATCHES = ['#1982FC', '#34C759', '#AF52DE', '#FF2D55', '#FF9500', '#5E81AC'];
type ChatSettingsLifetime = object;
type PickerOperationToken = object;
interface ChatSettingsGrant {
  chatGuid: string;
  lifetime: ChatSettingsLifetime;
  accountLease: RealtimeDeliveryLease;
}
interface PickerOwner {
  acquire(): PickerOperationToken | null;
  isCurrent(token: PickerOperationToken): boolean;
  release(token: PickerOperationToken): void;
}
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

/**
 * Route/account owner. The account lease is intentionally captured outside the keyed content so a
 * GUID replacement cannot accidentally adopt a newer account. The single picker owner also spans
 * keyed A -> B -> A replacements: only one of the three native photo flows can be live at once,
 * and an old operation can release only its own opaque token.
 */
export default function ChatSettingsRoute(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { guid } = useLocalSearchParams<{ guid: string }>();
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const reduceMotion = useReduceMotionPreferenceRef();
  const ownerMountedRef = useRef(true);
  const accountRetiredRef = useRef(!accountLease.isCurrent());
  const [accountRetired, setAccountRetired] = useState(accountRetiredRef.current);
  const activePickerRef = useRef<PickerOperationToken | null>(null);
  const [pickerOwner] = useState<PickerOwner>(() => ({
    acquire: () => {
      if (
        !ownerMountedRef.current ||
        accountRetiredRef.current ||
        !accountLease.isCurrent() ||
        activePickerRef.current
      ) {
        return null;
      }
      const token = {};
      activePickerRef.current = token;
      return token;
    },
    isCurrent: (token) =>
      ownerMountedRef.current &&
      !accountRetiredRef.current &&
      accountLease.isCurrent() &&
      activePickerRef.current === token,
    release: (token) => {
      if (activePickerRef.current === token) activePickerRef.current = null;
    },
  }));

  useLayoutEffect(() => {
    ownerMountedRef.current = true;
    const unsubscribe = subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
      accountRetiredRef.current = true;
      Keyboard.dismiss();
      setAccountRetired(true);
    });
    return () => {
      ownerMountedRef.current = false;
      Keyboard.dismiss();
      unsubscribe();
    };
  }, [accountLease]);

  const accountUnavailable = accountRetired || !accountLease.isCurrent();

  return (
    <Screen>
      <ScreenHeader title="Details" onBack={() => router.back()} />
      {accountUnavailable ? (
        <View style={styles.accountChanged}>
          <Text
            accessibilityRole="text"
            accessibilityLabel="Conversation account changed. Go back and reopen Details."
            style={[styles.accountChangedText, { color: theme.color.secondaryLabel }]}
          >
            Conversation account changed. Go back and reopen Details.
          </Text>
        </View>
      ) : (
        <ChatSettingsScreen
          key={guid}
          guid={guid}
          accountLease={accountLease}
          pickerOwner={pickerOwner}
          reduceMotion={reduceMotion}
        />
      )}
    </Screen>
  );
}

/** Per-chat customization: custom name, accent color, mute. Keyed by the outer route owner. */
function ChatSettingsScreen({
  guid,
  accountLease,
  pickerOwner,
  reduceMotion,
}: {
  guid: string;
  accountLease: RealtimeDeliveryLease;
  pickerOwner: PickerOwner;
  reduceMotion: ReturnType<typeof useReduceMotionPreferenceRef>;
}): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { data } = useChatHeader(guid);
  const mountAliveRef = useRef(true);
  const [lifetime] = useState<ChatSettingsLifetime>(() => ({}));
  const activeLifetimeRef = useRef<ChatSettingsLifetime | null>(lifetime);
  const renderGrant: ChatSettingsGrant = { chatGuid: guid, lifetime, accountLease };
  const grantIsCurrent = (grant: ChatSettingsGrant): boolean =>
    mountAliveRef.current &&
    activeLifetimeRef.current === grant.lifetime &&
    grant.chatGuid === guid &&
    grant.accountLease === accountLease &&
    grant.accountLease.isCurrent();

  useLayoutEffect(() => {
    mountAliveRef.current = true;
    activeLifetimeRef.current = lifetime;
    return () => {
      mountAliveRef.current = false;
      activeLifetimeRef.current = null;
      Keyboard.dismiss();
    };
  }, [lifetime]);

  const runScreenAccountTask = async (
    grant: ChatSettingsGrant,
    task: (activeLease: RealtimeDeliveryLease) => Promise<void>,
  ): Promise<boolean> => {
    if (!grantIsCurrent(grant)) return false;
    let completed = false;
    try {
      const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
        if (!lease.isCurrent()) return;
        await task(lease);
        if (!lease.isCurrent()) return;
        completed = true;
      });
      return status === 'delivered' && completed && accountLease.isCurrent();
    } catch (error) {
      // A revoked screen should not surface its write error in the replacement account.
      if (!accountLease.isCurrent()) return false;
      throw error;
    }
  };
  const queueScreenAccountTask = (
    grant: ChatSettingsGrant,
    task: (activeLease: RealtimeDeliveryLease) => Promise<void>,
  ): void => {
    if (!grantIsCurrent(grant)) return;
    void runScreenAccountTask(grant, task).catch(() => {
      // These local preference writes have always been best-effort; account ownership is the
      // important invariant. A later reactive read continues to show the durable value.
    });
  };

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
    const dialogGrant = renderGrant;
    if (!grantIsCurrent(dialogGrant)) return;
    showDialog('Leave Group', 'Leave this conversation on the server and remove it here?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          if (!grantIsCurrent(dialogGrant)) return;
          void (async () => {
            try {
              if ((await leaveGroupChat(guid, accountLease)) && grantIsCurrent(dialogGrant)) {
                router.back();
              }
            } catch {
              if (grantIsCurrent(dialogGrant)) {
                showDialog(
                  'Leave Group',
                  'Couldn’t leave — the server needs the private API enabled.',
                );
              }
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
  const storedChatTheme = safeParseTokens(chatThemeData?.themeTokens);
  const hasStoredChatTheme = !!chatThemeData?.themeTokens;
  const hasChatTheme = isDarkThemeTokens(storedChatTheme);
  const hasUnavailableLightTheme = storedChatTheme?.mode === 'light';
  const hasBackground = !!chatThemeData?.backgroundUri;
  const [studioAnimation, setStudioAnimation] = useState<'none' | 'slide' | null>(null);

  // Shared media (Phase 2.1): photos/videos/documents/links for the details sections.
  // Reactive on messages + attachments so a new shared item appears without a refresh.
  const { data: mediaData } = useReactiveQuery<ChatMediaByKind>(
    () => listChatAttachmentsByKind(getDatabase(), guid),
    ['messages', 'attachments'],
    [guid],
  );

  // The studio opens with a stored dark theme. A legacy light theme stays in the DB but
  // starts from the active dark colors if the user chooses to convert it by applying edits.
  const studioTokens = (): ThemeTokens => darkThemeOrFallback(storedChatTheme, theme);

  const applyChatTheme = (tokens: ThemeTokens): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    setStudioAnimation(null);
    queueScreenAccountTask(operationGrant, () =>
      setChatTheme(getDatabase(), guid, { themeTokens: JSON.stringify(tokens) }),
    );
  };

  const pickBackground = (): void => {
    void (async () => {
      const pickerGrant = renderGrant;
      if (!grantIsCurrent(pickerGrant)) return;
      const pickerToken = pickerOwner.acquire();
      if (!pickerToken) return;
      const pickerIsCurrent = (): boolean =>
        pickerOwner.isCurrent(pickerToken) && grantIsCurrent(pickerGrant);
      try {
        if (!(await requestPhotoLibraryAccess(pickerIsCurrent)) || !pickerIsCurrent()) return;
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 1,
        }).catch(() => {
          if (pickerIsCurrent()) showDialog('Photos', 'Couldn’t open the photo picker.');
          return null;
        });
        if (!res || res.canceled || res.assets.length === 0 || !pickerIsCurrent()) return;
        try {
          await runScreenAccountTask(pickerGrant, async () => {
            // Copy out of the purgeable ImagePicker cache into a stable app dir before storing.
            // The tracked task drains for its exact chat once admitted; only later UI publication
            // is revoked if this keyed screen is replaced.
            const stableUri = await persistBackground(guid, res.assets[0]!.uri);
            if (!accountLease.isCurrent()) return;
            await setChatTheme(getDatabase(), guid, { backgroundUri: stableUri });
            // Record the wallpaper's luminance so overlay text stays legible on it.
            await setBackgroundIsLight(
              getDatabase(),
              guid,
              await computeBackgroundIsLight(stableUri),
            );
          });
        } catch {
          if (pickerIsCurrent()) {
            showDialog('Background', 'Couldn’t finish updating this conversation’s background.');
          }
        }
      } finally {
        pickerOwner.release(pickerToken);
      }
    })();
  };

  // Phase 3.3: pick an image (with a crop) and derive a per-chat theme from its dominant
  // colour, setting the background AND the generated tokens together. If the native colour
  // extractor isn't linked yet (returns null), just set the background and explain.
  const generateThemeFromBackground = (): void => {
    void (async () => {
      const pickerGrant = renderGrant;
      if (!grantIsCurrent(pickerGrant)) return;
      const pickerToken = pickerOwner.acquire();
      if (!pickerToken) return;
      const pickerIsCurrent = (): boolean =>
        pickerOwner.isCurrent(pickerToken) && grantIsCurrent(pickerGrant);
      try {
        if (!(await requestPhotoLibraryAccess(pickerIsCurrent)) || !pickerIsCurrent()) return;
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: true,
          quality: 1,
        }).catch(() => {
          if (pickerIsCurrent()) showDialog('Photos', 'Couldn’t open the photo picker.');
          return null;
        });
        if (!res || res.canceled || res.assets.length === 0 || !pickerIsCurrent()) return;
        const pickedUri = res.assets[0]!.uri;
        let generated = false;
        try {
          const completed = await runScreenAccountTask(pickerGrant, async () => {
            // Extract the seed colour from the picked asset, THEN copy it into a stable dir
            // (the ImagePicker cache path is purgeable) and persist that path.
            const tokens = await adaptiveTokensFromImage(pickedUri, 'dark');
            if (!accountLease.isCurrent()) return;
            const uri = await persistBackground(guid, pickedUri);
            if (!accountLease.isCurrent()) return;
            generated = tokens != null;
            if (tokens) {
              await setChatTheme(getDatabase(), guid, {
                themeTokens: JSON.stringify(tokens),
                backgroundUri: uri,
              });
            } else {
              await setChatTheme(getDatabase(), guid, { backgroundUri: uri });
            }
            // Record the wallpaper's luminance so overlay text stays legible on it.
            await setBackgroundIsLight(getDatabase(), guid, await computeBackgroundIsLight(uri));
          });
          if (completed && !generated && pickerIsCurrent()) {
            showDialog(
              'Background set',
              'Adaptive theming needs an app update before it can colour-match this image. The background was applied.',
            );
          }
        } catch {
          if (pickerIsCurrent()) {
            showDialog('Chat Theme', 'Couldn’t finish generating a theme from this background.');
          }
        }
      } finally {
        pickerOwner.release(pickerToken);
      }
    })();
  };

  const clearChatTheme = (): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    queueScreenAccountTask(operationGrant, async () => {
      await setChatTheme(getDatabase(), guid, { themeTokens: null, backgroundUri: null });
      // Cleared the local override → drop its luminance; the synced background (if any) recomputes
      // its own on the next chat open (ensureSyncedBackground).
      await setBackgroundIsLight(getDatabase(), guid, null);
    });
  };

  const [renaming, setRenaming] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addAddress, setAddAddress] = useState('');
  const [busy, setBusy] = useState(false);

  const showGroupError = (grant: ChatSettingsGrant): void => {
    if (grantIsCurrent(grant)) {
      showDialog('Group', 'Couldn’t update — the server needs the Private API enabled.');
    }
  };

  const doRename = (): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant) || !groupName.trim() || busy) return;
    setBusy(true);
    void renameGroupChat(guid, groupName.trim(), accountLease)
      .then((completed) => {
        if (!completed || !grantIsCurrent(operationGrant)) return;
        setRenaming(false);
        setGroupName('');
      })
      .catch(() => {
        showGroupError(operationGrant);
      })
      .finally(() => {
        if (grantIsCurrent(operationGrant)) setBusy(false);
      });
  };
  const doAdd = (): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant) || !addAddress.trim() || busy) return;
    setBusy(true);
    void updateGroupParticipant(guid, 'add', addAddress.trim(), accountLease)
      .then((completed) => {
        if (!completed || !grantIsCurrent(operationGrant)) return;
        setAdding(false);
        setAddAddress('');
      })
      .catch(() => {
        showGroupError(operationGrant);
      })
      .finally(() => {
        if (grantIsCurrent(operationGrant)) setBusy(false);
      });
  };
  const doRemove = (address: string): void => {
    const dialogGrant = renderGrant;
    if (!grantIsCurrent(dialogGrant)) return;
    showDialog('Remove', 'Remove this person from the group?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          if (!grantIsCurrent(dialogGrant)) return;
          setBusy(true);
          void updateGroupParticipant(guid, 'remove', address, accountLease)
            .catch(() => {
              showGroupError(dialogGrant);
            })
            .finally(() => {
              if (grantIsCurrent(dialogGrant)) setBusy(false);
            });
        },
      },
    ]);
  };

  const saveName = (text: string): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    setName(text);
    queueScreenAccountTask(operationGrant, async (activeLease) => {
      const db = getDatabase();
      const chatGuid = operationGrant.chatGuid;
      const customization = { customName: text };
      await withDbTransaction(
        db,
        (context) => setChatCustomizationWithinTransaction(context, chatGuid, customization),
        () => activeLease.isCurrent(),
      );
    });
  };
  const pickColor = (color: string | null): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    queueScreenAccountTask(operationGrant, async (activeLease) => {
      const db = getDatabase();
      const chatGuid = operationGrant.chatGuid;
      const customization = { customColor: color };
      await withDbTransaction(
        db,
        (context) => setChatCustomizationWithinTransaction(context, chatGuid, customization),
        () => activeLease.isCurrent(),
      );
    });
  };
  const toggleMute = (on: boolean): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    queueScreenAccountTask(operationGrant, async (activeLease) => {
      const db = getDatabase();
      const chatGuid = operationGrant.chatGuid;
      const muteType = on ? 'mute' : null;
      await withDbTransaction(
        db,
        (context) => setChatMuteWithinTransaction(context, chatGuid, muteType),
        () => activeLease.isCurrent(),
      );
    });
  };
  // Pick a new group photo and upload it to the server (Private API sends it to everyone).
  const onChangeGroupPhoto = (): void => {
    void (async () => {
      const pickerGrant = renderGrant;
      if (!grantIsCurrent(pickerGrant)) return;
      const pickerToken = pickerOwner.acquire();
      if (!pickerToken) return;
      const pickerIsCurrent = (): boolean =>
        pickerOwner.isCurrent(pickerToken) && grantIsCurrent(pickerGrant);
      try {
        if (!(await requestPhotoLibraryAccess(pickerIsCurrent)) || !pickerIsCurrent()) return;
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.9,
        }).catch(() => {
          if (pickerIsCurrent()) showDialog('Photos', 'Couldn’t open the photo picker.');
          return null;
        });
        if (!res || res.canceled || !res.assets[0] || !pickerIsCurrent()) return;
        const a = res.assets[0];
        try {
          const completed = await setGroupPhoto(
            guid,
            {
              uri: a.uri,
              name: a.fileName ?? 'group-icon.jpg',
              mimeType: a.mimeType ?? 'image/jpeg',
            },
            accountLease,
          );
          if (completed && pickerIsCurrent()) {
            showDialog('Group Photo', 'Photo updated — it may take a moment to sync to everyone.');
          }
        } catch {
          if (pickerIsCurrent()) {
            showDialog('Group Photo', 'Couldn’t update the group photo.');
          }
        }
      } finally {
        pickerOwner.release(pickerToken);
      }
    })();
  };
  const onRemoveGroupPhoto = (): void => {
    const dialogGrant = renderGrant;
    if (!grantIsCurrent(dialogGrant)) return;
    showDialog('Remove Photo', 'Remove this group’s photo?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          if (!grantIsCurrent(dialogGrant)) return;
          void clearGroupPhoto(guid, accountLease)
            .then((completed) => {
              if (completed && grantIsCurrent(dialogGrant)) {
                showDialog('Group Photo', 'Photo removed.');
              }
            })
            .catch(() => {
              if (grantIsCurrent(dialogGrant)) {
                showDialog('Group Photo', 'Couldn’t remove the group photo.');
              }
            });
        },
      },
    ]);
  };
  const resetAll = (): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    setName('');
    queueScreenAccountTask(operationGrant, async (activeLease) => {
      const db = getDatabase();
      const chatGuid = operationGrant.chatGuid;
      const customization = { customName: null, customColor: null };
      await withDbTransaction(
        db,
        (context) => setChatCustomizationWithinTransaction(context, chatGuid, customization),
        () => activeLease.isCurrent(),
      );
      await withDbTransaction(
        db,
        (context) => setChatMuteWithinTransaction(context, chatGuid, null),
        () => activeLease.isCurrent(),
      );
    });
  };

  const openStudio = (): void => {
    if (!grantIsCurrent(renderGrant)) return;
    const nextAnimation = modalAnimationFor(reduceMotion.current);
    // Keep both the native dialog and its motion policy stable until this opening closes.
    // A retained/double press or live setting change affects only the next opening.
    setStudioAnimation((current) => current ?? nextAnimation);
  };
  const closeStudio = (): void => {
    if (!grantIsCurrent(renderGrant)) return;
    setStudioAnimation(null);
  };
  const openMedia = (messageGuid: string): void => {
    if (!grantIsCurrent(renderGrant)) return;
    router.push(`/media/${encodeURIComponent(messageGuid)}`);
  };
  const openLink = (url: string): void => {
    if (!grantIsCurrent(renderGrant)) return;
    void safeOpenUrl(url);
  };
  const openNotificationSettings = (): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    const sourceAccountContext = {
      generation: accountLease.generation,
      isCurrent: (): boolean => grantIsCurrent(operationGrant),
    };
    void openChatNotificationSettings(
      guid,
      data ? resolveTitle(data) : 'Conversation',
      sourceAccountContext,
    ).catch(() => {
      if (!grantIsCurrent(operationGrant)) return;
      showDialog(
        'Notification Settings',
        'Android notification settings could not be opened for this conversation.',
      );
    });
  };
  const openAddPerson = (): void => {
    if (!grantIsCurrent(renderGrant)) return;
    setAdding(true);
  };
  const changeAddAddress = (text: string): void => {
    if (!grantIsCurrent(renderGrant)) return;
    setAddAddress(text);
  };
  const openRename = (): void => {
    if (!grantIsCurrent(renderGrant)) return;
    setRenaming(true);
  };
  const changeGroupName = (text: string): void => {
    if (!grantIsCurrent(renderGrant)) return;
    setGroupName(text);
  };

  return (
    <>
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
          <Pressable onPress={openStudio} style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.color.label }]}>Chat Theme…</Text>
            <Text style={[styles.rowValue, { color: theme.color.tertiaryLabel }]}>
              {hasChatTheme ? 'Custom' : hasUnavailableLightTheme ? 'Light unavailable' : 'Default'}
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
          {hasStoredChatTheme || hasBackground ? (
            <NavRow
              label="Clear chat theme / background"
              color="destructive"
              chevron={false}
              onPress={clearChatTheme}
            />
          ) : null}
        </SettingsSection>

        <MediaSections media={mediaData} onOpenMedia={openMedia} onOpenLink={openLink} />

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
              onPress={openNotificationSettings}
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
                    onPress={() => doRemove(m.address)}
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
                    onChangeText={changeAddAddress}
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
                <NavRow label="Add Person…" chevron={false} onPress={openAddPerson} />
              )}

              {renaming ? (
                <View style={styles.row}>
                  <TextInput
                    value={groupName}
                    onChangeText={changeGroupName}
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
                <NavRow label="Rename Group…" chevron={false} onPress={openRename} />
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

      {studioAnimation ? (
        <Modal
          visible
          transparent
          animationType={studioAnimation}
          onRequestClose={closeStudio}
          testID="chat-theme-studio-modal"
        >
          <ThemeStudio
            title="Chat Theme"
            initialTokens={studioTokens()}
            showName={false}
            onApply={(tokens) => applyChatTheme(tokens)}
            onCancel={closeStudio}
          />
        </Modal>
      ) : null}
    </>
  );
}

function modalAnimationFor(reduceMotion: boolean | null): 'none' | 'slide' {
  return reduceMotion === false ? 'slide' : 'none';
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  accountChanged: { paddingHorizontal: 24, paddingTop: 40 },
  accountChangedText: { textAlign: 'center', fontSize: 15 },
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
