import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  type ChatParticipant,
  type ChatMediaByKind,
} from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import {
  MAX_IMESSAGE_GROUP_PHOTO_BYTES,
  isSupportedImessageGroupPhotoType,
} from '@core/models/serverInfo';
import { isCanonicalIMessageParticipantAddress } from '@core/api/endpoints/chats';
import {
  addAppleGroupParticipant,
  computeBackgroundIsLight,
  leaveAppleGroup,
  prepareAppleGroupPhotoSet,
  renameAppleGroup,
  removeAppleGroupPhoto,
  removeAppleGroupParticipant,
  resetChatLocalPreferences,
  setChatMuted,
  startChatRepair,
  updateChatAppearance,
  updateChatCustomization,
  updateHandleColor,
} from '@/services';
import { openChatNotificationSettings } from '@/services/notifications/notifeeService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { useSessionStore } from '@state/sessionStore';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { useSharedDocuments } from '@features/conversations/useSharedDocuments';
import { isGroupRow, isProvenIMessageGroupChat, resolveTitle, safeOpenUrl } from '@utils';
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
import { showExternalOpenFailure } from '@ui/toast/external-open-feedback';
import { adaptiveTokensFromImage } from '@ui/theme/adaptiveFromImage';
import {
  darkThemeOrFallback,
  isDarkThemeTokens,
  safeParseTokens,
  type ThemeTokens,
} from '@ui/theme/tokens';
/** Preset accent colors for the per-chat bubble color (plus "Default"). */
const SWATCHES = ['#1982FC', '#34C759', '#AF52DE', '#FF2D55', '#FF9500', '#5E81AC'] as const;
const SWATCH_NAMES: Record<(typeof SWATCHES)[number], string> = {
  '#1982FC': 'Blue',
  '#34C759': 'Green',
  '#AF52DE': 'Purple',
  '#FF2D55': 'Pink',
  '#FF9500': 'Orange',
  '#5E81AC': 'Slate blue',
};
const HANDLE_COLOR_SWATCHES = [
  { color: '#FFF3A3', name: 'Pale yellow' },
  { color: '#F8B4C8', name: 'Pale pink' },
  { color: '#69DB7C', name: 'Green' },
  { color: '#4DABF7', name: 'Blue' },
  { color: '#9775FA', name: 'Purple' },
  { color: '#17324D', name: 'Navy' },
  { color: '#3A235B', name: 'Deep purple' },
] as const;
type ChatSettingsLifetime = object;
type PickerOperationToken = object;
interface AcceptedAppleGroupNameOverlay {
  displayName: string;
  authoritativeDisplayNameAtSubmit: string | null;
}
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
  const appleGroupRenameSupported = useSessionStore(
    (state) => state.serverInfo?.supports_imessage_group_rename === true,
  );
  const appleGroupPhotoSupported = useSessionStore(
    (state) => state.serverInfo?.supports_imessage_group_photo === true,
  );
  const appleGroupParticipantAddSupported = useSessionStore(
    (state) => state.serverInfo?.supports_imessage_group_participant_add === true,
  );
  const appleGroupParticipantRemoveSupported = useSessionStore(
    (state) => state.serverInfo?.supports_imessage_group_participant_remove === true,
  );
  const appleGroupLeaveSupported = useSessionStore(
    (state) => state.serverInfo?.supports_imessage_group_leave === true,
  );
  const mountAliveRef = useRef(true);
  const [lifetime] = useState<ChatSettingsLifetime>(() => ({}));
  const activeLifetimeRef = useRef<ChatSettingsLifetime | null>(lifetime);
  const activeLinkOpenRef = useRef<object | null>(null);
  const appleGroupMembershipOperationActiveRef = useRef(false);
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

  const runScreenAccountTask = async <T,>(
    grant: ChatSettingsGrant,
    task: (activeLease: RealtimeDeliveryLease) => Promise<T | null>,
  ): Promise<T | null> => {
    if (!grantIsCurrent(grant)) return null;
    let completed = false;
    let value: T | null = null;
    try {
      const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
        if (!lease.isCurrent()) return;
        const nextValue = await task(lease);
        if (!lease.isCurrent()) return;
        value = nextValue;
        completed = true;
      });
      return status === 'delivered' && completed && accountLease.isCurrent() ? value : null;
    } catch (error) {
      // A revoked screen should not surface its write error in the replacement account.
      if (!accountLease.isCurrent()) return null;
      throw error;
    }
  };
  const queueScreenCommand = (grant: ChatSettingsGrant, command: () => Promise<void>): void => {
    if (!grantIsCurrent(grant)) return;
    void command().catch(() => {
      // Local preference commands remain best-effort. Their service owner suppresses work for a
      // retired account, and the reactive read continues to show the last durable value.
    });
  };

  // Local input state seeded once from the row; writes persist immediately.
  const [name, setName] = useState<string | null>(null);
  const customName = name ?? data?.customName ?? '';
  const [appleGroupName, setAppleGroupName] = useState<string | null>(null);
  const [acceptedAppleGroupNameOverlay, setAcceptedAppleGroupNameOverlay] =
    useState<AcceptedAppleGroupNameOverlay | null>(null);
  const [renamingAppleGroup, setRenamingAppleGroup] = useState(false);
  const [changingAppleGroupPhoto, setChangingAppleGroupPhoto] = useState(false);
  const [appleGroupParticipantAddress, setAppleGroupParticipantAddress] = useState('');
  const [addingAppleGroupParticipant, setAddingAppleGroupParticipant] = useState(false);
  const [removingAppleGroupParticipantAddress, setRemovingAppleGroupParticipantAddress] = useState<
    string | null
  >(null);
  const [leavingAppleGroup, setLeavingAppleGroup] = useState(false);
  const appleGroupNameValue =
    appleGroupName ?? acceptedAppleGroupNameOverlay?.displayName ?? data?.displayName ?? '';
  const appleGroupNameBaseline =
    acceptedAppleGroupNameOverlay?.displayName ?? data?.displayName ?? '';
  const appleGroupRenameAvailable =
    appleGroupRenameSupported && data?.guid === guid && isProvenIMessageGroupChat(data);
  const appleGroupPhotoAvailable =
    appleGroupPhotoSupported && data?.guid === guid && isProvenIMessageGroupChat(data);
  const appleGroupParticipantAddAvailable =
    appleGroupParticipantAddSupported && data?.guid === guid && isProvenIMessageGroupChat(data);
  const appleGroupParticipantRemoveAvailable =
    appleGroupParticipantRemoveSupported &&
    data?.guid === guid &&
    isProvenIMessageGroupChat(data) &&
    data.participantCount >= 3;
  const appleGroupLeaveAvailable =
    appleGroupLeaveSupported && data?.guid === guid && isProvenIMessageGroupChat(data);
  const appleGroupNameChanged =
    appleGroupNameValue.trim().length > 0 && appleGroupNameValue !== appleGroupNameBaseline;
  const muted = data?.muteType === 'mute';
  const accent = data?.customColor ?? null;
  // The placeholder shows what the title would be WITHOUT a custom name.
  const serverTitle = data ? resolveTitle({ ...data, customName: null }) : '';

  useEffect(() => {
    if (!acceptedAppleGroupNameOverlay) return;
    const authoritativeDisplayName = data?.displayName ?? null;
    if (
      authoritativeDisplayName !== acceptedAppleGroupNameOverlay.authoritativeDisplayNameAtSubmit ||
      authoritativeDisplayName === acceptedAppleGroupNameOverlay.displayName
    ) {
      // This short-lived overlay is synchronized to the external reactive chat row. Failure drafts
      // remain separate and are deliberately not cleared by an authoritative name update.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAcceptedAppleGroupNameOverlay(null);
    }
  }, [acceptedAppleGroupNameOverlay, data?.displayName]);

  const isGroup = data ? isGroupRow(data) : false;

  // Membership stays authoritative in the local database. The narrow add control never edits it
  // optimistically; group name/photo/add controls each require their own live capability.
  const { data: membersData } = useReactiveQuery<ChatParticipant[]>(
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
  const [studioCancelRequest, setStudioCancelRequest] = useState(0);

  // Shared media (Phase 2.1): photos/videos/documents/links for the details sections.
  // Reactive on messages + attachments so a new shared item appears without a refresh.
  const { data: mediaData } = useReactiveQuery<ChatMediaByKind>(
    () => listChatAttachmentsByKind(getDatabase(), guid),
    ['messages', 'attachments'],
    [guid],
  );
  const { data: documentPage } = useSharedDocuments(guid, accountLease);

  // The studio opens with a stored dark theme. A legacy light theme stays in the DB but
  // starts from the active dark colors if the user chooses to convert it by applying edits.
  const studioTokens = (): ThemeTokens => darkThemeOrFallback(storedChatTheme, theme);

  const applyChatTheme = (tokens: ThemeTokens): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    setStudioAnimation(null);
    const appearance = { themeTokens: JSON.stringify(tokens) };
    queueScreenCommand(operationGrant, () =>
      updateChatAppearance(operationGrant.chatGuid, appearance, operationGrant.accountLease),
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
        const pickedUri = res.assets[0]!.uri;
        try {
          const appearance = await runScreenAccountTask(pickerGrant, async (activeLease) => {
            const chatGuid = pickerGrant.chatGuid;
            // Copy out of the purgeable ImagePicker cache into a stable app dir before storing.
            // The tracked task drains for its exact chat once admitted; only later UI publication
            // is revoked if this keyed screen is replaced.
            const stableUri = await persistBackground(chatGuid, pickedUri);
            if (!activeLease.isCurrent()) return null;
            // Record the wallpaper's luminance so overlay text stays legible on it.
            const backgroundIsLight = await computeBackgroundIsLight(stableUri);
            if (!activeLease.isCurrent()) return null;
            return { backgroundUri: stableUri, backgroundIsLight };
          });
          if (!appearance) return;
          await updateChatAppearance(pickerGrant.chatGuid, appearance, pickerGrant.accountLease);
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
        try {
          const prepared = await runScreenAccountTask(pickerGrant, async (activeLease) => {
            const chatGuid = pickerGrant.chatGuid;
            // Extract the seed colour from the picked asset, THEN copy it into a stable dir
            // (the ImagePicker cache path is purgeable) and persist that path.
            const tokens = await adaptiveTokensFromImage(pickedUri, 'dark');
            if (!activeLease.isCurrent()) return null;
            const uri = await persistBackground(chatGuid, pickedUri);
            if (!activeLease.isCurrent()) return null;
            const backgroundIsLight = await computeBackgroundIsLight(uri);
            if (!activeLease.isCurrent()) return null;
            return {
              generated: tokens != null,
              appearance: {
                ...(tokens ? { themeTokens: JSON.stringify(tokens) } : {}),
                backgroundUri: uri,
                backgroundIsLight,
              },
            };
          });
          if (!prepared) return;
          await updateChatAppearance(
            pickerGrant.chatGuid,
            prepared.appearance,
            pickerGrant.accountLease,
          );
          if (!prepared.generated && pickerIsCurrent()) {
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
    const appearance = { themeTokens: null, backgroundUri: null, backgroundIsLight: null };
    // Cleared the local override → drop its luminance; the synced background (if any) recomputes
    // its own on the next chat open (ensureSyncedBackground).
    queueScreenCommand(operationGrant, () =>
      updateChatAppearance(operationGrant.chatGuid, appearance, operationGrant.accountLease),
    );
  };

  const [repairing, setRepairing] = useState(false);

  const saveName = (text: string): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    setName(text);
    queueScreenCommand(operationGrant, () =>
      updateChatCustomization(
        operationGrant.chatGuid,
        { customName: text },
        operationGrant.accountLease,
      ),
    );
  };
  const renameAppleGroupName = (): void => {
    const operationGrant = renderGrant;
    if (
      !grantIsCurrent(operationGrant) ||
      !appleGroupRenameAvailable ||
      !appleGroupNameChanged ||
      renamingAppleGroup
    ) {
      return;
    }
    const submittedName = appleGroupNameValue;
    const authoritativeDisplayNameAtSubmit = data?.displayName ?? null;
    setRenamingAppleGroup(true);
    void renameAppleGroup(
      { chatGuid: operationGrant.chatGuid, displayName: submittedName },
      operationGrant.accountLease,
    )
      .then((result) => {
        if (!grantIsCurrent(operationGrant)) return;
        setRenamingAppleGroup(false);
        if (!result) return;
        if (result.status === 'accepted') {
          setAppleGroupName(null);
          setAcceptedAppleGroupNameOverlay({
            displayName: submittedName,
            authoritativeDisplayNameAtSubmit,
          });
          return;
        }
        if (result.status === 'outcome-unknown') {
          showDialog(
            'Rename Not Confirmed',
            'The request may have reached Messages. Check the group name in Messages on your Mac before trying again. The name you entered is still here.',
          );
          return;
        }
        showDialog(
          'Apple Group Name Not Changed',
          'Messages did not rename this group. Your name is still here so you can correct it or try again later.',
        );
      })
      .catch(() => {
        if (!grantIsCurrent(operationGrant)) return;
        setRenamingAppleGroup(false);
        showDialog(
          'Couldn’t Rename Group',
          'The Apple group name could not be changed. Your name is still here so you can correct it or try again later.',
        );
      });
  };
  const showAppleGroupPhotoResult = (
    operation: 'set' | 'remove',
    result: Awaited<ReturnType<typeof removeAppleGroupPhoto>>,
  ): void => {
    if (!result) return;
    const changing = operation === 'set';
    if (result.status === 'accepted') {
      showDialog(
        changing ? 'Group Photo Change Accepted' : 'Group Photo Removal Accepted',
        changing
          ? 'Messages accepted the photo change. Check the group in Messages on your Mac for the updated photo.'
          : 'Messages accepted the photo removal. Check the group in Messages on your Mac to confirm it is gone.',
      );
      return;
    }
    if (result.status === 'outcome-unknown') {
      showDialog(
        changing ? 'Photo Change Not Confirmed' : 'Photo Removal Not Confirmed',
        `The request may have reached Messages. Check the group photo in Messages on your Mac before trying ${
          changing ? 'the change' : 'the removal'
        } again.`,
      );
      return;
    }
    showDialog(
      changing ? 'Group Photo Not Changed' : 'Group Photo Not Removed',
      changing
        ? 'Messages did not change this group photo. You can choose another JPEG or PNG and try again.'
        : 'Messages did not remove this group photo. Check the group in Messages on your Mac before trying again.',
    );
  };
  const changeAppleGroupPhoto = (): void => {
    void (async () => {
      const operationGrant = renderGrant;
      if (!grantIsCurrent(operationGrant) || !appleGroupPhotoAvailable || changingAppleGroupPhoto) {
        return;
      }
      const pickerToken = pickerOwner.acquire();
      if (!pickerToken) return;
      const pickerIsCurrent = (): boolean =>
        pickerOwner.isCurrent(pickerToken) && grantIsCurrent(operationGrant);
      let prepared: Awaited<ReturnType<typeof prepareAppleGroupPhotoSet>> = null;
      setChangingAppleGroupPhoto(true);
      try {
        // Pin account, origin/auth, capability, and exact group proof before permission/picker UI.
        prepared = await prepareAppleGroupPhotoSet(
          operationGrant.chatGuid,
          operationGrant.accountLease,
        );
        if (!prepared || !pickerIsCurrent()) {
          if (pickerIsCurrent()) {
            showDialog(
              'Group Photo Unavailable',
              'This Apple group photo cannot be changed on the current server connection.',
            );
          }
          return;
        }
        if (!(await requestPhotoLibraryAccess(pickerIsCurrent)) || !pickerIsCurrent()) return;
        const response = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 1,
        }).catch(() => {
          if (pickerIsCurrent()) showDialog('Photos', 'Couldn’t open the photo picker.');
          return null;
        });
        if (!response || response.canceled || response.assets.length === 0 || !pickerIsCurrent()) {
          return;
        }

        const asset = response.assets[0]!;
        const fallbackName = asset.uri.split(/[?#]/u, 1)[0]?.split('/').pop() ?? '';
        const name = asset.fileName?.trim() || fallbackName;
        const mimeType = asset.mimeType?.trim().toLowerCase() ?? '';
        if (!isSupportedImessageGroupPhotoType(mimeType, name)) {
          showDialog(
            'Unsupported Group Photo',
            'Choose a JPEG (.jpg or .jpeg) or PNG (.png). HEIC photos are not supported for Apple group photos.',
          );
          return;
        }
        const size = typeof asset.fileSize === 'number' ? asset.fileSize : undefined;
        if (size !== undefined && (size <= 0 || size > MAX_IMESSAGE_GROUP_PHOTO_BYTES)) {
          showDialog('Group Photo Too Large', 'Choose a JPEG or PNG no larger than 20 MiB.');
          return;
        }

        const result = await prepared.submit({ uri: asset.uri, name, mimeType, size });
        prepared = null;
        if (pickerIsCurrent()) showAppleGroupPhotoResult('set', result);
      } catch {
        if (pickerIsCurrent()) {
          showDialog(
            'Couldn’t Change Group Photo',
            'The group photo request could not be completed. Check Messages on your Mac before trying again.',
          );
        }
      } finally {
        prepared?.cancel();
        pickerOwner.release(pickerToken);
        if (grantIsCurrent(operationGrant)) setChangingAppleGroupPhoto(false);
      }
    })();
  };
  const confirmRemoveAppleGroupPhoto = (): void => {
    const dialogGrant = renderGrant;
    if (!grantIsCurrent(dialogGrant) || !appleGroupPhotoAvailable || changingAppleGroupPhoto) {
      return;
    }
    showDialog(
      'Remove Apple Group Photo?',
      'This removes the group photo for everyone in Apple Messages.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove Photo',
          style: 'destructive',
          onPress: () => {
            if (!grantIsCurrent(dialogGrant) || changingAppleGroupPhoto) return;
            setChangingAppleGroupPhoto(true);
            void removeAppleGroupPhoto({ chatGuid: dialogGrant.chatGuid }, dialogGrant.accountLease)
              .then((result) => {
                if (grantIsCurrent(dialogGrant)) showAppleGroupPhotoResult('remove', result);
              })
              .catch(() => {
                if (grantIsCurrent(dialogGrant)) {
                  showDialog(
                    'Couldn’t Remove Group Photo',
                    'The removal request could not be completed. Check Messages on your Mac before trying again.',
                  );
                }
              })
              .finally(() => {
                if (grantIsCurrent(dialogGrant)) setChangingAppleGroupPhoto(false);
              });
          },
        },
      ],
    );
  };
  const addParticipantToAppleGroup = (): void => {
    const operationGrant = renderGrant;
    if (
      !grantIsCurrent(operationGrant) ||
      !appleGroupParticipantAddAvailable ||
      appleGroupParticipantAddress.length === 0 ||
      appleGroupMembershipOperationActiveRef.current
    ) {
      return;
    }
    const submittedAddress = appleGroupParticipantAddress;
    appleGroupMembershipOperationActiveRef.current = true;
    setAddingAppleGroupParticipant(true);
    void addAppleGroupParticipant(
      { chatGuid: operationGrant.chatGuid, address: submittedAddress },
      operationGrant.accountLease,
    )
      .then((result) => {
        if (!grantIsCurrent(operationGrant)) return;
        if (!result) return;
        if (result.status === 'accepted') {
          setAppleGroupParticipantAddress('');
          showDialog(
            'Add Request Accepted',
            'Messages accepted the add request. Gator will update this list after Messages syncs the roster.',
          );
          return;
        }
        if (result.status === 'outcome-unknown') {
          showDialog(
            'Add Not Confirmed',
            'The request may have reached Messages. Check the group membership in Messages on your Mac before trying again. The address you entered is still here.',
          );
          return;
        }
        showDialog(
          'Person Not Added',
          'Messages did not add this person. Enter a canonical +country-code number or email address, or try again later. The address you entered is still here.',
        );
      })
      .catch(() => {
        if (!grantIsCurrent(operationGrant)) return;
        showDialog(
          'Couldn’t Add Person',
          'The add request could not be completed. Check the group in Messages on your Mac before trying again. The address you entered is still here.',
        );
      })
      .finally(() => {
        appleGroupMembershipOperationActiveRef.current = false;
        if (grantIsCurrent(operationGrant)) setAddingAppleGroupParticipant(false);
      });
  };
  const confirmRemoveParticipantFromAppleGroup = (member: ChatParticipant): void => {
    const dialogGrant = renderGrant;
    if (
      !grantIsCurrent(dialogGrant) ||
      !appleGroupParticipantRemoveAvailable ||
      member.service !== 'iMessage' ||
      !isCanonicalIMessageParticipantAddress(member.address) ||
      appleGroupMembershipOperationActiveRef.current
    ) {
      return;
    }
    showDialog(
      'Remove Person from Apple Group?',
      `This removes ${member.name} from the group for everyone in Apple Messages.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove Person',
          style: 'destructive',
          onPress: () => {
            if (!grantIsCurrent(dialogGrant) || appleGroupMembershipOperationActiveRef.current) {
              return;
            }
            appleGroupMembershipOperationActiveRef.current = true;
            setRemovingAppleGroupParticipantAddress(member.address);
            void removeAppleGroupParticipant(
              { chatGuid: dialogGrant.chatGuid, address: member.address },
              dialogGrant.accountLease,
            )
              .then((result) => {
                if (!grantIsCurrent(dialogGrant) || !result) return;
                if (result.status === 'accepted') {
                  showDialog(
                    'Removal Request Accepted',
                    'Messages accepted the removal request. Gator will update this roster only after Messages sync confirms it.',
                  );
                  return;
                }
                if (result.status === 'outcome-unknown') {
                  showDialog(
                    'Removal Not Confirmed',
                    'The request may have reached Messages. Check the group membership in Messages on your Mac before trying again. Gator has not changed this roster.',
                  );
                  return;
                }
                showDialog(
                  'Person Not Removed',
                  'Messages did not confirm this removal. Gator has kept the roster unchanged; let it sync and check Messages on your Mac before trying again.',
                );
              })
              .catch(() => {
                if (!grantIsCurrent(dialogGrant)) return;
                showDialog(
                  'Couldn’t Remove Person',
                  'The removal request could not be completed. Gator has kept the roster unchanged; check Messages on your Mac before trying again.',
                );
              })
              .finally(() => {
                appleGroupMembershipOperationActiveRef.current = false;
                if (grantIsCurrent(dialogGrant)) setRemovingAppleGroupParticipantAddress(null);
              });
          },
        },
      ],
    );
  };
  const confirmLeaveAppleGroup = (): void => {
    const dialogGrant = renderGrant;
    if (
      !grantIsCurrent(dialogGrant) ||
      !appleGroupLeaveAvailable ||
      appleGroupMembershipOperationActiveRef.current
    ) {
      return;
    }
    showDialog(
      'Leave Apple Group?',
      'This changes the group in Apple Messages for everyone and may remove your access to future messages.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave Group',
          style: 'destructive',
          onPress: () => {
            if (!grantIsCurrent(dialogGrant) || appleGroupMembershipOperationActiveRef.current) {
              return;
            }
            appleGroupMembershipOperationActiveRef.current = true;
            setLeavingAppleGroup(true);
            void leaveAppleGroup({ chatGuid: dialogGrant.chatGuid }, dialogGrant.accountLease)
              .then((result) => {
                if (!grantIsCurrent(dialogGrant) || !result) return;
                if (result.status === 'accepted') {
                  showDialog(
                    'Leave Request Accepted',
                    'Messages accepted the leave request. Gator will keep this conversation until authoritative sync updates it.',
                  );
                  return;
                }
                if (result.status === 'outcome-unknown') {
                  showDialog(
                    'Leave Not Confirmed',
                    'The request may have reached Messages. Check the group in Messages on your Mac before trying again. Gator has not removed this conversation or changed its roster.',
                  );
                  return;
                }
                showDialog(
                  'Group Not Left',
                  'Messages did not confirm that you left. Gator has kept this conversation and roster unchanged; let it sync and check Messages on your Mac before trying again.',
                );
              })
              .catch(() => {
                if (!grantIsCurrent(dialogGrant)) return;
                showDialog(
                  'Couldn’t Leave Group',
                  'The leave request could not be completed. Gator has kept this conversation and roster unchanged; check Messages on your Mac before trying again.',
                );
              })
              .finally(() => {
                appleGroupMembershipOperationActiveRef.current = false;
                if (grantIsCurrent(dialogGrant)) setLeavingAppleGroup(false);
              });
          },
        },
      ],
    );
  };
  const pickColor = (color: string | null): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    queueScreenCommand(operationGrant, () =>
      updateChatCustomization(
        operationGrant.chatGuid,
        { customColor: color },
        operationGrant.accountLease,
      ),
    );
  };
  const pickHandleColor = (member: ChatParticipant, color: string | null): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    queueScreenCommand(operationGrant, () =>
      updateHandleColor(
        operationGrant.chatGuid,
        member.address,
        member.service,
        color,
        operationGrant.accountLease,
      ),
    );
  };
  const toggleMute = (on: boolean): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    queueScreenCommand(operationGrant, () =>
      setChatMuted(operationGrant.chatGuid, on, operationGrant.accountLease),
    );
  };
  const resetAll = (): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant)) return;
    setName('');
    queueScreenCommand(operationGrant, () =>
      resetChatLocalPreferences(operationGrant.chatGuid, operationGrant.accountLease),
    );
  };

  const repairConversation = (): void => {
    const dialogGrant = renderGrant;
    if (!grantIsCurrent(dialogGrant) || repairing) return;
    showDialog(
      'Repair Conversation',
      'Re-download this conversation’s server details and 500 most recent messages? Your local name, theme, wallpaper, mute setting, and deleted-message protections stay in place.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Start Repair',
          onPress: () => {
            if (!grantIsCurrent(dialogGrant)) return;
            setRepairing(true);
            void startChatRepair(dialogGrant.chatGuid)
              .then((result) => {
                if (!grantIsCurrent(dialogGrant)) return;
                showDialog(
                  'Conversation Repaired',
                  `${result.messages.toLocaleString()} recent messages were refreshed.`,
                );
              })
              .catch(() => {
                if (grantIsCurrent(dialogGrant)) {
                  showDialog(
                    'Repair Failed',
                    'Gator couldn’t refresh this conversation. Check the server connection and try again.',
                  );
                }
              })
              .finally(() => {
                if (grantIsCurrent(dialogGrant)) setRepairing(false);
              });
          },
        },
      ],
    );
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
  const openDocuments = (): void => {
    if (!grantIsCurrent(renderGrant)) return;
    router.push(`/documents/${encodeURIComponent(guid)}`);
  };
  const openLink = (url: string): void => {
    const operationGrant = renderGrant;
    if (!grantIsCurrent(operationGrant) || activeLinkOpenRef.current) return;
    const token = {};
    activeLinkOpenRef.current = token;
    void (async () => {
      try {
        const opened = await safeOpenUrl(url);
        if (!opened && activeLinkOpenRef.current === token && grantIsCurrent(operationGrant)) {
          showExternalOpenFailure();
        }
      } catch {
        if (activeLinkOpenRef.current === token && grantIsCurrent(operationGrant)) {
          showExternalOpenFailure();
        }
      } finally {
        if (activeLinkOpenRef.current === token) activeLinkOpenRef.current = null;
      }
    })();
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
  return (
    <>
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection label="PHONE-LOCAL NICKNAME">
          <TextInput
            value={customName}
            onChangeText={saveName}
            placeholder={serverTitle || 'Custom name'}
            placeholderTextColor={theme.color.tertiaryLabel}
            accessibilityLabel="Phone-Local Nickname"
            style={[styles.input, { color: theme.color.label }]}
          />
        </SettingsSection>

        {appleGroupRenameAvailable ? (
          <SettingsSection label="APPLE GROUP NAME" style={styles.gap}>
            <TextInput
              value={appleGroupNameValue}
              onChangeText={setAppleGroupName}
              placeholder="Apple Group Name"
              placeholderTextColor={theme.color.tertiaryLabel}
              accessibilityLabel="Apple Group Name"
              editable={!renamingAppleGroup}
              style={[styles.input, { color: theme.color.label }]}
            />
            <Text style={[styles.help, { color: theme.color.secondaryLabel }]}>
              This changes the group name for everyone in Apple Messages. It does not change the
              phone-local nickname above.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Rename in Apple Messages"
              accessibilityState={{
                disabled: renamingAppleGroup || !appleGroupNameChanged,
              }}
              disabled={renamingAppleGroup || !appleGroupNameChanged}
              onPress={renameAppleGroupName}
              style={styles.row}
            >
              <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                {renamingAppleGroup ? 'Renaming in Apple Messages…' : 'Rename in Apple Messages'}
              </Text>
            </Pressable>
          </SettingsSection>
        ) : null}

        {appleGroupPhotoAvailable ? (
          <SettingsSection label="APPLE GROUP PHOTO" style={styles.gap}>
            <Text style={[styles.help, { color: theme.color.secondaryLabel }]}>
              This changes the photo for everyone in Apple Messages. Gator waits for Messages sync
              instead of changing local data immediately.
            </Text>
            <NavRow
              label={changingAppleGroupPhoto ? 'Changing Apple Group Photo…' : 'Change Photo…'}
              accessibilityLabel="Change Apple Group Photo"
              color="label"
              chevron={false}
              disabled={changingAppleGroupPhoto}
              onPress={changeAppleGroupPhoto}
            />
            <NavRow
              label="Remove Photo"
              accessibilityLabel="Remove Apple Group Photo"
              color="destructive"
              chevron={false}
              disabled={changingAppleGroupPhoto}
              onPress={confirmRemoveAppleGroupPhoto}
            />
          </SettingsSection>
        ) : null}

        {appleGroupParticipantAddAvailable ? (
          <SettingsSection label="ADD TO APPLE GROUP" style={styles.gap}>
            <TextInput
              value={appleGroupParticipantAddress}
              onChangeText={setAppleGroupParticipantAddress}
              placeholder="+15551234567 or person@example.com"
              placeholderTextColor={theme.color.tertiaryLabel}
              accessibilityLabel="Apple Group Participant Address"
              autoCapitalize="none"
              autoCorrect={false}
              editable={
                !addingAppleGroupParticipant &&
                removingAppleGroupParticipantAddress === null &&
                !leavingAppleGroup
              }
              style={[styles.input, { color: theme.color.label }]}
            />
            <Text style={[styles.help, { color: theme.color.secondaryLabel }]}>
              Enter a full international number beginning with + or an email address. Gator waits
              for Messages sync to update the roster instead of changing it locally.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add Person to Apple Group"
              accessibilityState={{
                disabled:
                  addingAppleGroupParticipant ||
                  removingAppleGroupParticipantAddress !== null ||
                  leavingAppleGroup ||
                  appleGroupParticipantAddress.length === 0,
              }}
              disabled={
                addingAppleGroupParticipant ||
                removingAppleGroupParticipantAddress !== null ||
                leavingAppleGroup ||
                appleGroupParticipantAddress.length === 0
              }
              onPress={addParticipantToAppleGroup}
              style={styles.row}
            >
              <Text style={[styles.rowLabel, { color: theme.color.label }]}>
                {addingAppleGroupParticipant ? 'Adding in Apple Messages…' : 'Add Person'}
              </Text>
            </Pressable>
          </SettingsSection>
        ) : null}

        {appleGroupLeaveAvailable ? (
          <SettingsSection label="APPLE GROUP MEMBERSHIP" style={styles.gap}>
            <Text style={[styles.help, { color: theme.color.secondaryLabel }]}>
              Leaving changes Apple Messages for everyone and may remove your access. Gator waits
              for Messages sync instead of deleting this conversation locally.
            </Text>
            <NavRow
              label={leavingAppleGroup ? 'Leaving Apple Group…' : 'Leave Apple Group'}
              accessibilityLabel="Leave Apple Group"
              color="destructive"
              chevron={false}
              disabled={
                leavingAppleGroup ||
                addingAppleGroupParticipant ||
                removingAppleGroupParticipantAddress !== null
              }
              onPress={confirmLeaveAppleGroup}
            />
          </SettingsSection>
        ) : null}

        <SettingsSection label="BUBBLE COLOR" style={styles.gap}>
          <View style={styles.swatchRow}>
            <Pressable
              onPress={() => pickColor(null)}
              accessibilityRole="radio"
              accessibilityLabel="Default bubble color"
              accessibilityState={{ selected: accent == null }}
              hitSlop={6}
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
                accessibilityRole="radio"
                accessibilityLabel={`${SWATCH_NAMES[c]} bubble color`}
                accessibilityState={{ selected: accent === c }}
                hitSlop={6}
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

        <MediaSections
          media={mediaData}
          documentSummary={
            documentPage
              ? { loadedCount: documentPage.items.length, hasMore: documentPage.hasMore }
              : null
          }
          onOpenMedia={openMedia}
          onOpenDocuments={openDocuments}
          onOpenLink={openLink}
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
              onPress={openNotificationSettings}
              accessibilityLabel="Open system notification settings for this conversation"
            />
          ) : null}
        </SettingsSection>

        <SettingsSection label="REPAIR" style={styles.gap}>
          <NavRow
            label={repairing ? 'Repairing Conversation…' : 'Repair Conversation'}
            chevron={false}
            disabled={repairing}
            onPress={repairConversation}
            accessibilityLabel={
              repairing
                ? 'Repairing this conversation from the server'
                : 'Repair this conversation from the server'
            }
          />
        </SettingsSection>

        {members.length > 0 ? (
          <SettingsSection
            label={isGroup ? `GROUP · ${members.length} PEOPLE` : 'CONTACT COLOR'}
            style={styles.gap}
          >
            {members.map((member) => (
              <View key={JSON.stringify([member.address, member.service])}>
                <View style={styles.handleHeader}>
                  <View
                    testID={`handle-color-preview-${member.address}-${member.service ?? ''}`}
                    style={[
                      styles.handlePreview,
                      {
                        backgroundColor: member.color ?? theme.color.tertiaryLabel,
                        borderColor: theme.color.separator,
                      },
                    ]}
                  />
                  <Text
                    numberOfLines={1}
                    style={[styles.rowLabel, { color: theme.color.label, flex: 1 }]}
                  >
                    {member.name}
                  </Text>
                  {member.service ? (
                    <Text style={[styles.handleService, { color: theme.color.tertiaryLabel }]}>
                      {member.service}
                    </Text>
                  ) : null}
                  {appleGroupParticipantRemoveAvailable &&
                  member.service === 'iMessage' &&
                  isCanonicalIMessageParticipantAddress(member.address) ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${member.name} from Apple Group`}
                      accessibilityState={{
                        disabled:
                          addingAppleGroupParticipant ||
                          removingAppleGroupParticipantAddress !== null ||
                          leavingAppleGroup,
                      }}
                      disabled={
                        addingAppleGroupParticipant ||
                        removingAppleGroupParticipantAddress !== null ||
                        leavingAppleGroup
                      }
                      onPress={() => confirmRemoveParticipantFromAppleGroup(member)}
                    >
                      <Text style={[styles.handleAction, { color: theme.color.destructive }]}>
                        {removingAppleGroupParticipantAddress === member.address
                          ? 'Removing…'
                          : 'Remove'}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                <View style={styles.handleSwatchRow}>
                  <Pressable
                    onPress={() => pickHandleColor(member, null)}
                    accessibilityRole="radio"
                    accessibilityLabel={`Default color for ${member.name}`}
                    accessibilityState={{ selected: member.color == null }}
                    hitSlop={6}
                    style={[
                      styles.handleSwatch,
                      styles.defaultSwatch,
                      { borderColor: theme.color.separator },
                      member.color == null && styles.swatchOn,
                    ]}
                  >
                    <Text style={[styles.defaultMark, { color: theme.color.secondaryLabel }]}>
                      ✕
                    </Text>
                  </Pressable>
                  {HANDLE_COLOR_SWATCHES.map(({ color, name: colorName }) => (
                    <Pressable
                      key={color}
                      onPress={() => pickHandleColor(member, color)}
                      accessibilityRole="radio"
                      accessibilityLabel={`${colorName} color for ${member.name}`}
                      accessibilityState={{ selected: member.color === color }}
                      hitSlop={6}
                      style={[
                        styles.handleSwatch,
                        { backgroundColor: color },
                        member.color === color && styles.swatchOn,
                      ]}
                    />
                  ))}
                </View>
              </View>
            ))}
          </SettingsSection>
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
          onRequestClose={() => setStudioCancelRequest((request) => request + 1)}
          testID="chat-theme-studio-modal"
        >
          <ThemeStudio
            title="Chat Theme"
            initialTokens={studioTokens()}
            showName={false}
            onApply={(tokens) => applyChatTheme(tokens)}
            onCancel={closeStudio}
            cancelRequest={studioCancelRequest}
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
  help: { paddingHorizontal: 16, paddingBottom: 8, fontSize: 13, lineHeight: 18 },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, padding: 16 },
  swatch: { width: 36, height: 36, borderRadius: 18 },
  defaultSwatch: {
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  defaultMark: { fontSize: 16 },
  swatchOn: { borderWidth: 3, borderColor: '#FFFFFF' },
  handleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  handlePreview: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  handleService: { fontSize: 13 },
  handleAction: { fontSize: 15, paddingVertical: 6 },
  handleSwatchRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
  },
  handleSwatch: { width: 32, height: 32, borderRadius: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLabel: { fontSize: 16 },
  rowValue: { fontSize: 15 },
  reset: { alignItems: 'center', paddingVertical: 24 },
  resetText: { fontSize: 16 },
});
