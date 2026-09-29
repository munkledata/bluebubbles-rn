import { Image } from 'expo-image';
import { useLocalSearchParams, useNavigation, useRoute, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { isAggregateRetractionTombstone } from '@core/messages/retraction';
import type { IMessageTextFormattingRange } from '@core/api/endpoints/messages';
import type { Recurrence } from '@core/schedule';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { showConfirm, showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DRAFT_KV_PREFIX,
  kvGet,
  type MessagePreview,
  type MessageWindowAnchor,
  type ShareIntakeManifestIdentity,
} from '@db/repositories';
import { saveChatDraft, sendTyping } from '@/services';
import { readMessagePreview } from '@/services/messagePreview';
import { getDatabase } from '@db/database';
import { getContactsPermissionState } from '@/services/contacts/contactsService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
import {
  admitShareIntakeTextDraft,
  consumeShareIntakeBatch,
  discardShareIntakeItem,
  discardShareIntakeBatch,
  drainShareIntake,
  isShareIntakeFileSettled,
  isShareIntakeReceiptComplete,
  readShareIntakeReceipt,
} from '@/services/share/shareIntake';
import {
  hasLogicalSendCapacity,
  acquireAndSendCurrentLocation,
  editText,
  isContactsPermissionDeniedError,
  isSupportedImessageAttachmentFile,
  pickAndSendContact,
  reply,
  schedule,
  scheduleAttachment,
  send,
  sendEffect,
  sendFormatted,
  sendMention,
  sendImage,
  sendImages,
  sendVoice,
  sendTextAttachment,
  type AttachmentQueueAdmission,
} from '@/services/send';
import { logger } from '@core/secure';
import { MAX_IMESSAGE_VOICE_UPLOAD_BYTES } from '@core/models/serverInfo';
import { isCurrentRcsChatGuid } from '@core/rcs/providerIdentity';
import { useSendAttachmentTextSupported, useSessionStore } from '@state/sessionStore';
import { devSendFake } from '@features/conversations/devSeed';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { useChatSearch } from '@features/conversations/useChatSearch';
import { useMessageActions } from '@features/conversations/useMessageActions';
import { useMessages } from '@features/conversations/useMessages';
import { useNewScreenEffect } from '@features/conversations/useNewScreenEffect';
import {
  backfillChatUnlessDeleted,
  useChatReadLifecycle,
} from '@features/conversations/useChatReadLifecycle';
import { useChatScheduledCatchup } from '@features/conversations/useChatScheduledCatchup';
import { isDevServer } from '@utils/isDev';
import {
  Composer,
  ChatSearchBar,
  ConversationHeader,
  EditHistorySheet,
  MessageActionsOverlay,
  MessageDetailsSheet,
  MessageList,
  Screen,
  ScreenEffectOverlay,
  showToast,
  ThreadSheet,
  TypingBubble,
  UploadStatusBar,
  useTheme,
  type ComposerRemovalState,
  type PendingAttachment,
} from '@ui';
import { ChatThemeProvider, useChatBackgroundUri } from '@ui/theme/ChatThemeProvider';
import { readableTextOn } from '@ui/theme/adaptiveFromImage';
import { useKeyboardVisible } from '@ui/hooks/useKeyboardVisible';
import {
  showContactsPermissionRationale,
  showContactsPermissionRecovery,
} from '@ui/permissions/contactsPermission';
import { LoadErrorBoundary } from '@ui/LoadErrorBoundary';
import { presentSendIssue } from '@ui/conversations/sendNotices';
import type { ComposerAdmissionResult } from '@ui/conversations/useComposerAuthoringSession';
import { useTypingStore } from '@state/typingStore';
import { useShareIntentStore } from '@state/shareIntentStore';
import {
  isGroupRow,
  isProvenIMessageGroupChat,
  isProvenOneToOneIMessageChat,
  participantList,
  resolveChatService,
  resolveTitle,
} from '@utils';

interface DocumentPickerModule {
  getDocumentAsync(options: {
    multiple: boolean;
    copyToCacheDirectory: boolean;
    type?: string[];
  }): Promise<{
    canceled: boolean;
    assets: Array<{
      uri: string;
      name: string;
      mimeType?: string | null;
      size?: number | null;
    }> | null;
  }>;
}

type DocumentPickerLoader = () => Promise<DocumentPickerModule>;

/**
 * Resolve at the DB queue handoff rather than at the much later network response. A rejection
 * before that callback means the caller still owns the only authored copy and must retain it.
 */
function observeQueueAdmission(
  start: (onQueued: () => void) => Promise<unknown>,
  onQueued: () => void,
  onRejectedBeforeQueue: (error: unknown) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let queued = false;
    const markQueued = (): void => {
      if (queued) return;
      queued = true;
      try {
        onQueued();
      } catch (error) {
        logger.warn('[chat] queue handoff observer failed', error);
      }
      resolve(true);
    };

    let operation: Promise<unknown>;
    try {
      operation = Promise.resolve(start(markQueued));
    } catch (error) {
      onRejectedBeforeQueue(error);
      resolve(false);
      return;
    }
    void operation.then(
      () => {
        if (!queued) resolve(false);
      },
      (error: unknown) => {
        if (!queued) {
          onRejectedBeforeQueue(error);
          resolve(false);
        }
        // After markQueued, the bubble + retry queue are the user-visible owner. The service logs
        // and reconciles normal transport failures; account retirement is intentionally silent.
      },
    );
  });
}

/**
 * Open the account-neutral OS picker, then accept its result only if the screen that opened it
 * still owns the active account. The loader is injectable solely to make the delayed native-return
 * boundary deterministic in Node tests; production retains the lazy native import.
 */
export async function pickDocumentFilesForLease(
  accountLease: { isCurrent(): boolean },
  loadPicker: DocumentPickerLoader = () => import('expo-document-picker'),
  imessageAttachmentOnly = false,
  imessagePdfAvailable = false,
): Promise<PendingAttachment[]> {
  try {
    const DocumentPicker = await loadPicker();
    if (!accountLease.isCurrent()) return [];
    const res = await DocumentPicker.getDocumentAsync({
      multiple: !imessageAttachmentOnly,
      copyToCacheDirectory: true,
      ...(imessageAttachmentOnly
        ? {
            type: ['image/jpeg', 'image/png', ...(imessagePdfAvailable ? ['application/pdf'] : [])],
          }
        : {}),
    });
    if (!accountLease.isCurrent() || res.canceled || !res.assets || res.assets.length === 0) {
      return [];
    }
    return res.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType ?? 'application/octet-stream',
      size: asset.size ?? 0,
    }));
  } catch {
    if (accountLease.isCurrent()) showDialog('Attach', 'Couldn’t open the file picker.');
    return [];
  }
}

// Lazy: expo-audio (native) is only pulled in when the user actually records a voice memo,
// so the chat opens fine on a build that hasn't linked the module yet.
const VoiceRecorder = lazy(() =>
  import('@ui/conversations/VoiceRecorder').then((m) => ({ default: m.VoiceRecorder })),
);

/**
 * Phase 4 conversation view: reactive message list + composer with optimistic send.
 * Wrapped in ChatThemeProvider so a per-chat theme (Phase 3.2) recolors the whole
 * conversation — every `useTheme()` below (including Screen) sees the chat override.
 */
export default function ChatScreen(): React.JSX.Element {
  // `focus`/`focusDate` arrive when opened from a search hit — scroll to + highlight that message.
  const { guid, focus, shareBatch } = useLocalSearchParams<{
    guid: string;
    focus?: string;
    focusDate?: string;
    shareBatch?: string;
  }>();
  const route = useRoute();
  // Remount the whole per-chat subtree when the chat (or its open mode) changes. The screen
  // instance is REUSED on a `router.replace` thread switch (notification tap while a chat is open),
  // and `useReactiveQuery` keeps the PREVIOUS deps' data until the new query resolves — without the
  // key, `messagesLoading` never gates, so the list mounted with the previous chat's rows, did its
  // one-shot bottom landing against the wrong content, and stranded the new thread mid-history.
  // Route identity changes on replace/push, but remains stable when this screen clears its own
  // focus params with setParams. That preserves the mounted Composer during local anchor exit while
  // still resetting pagination, jumps, reply/edit targets, and selection for a genuine navigation.
  // Keep the exact share claim as a reset boundary for same-thread Direct Share navigation.
  const screenKey = `${route.key}|${guid}|${shareBatch ?? ''}`;
  return (
    <ChatThemeProvider key={screenKey} guid={guid}>
      <ChatScreenInner guid={guid} focusGuid={focus} shareBatchId={shareBatch} />
    </ChatThemeProvider>
  );
}

function ChatScreenInner({
  guid,
  focusGuid,
  shareBatchId,
}: {
  guid: string;
  focusGuid?: string;
  shareBatchId?: string;
}): React.JSX.Element {
  // This lease belongs to THIS mounted chat. Dialogs, pickers and lazy callbacks can outlive the
  // account that rendered them; passing the mount lease prevents such an A callback from capturing
  // B merely because it is invoked after reconnect.
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const header = useChatHeader(guid);
  const backgroundUri = useChatBackgroundUri(guid);
  const visibleBackgroundUri = accountLease.isCurrent() ? backgroundUri : null;
  const isGroup = header.data ? isGroupRow(header.data) : false;
  // The chat's service for the badge, composer placeholder, and outgoing-bubble colour. Resolved
  // from the participant handle service (not just the guid prefix) so an SMS-only thread reads SMS.
  const chatService = resolveChatService(guid, header.data?.handleServices);
  const rcsAvailable = useSessionStore((s) => isCurrentRcsChatGuid(s.serverInfo, guid));
  const rcsInteractiveFeaturesAvailable = rcsAvailable && chatService === 'RCS';
  const imessageAttachmentSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_attachment_upload === true,
  );
  const imessagePdfSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_pdf_attachment_upload === true,
  );
  const imessageReactionSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_reactions === true,
  );
  const imessageReplySupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_replies === true,
  );
  const imessageEditSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_edit === true,
  );
  const imessageUnsendSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_unsend === true,
  );
  const imessageRemoteDeleteSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_remote_delete === true,
  );
  const imessageEffectsSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_effects === true,
  );
  const imessageMentionsSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_mentions === true,
  );
  const imessageFormattedSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_formatted_messages === true,
  );
  const imessageTypingSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_typing === true,
  );
  const imessageVoiceSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_voice_upload === true,
  );
  const imessageScheduledAttachmentSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_scheduled_attachment === true,
  );
  const imessageContactSupported = useSessionStore(
    (s) => s.serverInfo?.supports_send_contact === true,
  );
  const imessageLocationSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_location === true,
  );
  const imessageAttachmentFeaturesAvailable =
    imessageAttachmentSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const imessagePdfFeaturesAvailable = imessageAttachmentFeaturesAvailable && imessagePdfSupported;
  const imessageReactionsAvailable =
    imessageReactionSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const imessageRepliesAvailable =
    imessageReplySupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const imessageEditsAvailable =
    imessageEditSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const imessageUnsendsAvailable =
    imessageUnsendSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const imessageRemoteDeleteAvailable =
    imessageRemoteDeleteSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    (isProvenOneToOneIMessageChat(header.data) || isProvenIMessageGroupChat(header.data));
  const imessageEffectsAvailable =
    imessageEffectsSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    header.data.participantCount === 1 &&
    isProvenOneToOneIMessageChat(header.data);
  const imessageFormattedAvailable =
    imessageFormattedSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const imessageMentionsAvailable =
    imessageMentionsSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenIMessageGroupChat(header.data);
  const mentionParticipants = useMemo(() => {
    if (!imessageMentionsAvailable || !header.data) return [];
    const names = participantList(header.data.participantNames);
    const addresses = (header.data.participantAddresses ?? '').split('|||');
    if (
      addresses.length !== header.data.participantCount ||
      names.length !== header.data.participantCount
    ) {
      return [];
    }
    const participants = addresses.map((rawAddress, index) => {
      const address = rawAddress;
      const rawName = names[index]?.trim() ?? '';
      const label = rawName && !/[\u0000-\u001f\u007f-\u009f]/u.test(rawName) ? rawName : address;
      return { address, label };
    });
    const hasUniqueAddresses =
      new Set(participants.map((participant) => participant.address)).size === participants.length;
    return hasUniqueAddresses &&
      participants.every(
        (participant) =>
          participant.address.length > 0 &&
          participant.address === participant.address.trim() &&
          !/[\u0000-\u001f\u007f-\u009f]/u.test(participant.address) &&
          participant.label.length > 0,
      )
      ? participants
      : [];
  }, [header.data, imessageMentionsAvailable]);
  const imessageTypingAvailable =
    imessageTypingSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const typingFeaturesAvailable = rcsInteractiveFeaturesAvailable || imessageTypingAvailable;
  const imessageVoiceAvailable =
    imessageVoiceSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const voiceFeaturesAvailable = rcsInteractiveFeaturesAvailable || imessageVoiceAvailable;
  const imessageScheduledAttachmentsAvailable =
    imessageAttachmentFeaturesAvailable && imessageScheduledAttachmentSupported;
  const attachmentFeaturesAvailable =
    rcsInteractiveFeaturesAvailable || imessageAttachmentFeaturesAvailable;
  const supportsSendAttachmentText = useSendAttachmentTextSupported(chatService);
  const imessageCaptionFeaturesAvailable =
    imessageAttachmentFeaturesAvailable && supportsSendAttachmentText;
  // Search hits, reminders, unread jumps, and thread jumps all use exact message identity. The DB
  // resolves that identity to a stable (date,id) window, so null/equal timestamps cannot strand the
  // requested bubble outside the loaded context.
  const [jump, setJump] = useState<MessageWindowAnchor | null>(null);
  const routeAnchor: MessageWindowAnchor | undefined = focusGuid ? { guid: focusGuid } : undefined;
  const anchor = jump ?? routeAnchor;
  const effFocusGuid = jump?.guid ?? focusGuid;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchNavigating, setSearchNavigating] = useState(false);
  const [returningToNewest, setReturningToNewest] = useState(false);
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const searchNavigationTokenRef = useRef(0);
  const appliedSearchKeyRef = useRef('');

  // A short debounce keeps typing responsive without querying FTS for every keypress.
  useEffect(() => {
    const trimmed = searchText.trim();
    if (!searchOpen || trimmed.length < 3) return;
    const timer = setTimeout(() => setSearchQuery(trimmed), 250);
    return () => clearTimeout(timer);
  }, [searchOpen, searchText]);
  const chatSearch = useChatSearch(guid, searchQuery, accountLease);
  const {
    fetchNextPage: fetchNextSearchPage,
    hasNextPage: hasNextSearchPage,
    isPending: searchPending,
    results: searchResults,
    totalCount: searchTotalCount,
  } = chatSearch;
  // The message window grows as the user scrolls back through history (see onLoadOlder). Starts at
  // one screen-worth+ and pages by PAGE_SIZE. In search-anchor mode the window is centered on the
  // hit instead (limit is ignored), so pagination is disabled there.
  const [limit, setLimit] = useState(250);
  const {
    data: messagesData,
    error: messagesError,
    isCurrentWindow,
    refreshWindow,
  } = useMessages(guid, limit, anchor);
  const messages = useMemo(() => messagesData ?? [], [messagesData]);
  // Hold the list back until the FIRST DB read resolves, so FlashList mounts WITH data. Its
  // `startRenderingFromBottom` only anchors the newest message on the INITIAL render (verified
  // against flash-list 2.0.2) — mounting empty and populating later left chats opening mid-history.
  // An error still "resolves" the load (the banner explains it); only a genuine null is loading.
  const messagesLoading = messagesData == null && messagesError == null;
  // Load older history when the list reaches the top. Guarded so repeated onStartReached fires (and
  // the async reactive re-query) can't stack several page-grows at once: the ref is set on grow and
  // cleared when the message count actually changes (new page arrived). Growth stops once a load
  // returns fewer rows than requested — that means the start of history is reached.
  const loadingOlderRef = useRef(false);
  useEffect(() => {
    loadingOlderRef.current = false;
  }, [messages.length]);
  const onLoadOlder = useCallback((): void => {
    if (anchor != null || loadingOlderRef.current) return;
    if (messages.length < limit) return;
    loadingOlderRef.current = true;
    setLimit((n) => n + 200);
  }, [anchor, messages.length, limit]);
  // The list's scroll-to-bottom button in an ANCHORED session (search hit / unread jump): exit the
  // anchor and return to the live newest window. Clearing route params keeps this route identity
  // and Composer mounted; the anchored→normal data swap converges through the list's pinned follow
  // loop. Search close separately keeps Composer hidden until that exact newest request settles.
  // '' (not undefined) is the strict-TS-safe way to drop a param — the existing focus-guid guard
  // treats it as absent (`findIndex('') === -1`). `focusDate` remains in old deep links only for
  // compatibility; exact message identity now owns the window lookup.
  const router = useRouter();
  const navigation = useNavigation();
  const exitAnchor = useCallback((): void => {
    // Advance the proof generation even if a prior newest result is still retained. Otherwise a
    // quick newest → pending anchor → newest bounce could mistake that older result for this exit.
    refreshWindow();
    setJump(null);
    router.setParams({ focus: '', focusDate: '' });
  }, [refreshWindow, router]);

  const closeSearch = useCallback((): void => {
    searchNavigationTokenRef.current += 1;
    appliedSearchKeyRef.current = '';
    setReturningToNewest(true);
    setSearchOpen(false);
    setSearchText('');
    setSearchQuery('');
    setSearchIndex(0);
    setSearchNavigating(false);
    // Search uses a bounded context window. Return to the live newest window before the composer
    // becomes usable again, or a send outside that old window can look as though it disappeared.
    exitAnchor();
  }, [exitAnchor]);
  const hasMessageAnchor = anchor != null;
  useEffect(() => {
    if (!returningToNewest || hasMessageAnchor || !isCurrentWindow || !accountLease.isCurrent()) {
      return;
    }
    // This acknowledges an async DB result for the requested newest window; it is not derived
    // render state. The flag must reset so a later search close establishes a fresh barrier.
    setReturningToNewest(false);
  }, [accountLease, hasMessageAnchor, isCurrentWindow, returningToNewest]);
  const exitSearchAnchor = useCallback((): void => {
    if (searchOpenRef.current) closeSearch();
    else exitAnchor();
  }, [closeSearch, exitAnchor]);
  const onSearchTextChange = useCallback((value: string): void => {
    const query = value.trim();
    setSearchText(value);
    // Leading/trailing whitespace does not change the normalized FTS query. Preserve the current
    // exact hit and any in-flight page instead of clearing them for a state update React will
    // correctly treat as a no-op.
    if (query === searchQueryRef.current) return;
    searchNavigationTokenRef.current += 1;
    appliedSearchKeyRef.current = '';
    if (query.length < 3) setSearchQuery('');
    setSearchIndex(0);
    setSearchNavigating(false);
    // Do not leave a stale prior-query result highlighted while the next query is debouncing.
    setJump(null);
  }, []);

  // Select the newest hit once for each completed query. Later page loads reuse the same key and
  // therefore cannot snap the reader back to result zero.
  useEffect(() => {
    if (
      !searchOpen ||
      searchQuery.length < 3 ||
      searchText.trim() !== searchQuery ||
      !accountLease.isCurrent()
    ) {
      return;
    }
    const key = `${accountLease.generation}\u0000${guid}\u0000${searchQuery}`;
    if (searchPending || appliedSearchKeyRef.current === key) return;
    appliedSearchKeyRef.current = key;
    searchNavigationTokenRef.current += 1;
    setSearchIndex(0);
    setSearchNavigating(false);
    const first = searchResults[0];
    setJump(first ? { id: first.id, guid: first.guid } : null);
  }, [accountLease, searchPending, searchResults, guid, searchOpen, searchQuery, searchText]);

  const moveToSearchResult = useCallback(
    async (targetIndex: number): Promise<void> => {
      if (targetIndex < 0 || targetIndex >= searchTotalCount || searchNavigating) return;
      const key = searchQuery;
      const token = searchNavigationTokenRef.current + 1;
      searchNavigationTokenRef.current = token;
      setSearchNavigating(true);
      let available = searchResults;
      try {
        if (!available[targetIndex] && hasNextSearchPage) {
          const next = await fetchNextSearchPage();
          available = next.data?.pages.flatMap((page) => page.results) ?? available;
        }
        if (
          token !== searchNavigationTokenRef.current ||
          !searchOpenRef.current ||
          searchQueryRef.current !== key ||
          !accountLease.isCurrent()
        ) {
          return;
        }
        const result = available[targetIndex];
        if (!result) return;
        setSearchIndex(targetIndex);
        setJump({ id: result.id, guid: result.guid });
      } catch {
        // TanStack exposes the page error through the hook; keep the current result in place.
      } finally {
        if (token === searchNavigationTokenRef.current && searchOpenRef.current) {
          setSearchNavigating(false);
        }
      }
    },
    [
      accountLease,
      fetchNextSearchPage,
      hasNextSearchPage,
      searchResults,
      searchTotalCount,
      searchNavigating,
      searchQuery,
    ],
  );
  const goToOlderSearchResult = useCallback((): void => {
    void moveToSearchResult(searchIndex + 1);
  }, [moveToSearchResult, searchIndex]);
  const goToNewerSearchResult = useCallback((): void => {
    void moveToSearchResult(searchIndex - 1);
  }, [moveToSearchResult, searchIndex]);
  const isTyping = useTypingStore((s) => !!s.typing[guid]);
  const [recording, setRecording] = useState(false);
  const [replyTo, setReplyTo] = useState<MessagePreview | null>(null);
  const [editing, setEditing] = useState<{
    guid: string;
    text: string;
    partIndex: 0;
  } | null>(null);
  const cancelReply = useCallback((): void => setReplyTo(null), []);
  const cancelEdit = useCallback((): void => setEditing(null), []);
  const replyTargetGuid = replyTo?.guid ?? null;
  const replyTargetRow = replyTargetGuid
    ? messages.find((message) => message.guid === replyTargetGuid)
    : undefined;
  const replyTargetProof = replyTargetRow
    ? JSON.stringify([
        replyTargetRow.guid,
        replyTargetRow.dateRetracted,
        replyTargetRow.retractionState,
        replyTargetRow.messagePartTopology,
      ])
    : null;
  useEffect(() => {
    if (imessageRepliesAvailable) return;
    // A live capability/header change revokes the composer target immediately.
    setReplyTo(null);
  }, [imessageRepliesAvailable]);
  useEffect(() => {
    if (!replyTargetGuid || !imessageRepliesAvailable) return;
    let alive = true;
    void runTrackedRealtimeWork(accountLease, async () => {
      const preview = await readMessagePreview(guid, replyTargetGuid, 0);
      if (!alive || !accountLease.isCurrent()) return;
      setReplyTo((current) => {
        if (current?.guid !== replyTargetGuid) return current;
        return preview ? { ...preview, targetPartIndex: 0 } : null;
      });
    }).catch((error) => {
      if (alive && accountLease.isCurrent()) {
        logger.warn('[chat] could not refresh exact reply target', error);
      }
    });
    return () => {
      alive = false;
    };
  }, [accountLease, guid, imessageRepliesAvailable, replyTargetGuid, replyTargetProof]);
  useEffect(() => {
    if (!editing) return;
    const current = messages.find((message) => message.guid === editing.guid);
    if (current && !isAggregateRetractionTombstone(current)) return;
    setEditing(null);
  }, [editing, messages]);
  useEffect(() => {
    if (attachmentFeaturesAvailable) return;
    setRecording(false);
  }, [attachmentFeaturesAvailable]);

  // Capture only the exact native claim carried by this route. Keep provenance so durable send
  // adoption copies from the native no-backup queue into the ordinary attachment cache.
  const [ownedShareIdentity] = useState<ShareIntakeManifestIdentity | null>(() => {
    const share = useShareIntentStore.getState();
    return typeof shareBatchId === 'string' &&
      share.batchId === shareBatchId &&
      share.createdAtMs != null
      ? {
          batchId: share.batchId,
          nativeCreatedAtMs: share.createdAtMs,
          hasText: share.text !== null,
          fileCount: share.files.length,
        }
      : null;
  });
  const ownedShareBatchId = ownedShareIdentity?.batchId ?? null;
  const [sharedAttachments] = useState<PendingAttachment[]>(() =>
    ownedShareBatchId
      ? useShareIntentStore.getState().files.map((file) => ({
          uri: file.uri,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          origin: file.origin,
          shareItemIndex: file.shareItemIndex,
        }))
      : [],
  );
  const [sharedText] = useState<string | null>(() =>
    ownedShareBatchId ? useShareIntentStore.getState().text : null,
  );
  const [shareBatchPending, setShareBatchPending] = useState(ownedShareBatchId !== null);
  const [remainingSharedAttachments, setRemainingSharedAttachments] = useState<PendingAttachment[]>(
    [],
  );
  const [shareReceiptLoaded, setShareReceiptLoaded] = useState(ownedShareBatchId === null);
  const [sharedTextReady, setSharedTextReady] = useState(sharedText === null);
  const [sharedTextAlreadyApplied, setSharedTextAlreadyApplied] = useState(false);
  const shareFinalizingRef = useRef(false);
  const screenEffect = useNewScreenEffect(guid, messages);
  const { firstUnread, setFirstUnread, screenFocused } = useChatReadLifecycle({
    guid,
    messagesData,
    accountLease,
  });
  const isDev = isDevServer;
  useChatScheduledCatchup(accountLease);

  // useCallback-stable: these feed the memoized Composer, so a reactive tick re-rendering the
  // screen doesn't re-render the composer through fresh closures.
  const onSchedule = useCallback(
    (text: string, scheduledFor: number, recurrence?: Recurrence | null): void => {
      void schedule(
        {
          chatGuid: guid,
          text,
          scheduledFor,
          recurrence,
        },
        accountLease,
      ).catch((error: unknown) => {
        if (!accountLease.isCurrent()) return;
        logger.warn('[chat] could not schedule message', error);
        showDialog('Scheduled', 'Couldn’t schedule that message.');
      });
    },
    [accountLease, guid],
  );

  const onScheduleAttachment = useCallback(
    async (text: string, item: PendingAttachment, scheduledFor: number): Promise<boolean> => {
      if (!imessageScheduledAttachmentsAvailable || !accountLease.isCurrent()) return false;
      try {
        await scheduleAttachment(
          { chatGuid: guid, text, scheduledFor, attachment: { ...item } },
          accountLease,
        );
        return accountLease.isCurrent();
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] file schedule could not be confirmed', error);
          showDialog(
            'Scheduled file',
            'Couldn’t confirm this schedule. Check Scheduled before trying again; your draft and file are still here.',
          );
        }
        return false;
      }
    },
    [accountLease, guid, imessageScheduledAttachmentsAvailable],
  );

  const onSend = useCallback(
    (text: string): Promise<boolean> => {
      const editTarget = editing;
      if (editTarget) {
        if (!imessageEditsAvailable || editTarget.partIndex !== 0) {
          showToast('Editing is unavailable right now. Your changes are still here');
          return Promise.resolve(false);
        }
        return editText(
          {
            chatGuid: guid,
            messageGuid: editTarget.guid,
            newText: text,
            partIndex: 0,
          },
          accountLease,
        )
          .then((result) => {
            if (!accountLease.isCurrent()) return false;
            if (result == null || result.status === 'rejected') {
              showDialog('Edit Not Sent', 'Your edited text is still here so you can try again.');
              return false;
            }
            setEditing((current) => (current?.guid === editTarget.guid ? null : current));
            if (result.status === 'outcome-unknown') {
              showDialog(
                'Edit Not Confirmed',
                'It may have been applied. Check the conversation before trying another edit.',
              );
            }
            return true;
          })
          .catch((error: unknown) => {
            if (accountLease.isCurrent()) {
              logger.warn('[chat] edit submission failed', error);
              showDialog('Edit Not Sent', 'Your edited text is still here so you can try again.');
            }
            return false;
          });
      }
      const target = replyTo;
      if (target) {
        if (!imessageRepliesAvailable || target.targetPartIndex !== 0) {
          return Promise.resolve(false);
        }
        return observeQueueAdmission(
          (onQueued) =>
            reply(
              {
                chatGuid: guid,
                text,
                replyToGuid: target.guid,
                replyToPartIndex: 0,
              },
              accountLease,
              presentSendIssue,
              onQueued,
            ).then((result) => {
              if (result == null && accountLease.isCurrent()) {
                throw new Error('The iMessage reply capability changed before queue admission.');
              }
              return result;
            }),
          () => {
            setReplyTo((current) => (current?.guid === target.guid ? null : current));
          },
          (error) => {
            if (!accountLease.isCurrent()) return;
            logger.warn('[chat] reply queue admission failed', error);
            showToast('Couldn’t queue that reply. Your draft is still here');
          },
        );
      }
      // DEV: when on the local dev session, simulate the server round-trip so the
      // optimistic → sent flow is visible without a real Gator server.
      return observeQueueAdmission(
        (onQueued) => {
          if (isDev()) {
            return devSendFake(guid, text, undefined, accountLease, onQueued);
          }
          return send({ chatGuid: guid, text }, accountLease, presentSendIssue, onQueued);
        },
        () => undefined,
        (error) => {
          if (!accountLease.isCurrent()) return;
          logger.warn('[chat] message queue admission failed', error);
          showToast(
            'Couldn’t queue that message. Your draft is still here—try again when connected',
          );
        },
      );
    },
    [accountLease, editing, guid, imessageEditsAvailable, imessageRepliesAvailable, isDev, replyTo],
  );

  const onSendEffect = useCallback(
    async (text: string, effectId: string): Promise<boolean> => {
      if (!imessageEffectsAvailable || !accountLease.isCurrent()) return false;
      try {
        const result = await sendEffect(
          { chatGuid: guid, text, effectId },
          accountLease,
          presentSendIssue,
        );
        if (!accountLease.isCurrent()) return false;
        if (result == null || result.status === 'rejected') {
          showDialog('Effect Not Sent', 'Your message is still here so you can try again.');
          return false;
        }
        if (result.status === 'outcome-unknown') {
          showDialog(
            'Effect Not Confirmed',
            'It may have been delivered. Check the conversation before sending another copy.',
          );
        }
        return true;
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] effect submission failed', error);
          showDialog('Effect Not Sent', 'Your message is still here so you can try again.');
        }
        return false;
      }
    },
    [accountLease, guid, imessageEffectsAvailable],
  );

  const onSendMention = useCallback(
    async (
      text: string,
      mentions: Array<{ start: number; length: number; address: string }>,
    ): Promise<boolean> => {
      if (
        !imessageMentionsAvailable ||
        mentionParticipants.length < 2 ||
        !accountLease.isCurrent()
      ) {
        return false;
      }
      try {
        const result = await sendMention(
          { chatGuid: guid, text, mentions },
          accountLease,
          presentSendIssue,
        );
        if (!accountLease.isCurrent()) return false;
        if (result == null || result.status === 'rejected') {
          showDialog('Mention Not Sent', 'Your message is still here so you can try again.');
          return false;
        }
        if (result.status === 'outcome-unknown') {
          showDialog(
            'Mention Not Confirmed',
            'It may have been delivered. Check the conversation before sending another copy.',
          );
        }
        return true;
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] mention submission failed', error);
          showDialog('Mention Not Sent', 'Your message is still here so you can try again.');
        }
        return false;
      }
    },
    [accountLease, guid, imessageMentionsAvailable, mentionParticipants.length],
  );

  const onSendFormatted = useCallback(
    async (text: string, textFormatting: IMessageTextFormattingRange[]): Promise<boolean> => {
      if (!imessageFormattedAvailable || !accountLease.isCurrent()) return false;
      try {
        const result = await sendFormatted(
          { chatGuid: guid, text, textFormatting },
          accountLease,
          presentSendIssue,
        );
        if (!accountLease.isCurrent()) return false;
        if (result == null || result.status === 'rejected') {
          showDialog(
            'Formatted Message Not Sent',
            'Your message is still here so you can try again.',
          );
          return false;
        }
        if (result.status === 'outcome-unknown') {
          showDialog(
            'Formatted Message Not Confirmed',
            'It may have been delivered. Check the conversation before sending another copy.',
          );
        }
        return true;
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] formatted-message submission failed', error);
          showDialog(
            'Formatted Message Not Sent',
            'Your message is still here so you can try again.',
          );
        }
        return false;
      }
    },
    [accountLease, guid, imessageFormattedAvailable],
  );

  // Long-press and multi-select handlers. Stable callbacks feed the memoized list/row chain.
  const {
    selected,
    setSelected,
    selectedGuids,
    setSelectedGuids,
    threadFor,
    setThreadFor,
    editHistory,
    setEditHistory,
    onViewEditHistorySelected,
    details,
    setDetails,
    onDetailsSelected,
    onLongPressMessage,
    onSwipeReply,
    onReplyToSelected,
    onEditSelected,
    onUnsendSelected,
    onRemoteDeleteSelected,
    onToggleSelect,
    onEnterSelect,
    onBulkCopy,
    onBulkDelete,
    onViewThreadSelected,
    onCancelSelected,
    onReact,
    onCopySelected,
    onShareSelected,
    onDeleteSelected,
    onForwardSelected,
    onSaveSelected,
    onRemindLater,
  } = useMessageActions({
    guid,
    messages,
    chatTitle: header.data ? resolveTitle(header.data) : 'Gator',
    accountLease,
    imessageReactionsAvailable,
    imessageRepliesAvailable,
    imessageEditsAvailable,
    imessageUnsendsAvailable,
    imessageRemoteDeleteAvailable,
    setReplyTo,
    setEditing,
  });
  const actionSelected = useMemo(() => {
    if (!selected) return null;
    return {
      ...selected,
      canReact:
        selected.canReact === true &&
        (rcsInteractiveFeaturesAvailable || imessageReactionsAvailable),
      replyPartIndex:
        imessageRepliesAvailable && selected.replyPartIndex === 0 ? (0 as const) : undefined,
      editPartIndex:
        imessageEditsAvailable && selected.editPartIndex === 0 ? (0 as const) : undefined,
      unsendPartIndex:
        imessageUnsendsAvailable && selected.unsendPartIndex === 0 ? (0 as const) : undefined,
      canRemoteDeleteFromMac:
        imessageRemoteDeleteAvailable && selected.canRemoteDeleteFromMac === true,
    };
  }, [
    imessageReactionsAvailable,
    imessageRepliesAvailable,
    imessageRemoteDeleteAvailable,
    imessageEditsAvailable,
    imessageUnsendsAvailable,
    rcsInteractiveFeaturesAvailable,
    selected,
  ]);

  const toggleSearch = useCallback((): void => {
    if (searchOpenRef.current) {
      closeSearch();
      return;
    }
    // Search and message actions are separate modes. Dismiss action/select UI before focusing the
    // search field, while leaving composer draft/attachment/edit state mounted and intact below.
    setSelected(null);
    setSelectedGuids(null);
    setSearchOpen(true);
  }, [closeSearch, setSelected, setSelectedGuids]);

  // Per-chat draft: restore on open, persist (debounced in the Composer) via kv `draft.<guid>`.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void runTrackedRealtimeWork(accountLease, async () => {
      const value = await kvGet(getDatabase(), `${DRAFT_KV_PREFIX}${guid}`);
      if (alive && accountLease.isCurrent()) setDraft(value ?? '');
    }).catch(() => {
      if (alive && accountLease.isCurrent()) setDraft('');
    });
    return () => {
      alive = false;
    };
  }, [accountLease, guid]);
  const onDraftChange = useCallback(
    (text: string): void => {
      // Composer flushes once while unmounting. If Disconnect caused that unmount, its old closure
      // must not recreate the just-wiped A draft in B's fresh database.
      if (!accountLease.isCurrent()) return;
      // Keep the local `draft` state in lockstep with kv. Entering multi-select UNMOUNTS the
      // Composer (bottomStack swaps to the selection bar); on exit it REMOUNTS and restores from
      // `initialText={draft}`. Without this setDraft, `draft` stays frozen at the chat-open value
      // and the remounted Composer comes up stale/empty — then its own unmount flush writes '' back
      // over the real kv draft. The Composer's unmount flush calls this before it unmounts, so
      // `draft` is fresh by the time it remounts.
      setDraft(text);
      void saveChatDraft(guid, text, accountLease).catch(() => {
        // Best-effort while this account is live — losing a draft persist is not worth surfacing.
      });
    },
    [accountLease, guid],
  );
  const composerInitialText = useMemo(
    () => (draft === null || !sharedTextReady ? undefined : draft || undefined),
    [draft, sharedTextReady],
  );

  const finalizeShareIfReady = useCallback((): void => {
    if (!ownedShareBatchId || !shareBatchPending || !accountLease.isCurrent()) return;
    if (!ownedShareIdentity || shareFinalizingRef.current) return;
    shareFinalizingRef.current = true;
    let completed = false;
    void runTrackedRealtimeWork(accountLease, async () => {
      const receipt = await readShareIntakeReceipt(ownedShareIdentity);
      if (!receipt || !isShareIntakeReceiptComplete(receipt)) return;
      completed = await consumeShareIntakeBatch(ownedShareBatchId, {
        lease: accountLease,
        drainNext: false,
      });
    })
      .then((outcome) => {
        if (outcome === 'delivered' && completed && accountLease.isCurrent()) {
          setShareBatchPending(false);
          void drainShareIntake();
        } else {
          shareFinalizingRef.current = false;
        }
      })
      .catch((error: unknown) => {
        shareFinalizingRef.current = false;
        if (!accountLease.isCurrent()) return;
        logger.warn('[chat] shared batch completion failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        showToast('Gator could not finish the share handoff. Your draft is still here.');
      });
  }, [accountLease, ownedShareBatchId, ownedShareIdentity, shareBatchPending]);

  const onShareAdmissionApplied = useCallback(
    (_result: ComposerAdmissionResult): void => {
      if (!ownedShareBatchId || !shareBatchPending || !accountLease.isCurrent()) return;
      finalizeShareIfReady();
    },
    [accountLease, finalizeShareIfReady, ownedShareBatchId, shareBatchPending],
  );

  const onRemoveSharedAttachment = useCallback(
    async (item: PendingAttachment): Promise<boolean> => {
      if (item.origin !== 'share') return true;
      if (!ownedShareIdentity || item.shareItemIndex == null || !accountLease.isCurrent()) {
        return false;
      }
      try {
        const outcome = await runTrackedRealtimeWork(accountLease, async () =>
          discardShareIntakeItem(
            {
              identity: ownedShareIdentity,
              chatGuid: guid,
              itemIndex: item.shareItemIndex!,
              appliedAtMs: Date.now(),
            },
            () => accountLease.isCurrent(),
          ),
        );
        if (outcome !== 'delivered' || !accountLease.isCurrent()) return false;
        finalizeShareIfReady();
        return true;
      } catch (error) {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] shared attachment discard failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          showToast('Gator could not safely remove that shared file. Try again.');
        }
        return false;
      }
    },
    [accountLease, finalizeShareIfReady, guid, ownedShareIdentity],
  );

  // Load the durable receipt before exposing native files. A replay filters already-admitted file
  // ordinals and forces any partially handled batch back to its original destination.
  useEffect(() => {
    if (!ownedShareIdentity || !accountLease.isCurrent()) return;
    let alive = true;
    let loadedReceipt: Awaited<ReturnType<typeof readShareIntakeReceipt>> = null;
    void runTrackedRealtimeWork(accountLease, async () => {
      loadedReceipt = await readShareIntakeReceipt(ownedShareIdentity);
    })
      .then((outcome) => {
        if (outcome === 'paused' || !alive || !accountLease.isCurrent()) return;
        const receipt = loadedReceipt;
        if (receipt?.destination && receipt.destination.chatGuid !== guid) {
          router.replace(
            `/chat/${encodeURIComponent(receipt.destination.chatGuid)}?shareBatch=${encodeURIComponent(ownedShareIdentity.batchId)}`,
          );
          return;
        }
        if (receipt?.newChatPlan && !receipt.destination) {
          router.replace(`/new-chat?shareBatch=${encodeURIComponent(ownedShareIdentity.batchId)}`);
          return;
        }
        setRemainingSharedAttachments(
          sharedAttachments.filter(
            (file) =>
              file.shareItemIndex == null ||
              !isShareIntakeFileSettled(receipt, file.shareItemIndex),
          ),
        );
        if (sharedText && receipt?.items.text) {
          setSharedTextAlreadyApplied(true);
          setSharedTextReady(true);
        }
        setShareReceiptLoaded(true);
        if (receipt && isShareIntakeReceiptComplete(receipt)) finalizeShareIfReady();
      })
      .catch((error: unknown) => {
        if (!alive || !accountLease.isCurrent()) return;
        logger.warn('[chat] shared receipt reconciliation failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        showToast('Gator could not safely resume this share. Its files were not sent.');
      });
    return () => {
      alive = false;
    };
  }, [
    accountLease,
    finalizeShareIfReady,
    guid,
    ownedShareIdentity,
    router,
    sharedAttachments,
    sharedText,
  ]);

  // Text becomes removable from native storage only when its exact draft merge and replay receipt
  // commit together in the encrypted database.
  const sharedTextPersistStartedRef = useRef(false);
  useEffect(() => {
    if (
      !ownedShareBatchId ||
      !ownedShareIdentity ||
      !sharedText ||
      draft === null ||
      !shareReceiptLoaded ||
      sharedTextAlreadyApplied ||
      sharedTextPersistStartedRef.current ||
      !accountLease.isCurrent()
    ) {
      return;
    }
    sharedTextPersistStartedRef.current = true;
    let admittedDraft: string | null = null;
    void runTrackedRealtimeWork(accountLease, async () => {
      const result = await admitShareIntakeTextDraft(
        {
          identity: ownedShareIdentity,
          chatGuid: guid,
          sharedText,
          draftKey: `${DRAFT_KV_PREFIX}${guid}`,
          appliedAtMs: Date.now(),
        },
        () => accountLease.isCurrent(),
      );
      admittedDraft = result.draft;
    })
      .then((outcome) => {
        if (outcome !== 'delivered' || admittedDraft === null || !accountLease.isCurrent()) return;
        setDraft(admittedDraft);
        setSharedTextReady(true);
        finalizeShareIfReady();
      })
      .catch((error: unknown) => {
        sharedTextPersistStartedRef.current = false;
        if (accountLease.isCurrent()) {
          logger.warn('[chat] shared text draft persist failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      });
  }, [
    accountLease,
    draft,
    finalizeShareIfReady,
    guid,
    ownedShareBatchId,
    ownedShareIdentity,
    shareReceiptLoaded,
    sharedText,
    sharedTextAlreadyApplied,
  ]);

  useEffect(() => {
    if (
      !ownedShareBatchId ||
      remainingSharedAttachments.length === 0 ||
      attachmentFeaturesAvailable
    )
      return;
    showToast('This conversation cannot accept the shared files. Choose another conversation.');
  }, [attachmentFeaturesAvailable, ownedShareBatchId, remainingSharedAttachments.length]);

  const [composerRemovalState, setComposerRemovalState] = useState<ComposerRemovalState>({
    hasUnsavedDraftMetadata: false,
  });
  const backConfirmationPendingRef = useRef(false);
  const shouldHandleBack =
    searchOpen ||
    selectedGuids != null ||
    replyTo != null ||
    editing != null ||
    composerRemovalState.hasOpenAttachmentTray === true ||
    composerRemovalState.hasUnsavedEdit === true ||
    composerRemovalState.hasUnsavedDraftMetadata ||
    shareBatchPending;

  // Android/Header Back peels the active chat layer before removing the route. Ordinary body text
  // is not included: Composer already flushes it to the per-chat DB draft on route removal.
  usePreventRemove(shouldHandleBack, ({ data }) => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    if (selectedGuids != null) {
      setSelectedGuids(null);
      return;
    }
    if (composerRemovalState.hasOpenAttachmentTray) {
      composerRemovalState.dismissAttachmentTray?.();
      return;
    }
    if (replyTo) {
      setReplyTo(null);
      return;
    }
    if (editing) {
      if (!composerRemovalState.hasUnsavedEdit || backConfirmationPendingRef.current) {
        if (!composerRemovalState.hasUnsavedEdit) setEditing(null);
        return;
      }
      backConfirmationPendingRef.current = true;
      showConfirm({
        title: 'Discard this edit?',
        message: 'Your edited text has not been sent.',
        confirmText: 'Discard Edit',
        destructive: true,
        onCancel: () => {
          backConfirmationPendingRef.current = false;
        },
        onConfirm: () => {
          backConfirmationPendingRef.current = false;
          setEditing(null);
        },
      });
      return;
    }
    if (
      (!composerRemovalState.hasUnsavedDraftMetadata && !shareBatchPending) ||
      backConfirmationPendingRef.current
    )
      return;
    backConfirmationPendingRef.current = true;
    const discardsMentions = composerRemovalState.hasUnsavedMentionMetadata === true;
    const discardsFormatting = composerRemovalState.hasUnsavedFormattingMetadata === true;
    const discardsMessageDetails = discardsMentions || discardsFormatting;
    showConfirm({
      title: shareBatchPending
        ? 'Discard shared item?'
        : discardsMessageDetails
          ? 'Discard message details?'
          : 'Discard message attachments?',
      message: shareBatchPending
        ? 'The shared text and files that have not been saved or sent will be removed.'
        : discardsMentions && discardsFormatting
          ? 'Mention identities and text formatting are not part of the saved plain-text draft.'
          : discardsMentions
            ? 'Mention identities are not part of the saved plain-text draft.'
            : discardsFormatting
              ? 'Text formatting is not part of the saved plain-text draft.'
              : 'Attachments are not part of the saved text draft.',
      confirmText: 'Discard',
      destructive: true,
      onCancel: () => {
        backConfirmationPendingRef.current = false;
      },
      onConfirm: () => {
        if (!ownedShareBatchId || !shareBatchPending) {
          backConfirmationPendingRef.current = false;
          navigation.dispatch(data.action);
          return;
        }
        void discardShareIntakeBatch(ownedShareBatchId, {
          lease: accountLease,
          drainNext: false,
        })
          .then((discarded) => {
            backConfirmationPendingRef.current = false;
            if (!discarded || !accountLease.isCurrent()) return;
            setShareBatchPending(false);
            navigation.dispatch(data.action);
            void drainShareIntake();
          })
          .catch((error: unknown) => {
            backConfirmationPendingRef.current = false;
            if (!accountLease.isCurrent()) return;
            logger.warn('[chat] shared batch discard failed', {
              errorName: error instanceof Error ? error.name : 'UnknownError',
            });
            showToast('Gator could not discard the shared item. Try again.');
          });
      },
    });
  });

  // The inline tray's "Files" button — pick documents and return them to STAGE as pending
  // previews (the tray handles photos/videos itself; this covers PDFs/other files). No popup
  // beyond the OS document picker itself.
  const pickFiles = useCallback(
    (): Promise<PendingAttachment[]> =>
      attachmentFeaturesAvailable
        ? pickDocumentFilesForLease(
            accountLease,
            undefined,
            imessageAttachmentFeaturesAvailable,
            imessagePdfFeaturesAvailable,
          )
        : Promise.resolve([]),
    [
      accountLease,
      attachmentFeaturesAvailable,
      imessageAttachmentFeaturesAvailable,
      imessagePdfFeaturesAvailable,
    ],
  );

  // The rest of the Composer's callback props, useCallback-stable for the same memo reason.
  const onSendAttachments = useCallback(
    (items: PendingAttachment[]): Promise<readonly string[]> => {
      if (!attachmentFeaturesAvailable) return Promise.resolve([]);
      if (imessageAttachmentFeaturesAvailable) {
        if (
          items.length !== 1 ||
          !isSupportedImessageAttachmentFile(items[0]!) ||
          (items[0]!.mimeType === 'application/pdf' && !imessagePdfFeaturesAvailable)
        ) {
          showToast(
            imessagePdfFeaturesAvailable
              ? 'Choose one JPEG, PNG, or PDF file no larger than 10 MiB'
              : 'Choose one JPEG or PNG image no larger than 10 MiB',
          );
          return Promise.resolve([]);
        }
      }
      const expectedUris = new Set(items.map((item) => item.uri));
      const decidedUris = new Set<string>();
      const queuedUris = new Set<string>();
      let reportedFailure = false;

      return new Promise((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve([...queuedUris]);
        };
        const onAdmission = (admission: AttachmentQueueAdmission): void => {
          if (!accountLease.isCurrent()) return;
          if (!expectedUris.has(admission.uri) || decidedUris.has(admission.uri)) return;
          decidedUris.add(admission.uri);
          if (admission.queued) queuedUris.add(admission.uri);
          else if (!reportedFailure && accountLease.isCurrent()) {
            reportedFailure = true;
            showToast(
              'Couldn’t queue one or more attachments. They’re still in your composer—try again when connected',
            );
          }
          if (decidedUris.size === expectedUris.size) finish();
        };

        let operation: Promise<unknown>;
        try {
          operation = Promise.resolve(
            sendImages(
              {
                chatGuid: guid,
                images: items,
                shareIntake: ownedShareIdentity ?? undefined,
                ...(imessageAttachmentFeaturesAvailable ? { service: 'iMessage' as const } : {}),
              },
              accountLease,
              presentSendIssue,
              onAdmission,
            ),
          );
        } catch (error) {
          if (accountLease.isCurrent()) {
            logger.warn('[chat] attachment queue admission failed', error);
            showToast(
              'Couldn’t queue those attachments. They’re still in your composer—try again when connected',
            );
          }
          finish();
          return;
        }

        void operation.then(
          () => finish(),
          (error: unknown) => {
            if (!settled && accountLease.isCurrent()) {
              logger.warn('[chat] attachment queue admission failed', error);
              if (!reportedFailure) {
                showToast(
                  'Couldn’t queue one or more attachments. They’re still in your composer—try again when connected',
                );
              }
            }
            finish();
          },
        );
      });
    },
    [
      accountLease,
      attachmentFeaturesAvailable,
      guid,
      imessageAttachmentFeaturesAvailable,
      imessagePdfFeaturesAvailable,
      ownedShareIdentity,
    ],
  );
  const onSendTextAttachment = useCallback(
    (text: string, item: PendingAttachment): Promise<boolean> | false => {
      if (!attachmentFeaturesAvailable) return false;
      if (chatService === 'iMessage') {
        if (!imessageCaptionFeaturesAvailable) return false;
        if (
          !isSupportedImessageAttachmentFile(item) ||
          (item.mimeType === 'application/pdf' && !imessagePdfFeaturesAvailable)
        ) {
          showToast(
            imessagePdfFeaturesAvailable
              ? 'Choose one JPEG, PNG, or PDF file no larger than 10 MiB'
              : 'Choose one JPEG or PNG image no larger than 10 MiB',
          );
          return false;
        }
      } else if (chatService !== 'RCS') {
        return false;
      }
      return observeQueueAdmission(
        (onQueued) =>
          sendTextAttachment(
            {
              chatGuid: guid,
              image: item,
              text,
              service: chatService,
              shareIntake: item.origin === 'share' ? (ownedShareIdentity ?? undefined) : undefined,
            },
            accountLease,
            presentSendIssue,
            onQueued,
          ),
        () => undefined,
        (error) => {
          if (!accountLease.isCurrent()) return;
          logger.warn('[chat] text-attachment queue admission failed', error);
          showToast(
            'Couldn’t queue that text and attachment. They’re still in your composer—try again',
          );
        },
      );
    },
    [
      accountLease,
      attachmentFeaturesAvailable,
      chatService,
      guid,
      imessageCaptionFeaturesAvailable,
      imessagePdfFeaturesAvailable,
      ownedShareIdentity,
    ],
  );
  const onTyping = useCallback(
    (active: boolean): void => {
      // Composer debounce/unmount callbacks can run after Disconnect. The socket emit itself is
      // synchronous, so a lease check is the complete atomic boundary here.
      if (accountLease.isCurrent() && typingFeaturesAvailable) {
        void sendTyping(guid, active);
      }
    },
    [accountLease, guid, typingFeaturesAvailable],
  );
  const onStartVoice = useCallback((): void => {
    if (voiceFeaturesAvailable) setRecording(true);
  }, [voiceFeaturesAvailable]);
  const onSendVoice = useCallback(
    async (uri: string): Promise<boolean> => {
      if (!accountLease.isCurrent() || !voiceFeaturesAvailable) return false;
      if (imessageVoiceAvailable) {
        if (!uri.startsWith('file://') || !/\.m4a$/i.test(uri)) return false;
        try {
          const FileSystem = await import('expo-file-system/legacy');
          if (!accountLease.isCurrent()) return false;
          const info = await FileSystem.getInfoAsync(uri);
          if (
            !accountLease.isCurrent() ||
            !info.exists ||
            !Number.isSafeInteger(info.size) ||
            info.size <= 0 ||
            info.size > MAX_IMESSAGE_VOICE_UPLOAD_BYTES
          ) {
            return false;
          }
          return observeQueueAdmission(
            (onQueued) =>
              sendVoice(
                {
                  chatGuid: guid,
                  audio: {
                    uri,
                    name: uri.split('/').pop() ?? 'voice.m4a',
                    mimeType: 'audio/mp4',
                    size: info.size,
                  },
                },
                accountLease,
                presentSendIssue,
                onQueued,
              ),
            () => undefined,
            (error) => {
              if (!accountLease.isCurrent()) return;
              logger.warn('[chat] voice note queue admission failed', error);
              showToast('Couldn’t queue that recording. It’s still here—try again when connected');
            },
          );
        } catch (error) {
          if (accountLease.isCurrent()) logger.warn('[chat] voice note file check failed', error);
          return false;
        }
      }
      return observeQueueAdmission(
        (onQueued) =>
          sendImage(
            {
              chatGuid: guid,
              image: {
                uri,
                name: uri.split('/').pop() ?? 'voice.m4a',
                mimeType: 'audio/mp4',
                size: 0,
              },
            },
            accountLease,
            presentSendIssue,
            onQueued,
          ),
        () => undefined,
        (error) => {
          if (!accountLease.isCurrent()) return;
          logger.warn('[chat] voice message queue admission failed', error);
          showToast('Couldn’t queue that recording. It’s still here—try again when connected');
        },
      );
    },
    [accountLease, voiceFeaturesAvailable, imessageVoiceAvailable, guid],
  );

  const imessageContactAvailable =
    imessageContactSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const contactCardAvailable = rcsInteractiveFeaturesAvailable || imessageContactAvailable;
  const runContactPicker = useCallback((): void => {
    if (!contactCardAvailable) return;
    const attempt = (): void => {
      void observeQueueAdmission(
        (onQueued) => pickAndSendContact(guid, accountLease, presentSendIssue, undefined, onQueued),
        () => undefined,
        (e) => {
          if (!accountLease.isCurrent()) return;
          if (isContactsPermissionDeniedError(e)) {
            showContactsPermissionRecovery({
              canAskAgain: e.canAskAgain,
              isCurrent: () => accountLease.isCurrent(),
              onTryAgain: attempt,
            });
            return;
          }
          logger.warn('[chat] contact pick/send failed', e);
        },
      );
    };
    attempt();
  }, [accountLease, contactCardAvailable, guid]);
  const onPickContact = useCallback((): void => {
    void getContactsPermissionState()
      .then((permission) => {
        if (!accountLease.isCurrent()) return;
        if (permission.status === 'granted') {
          runContactPicker();
          return;
        }
        if (permission.status === 'denied' && !permission.canAskAgain) {
          showContactsPermissionRecovery({
            canAskAgain: false,
            isCurrent: () => accountLease.isCurrent(),
            onTryAgain: runContactPicker,
          });
          return;
        }
        showContactsPermissionRationale({
          purpose: 'share',
          isCurrent: () => accountLease.isCurrent(),
          onContinue: runContactPicker,
        });
      })
      .catch((error) => {
        if (accountLease.isCurrent()) {
          logger.warn('[chat] contact permission check failed', error);
          showDialog(
            'Contacts',
            'Contacts access is unavailable. You can keep messaging without sharing a contact card.',
          );
        }
      });
  }, [accountLease, runContactPicker]);

  const currentLocationAvailable =
    imessageLocationSupported &&
    chatService === 'iMessage' &&
    header.data?.guid === guid &&
    isProvenOneToOneIMessageChat(header.data);
  const locationSendInFlightRef = useRef(false);
  const runCurrentLocationSend = useCallback(
    function runCurrentLocationSend(): void {
      if (
        locationSendInFlightRef.current ||
        !currentLocationAvailable ||
        !accountLease.isCurrent()
      ) {
        return;
      }
      locationSendInFlightRef.current = true;
      void acquireAndSendCurrentLocation(guid, {
        foregroundLifecycle: {
          isActive: () => AppState.currentState === 'active',
          subscribeToInactive: (cancel) => {
            const subscription = AppState.addEventListener('change', (state) => {
              if (state !== 'active') cancel();
            });
            return () => subscription.remove();
          },
        },
        accountLease,
        reportIssue: presentSendIssue,
      })
        .then((result) => {
          if (!accountLease.isCurrent()) return;
          if (result.status === 'queued' || result.status === 'cancelled') return;
          if (result.status === 'unavailable') {
            showDialog(
              'Location Sharing Unavailable',
              'The connected server no longer offers current-location sharing.',
            );
            return;
          }
          if (result.status === 'services-off') {
            showDialog('Location Services Are Off', 'Turn on location services, then try again.', [
              { text: 'Not Now', style: 'cancel' },
              { text: 'Open Settings', onPress: () => void Linking.openSettings() },
            ]);
            return;
          }
          if (result.status === 'denied') {
            showDialog(
              'Location Permission Needed',
              'Gator needs foreground location access to send your current location. No location is read in the background.',
              result.canAskAgain
                ? [
                    { text: 'Not Now', style: 'cancel' },
                    { text: 'Try Again', onPress: runCurrentLocationSend },
                  ]
                : [
                    { text: 'Not Now', style: 'cancel' },
                    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
                  ],
            );
            return;
          }
          showDialog(
            'Couldn’t Get Location',
            result.status === 'timeout'
              ? 'Gator did not get a current location within 15 seconds. Nothing was sent.'
              : 'Gator could not read a current location. Nothing was sent.',
          );
        })
        .catch((error) => {
          if (!accountLease.isCurrent()) return;
          logger.warn('[chat] current-location send failed', error);
          showDialog('Couldn’t Send Location', 'Your location was not queued. Please try again.');
        })
        .finally(() => {
          locationSendInFlightRef.current = false;
        });
    },
    [accountLease, currentLocationAvailable, guid],
  );
  const onShareCurrentLocation = useCallback((): void => {
    if (!currentLocationAvailable || locationSendInFlightRef.current) return;
    showConfirm({
      title: 'Send Current Location?',
      message:
        'Gator will request one current location and send it to this conversation through your server. It does not track your location in the background.',
      confirmText: 'Send Location',
      onConfirm: runCurrentLocationSend,
    });
  }, [currentLocationAvailable, runCurrentLocationSend]);

  // Only let the KeyboardAvoidingView pad WHILE the keyboard is up, so it can't leave a residual
  // gap under the composer after a show/hide cycle (Android edge-to-edge). Same fix as the inbox.
  // Also collapses the SELECTION bar's nav-bar reservation while the keyboard is up, for the same
  // union-not-sum reason as the Composer's (see Composer.tsx's paddingBottom).
  const kbVisible = useKeyboardVisible();

  // Wallpaper mode: the header/composer float transparent over the image and the list runs UNDER
  // them, with BAR_GAP-padded content insets so resting messages clear the bars (scrolled-past
  // messages show through behind the transparent bars). Bar heights are measured (onLayout) since
  // both vary (insets, reply bar, typing bubble) — and the wrappers are measured in BOTH
  // modes, so real heights already exist by the time the (async, reactive) wallpaper flag flips
  // the styles. The estimates only cover the very first frames of a cold mount.
  const hasWallpaper = !!visibleBackgroundUri;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [headerH, setHeaderH] = useState(0);
  const [bottomBarH, setBottomBarH] = useState(0);
  // 94, not 74: the header gained a second line (the contact's number under their name), which
  // adds ~20dp for a 1:1 chat. Only governs the frames before onLayout lands on a cold mount.
  const topBar = headerH > 0 ? headerH : insets.top + 94;
  const bottomBar = searchOpen ? 0 : bottomBarH > 0 ? bottomBarH : insets.bottom + 54;

  const trimmedSearchText = searchText.trim();
  const searchWaiting =
    trimmedSearchText.length >= 3 &&
    (trimmedSearchText !== searchQuery || (chatSearch.isPending && !chatSearch.data));
  const searchLoading = searchWaiting || searchNavigating || chatSearch.isFetchingNextPage;
  // A failed older-results page must not discard results that are already on screen. Keep newer
  // navigation available and let the older button retry; show the error only when nothing loaded.
  const initialSearchFailed = chatSearch.isError && chatSearch.results.length === 0;
  const searchStatus =
    trimmedSearchText.length < 3
      ? 'Type at least 3 characters'
      : searchWaiting
        ? 'Searching…'
        : initialSearchFailed
          ? 'Couldn’t search messages'
          : chatSearch.totalCount === 0
            ? 'No results'
            : `Result ${Math.max(chatSearch.totalCount - searchIndex, 1)} of ${chatSearch.totalCount}`;
  const canGoOlder =
    !searchLoading && !initialSearchFailed && searchIndex + 1 < chatSearch.totalCount;
  const canGoNewer = !searchLoading && !initialSearchFailed && searchIndex > 0;

  const headerNode = (
    <ConversationHeader
      chatGuid={guid}
      data={header.data}
      translucent={hasWallpaper}
      onSearchPress={toggleSearch}
      searchActive={searchOpen}
    />
  );
  const searchNode = searchOpen ? (
    <ChatSearchBar
      value={searchText}
      onChangeText={onSearchTextChange}
      status={searchStatus}
      loading={searchLoading}
      canGoOlder={canGoOlder}
      canGoNewer={canGoNewer}
      onGoOlder={goToOlderSearchResult}
      onGoNewer={goToNewerSearchResult}
      translucent={hasWallpaper}
    />
  ) : null;
  const errorNode = messagesError ? (
    <Text style={styles.errorBanner}>Couldn’t load messages. Pull to refresh or reopen.</Text>
  ) : null;
  // "N unread — jump to first" chip under the header; tap anchors the list on the oldest unread.
  const unreadChipNode =
    !searchOpen && firstUnread && !jump ? (
      <Pressable
        onPress={() => {
          setJump({ guid: firstUnread.guid });
          setFirstUnread(null);
        }}
        style={[styles.unreadChip, { backgroundColor: theme.color.tint }]}
        accessibilityRole="button"
        accessibilityLabel={`Jump to the first of ${firstUnread.count} unread messages`}
      >
        <Text style={[styles.unreadChipText, { color: readableTextOn(theme.color.tint) }]}>
          ↑ {firstUnread.count} unread — jump to first
        </Text>
      </Pressable>
    ) : null;
  const listNode = messagesLoading ? (
    <View style={[styles.flex, styles.listLoading]}>
      <ActivityIndicator color={theme.color.tint} />
    </View>
  ) : (
    <MessageList
      chatGuid={guid}
      isGroup={isGroup}
      messages={messages}
      accentColor={header.data?.customColor}
      chatService={chatService}
      hasBackground={hasWallpaper}
      topInset={hasWallpaper ? topBar + BAR_GAP : 0}
      bottomInset={hasWallpaper ? bottomBar + BAR_GAP : 0}
      onLongPressMessage={searchOpen ? undefined : onLongPressMessage}
      onSwipeReply={
        !searchOpen && imessageRepliesAvailable && selectedGuids == null ? onSwipeReply : undefined
      }
      onRefresh={() => backfillChatUnlessDeleted(guid, accountLease)}
      onLoadOlder={onLoadOlder}
      focusGuid={effFocusGuid}
      focusMessageId={jump?.id}
      selectedGuids={searchOpen ? null : selectedGuids}
      onToggleSelect={searchOpen ? undefined : onToggleSelect}
      onExitAnchor={anchor != null ? exitSearchAnchor : undefined}
      accountLease={accountLease}
    />
  );
  // Multi-select visually replaces the composer with a selection action bar. Keep Composer
  // MOUNTED (display:none below) so unmount/remount cannot destroy staged attachments.
  const selectionBar = selectedGuids ? (
    // Add the bottom safe-area inset (like the Composer this bar replaces) so Copy/Delete/Done
    // clear the Android system nav bar under edge-to-edge instead of hiding behind it.
    <View
      style={[
        styles.selectBar,
        {
          borderTopColor: theme.color.separator,
          paddingBottom: (kbVisible ? 0 : insets.bottom) + 14,
        },
      ]}
    >
      <Text style={[styles.selectCount, { color: theme.color.label }]}>
        {selectedGuids.size} selected
      </Text>
      <View style={styles.selectActions}>
        <Pressable onPress={onBulkCopy} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.selectAction, { color: theme.color.tint }]}>Copy</Text>
        </Pressable>
        <Pressable onPress={onBulkDelete} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.selectAction, { color: theme.color.destructive }]}>Delete</Text>
        </Pressable>
        <Pressable onPress={() => setSelectedGuids(null)} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.selectAction, { color: theme.color.tint }]}>Done</Text>
        </Pressable>
      </View>
    </View>
  ) : null;

  const composerHidden = selectedGuids != null || searchOpen || returningToNewest;
  const shareComposerReady = ownedShareBatchId === null || (shareReceiptLoaded && sharedTextReady);
  const composerStack = (
    <View
      style={composerHidden ? styles.hiddenComposer : null}
      pointerEvents={composerHidden ? 'none' : 'auto'}
      accessibilityElementsHidden={composerHidden}
      importantForAccessibility={composerHidden ? 'no-hide-descendants' : 'auto'}
    >
      {isTyping && typingFeaturesAvailable ? <TypingBubble /> : null}
      {/* Renders nothing unless this chat has an upload in flight. It lives INSIDE the measured
          bottom bar, so appearing/disappearing re-lands the message list through the wrapper's
          existing onLayout → pin convergence rather than stranding it behind the composer. */}
      <UploadStatusBar chatGuid={guid} translucent={hasWallpaper} />
      {shareComposerReady ? (
        <Composer
          placeholder={
            chatService === 'RCS'
              ? 'RCS Message'
              : chatService === 'SMS'
                ? 'Text Message'
                : 'iMessage'
          }
          onSend={onSend}
          onSendEffect={!replyTo && !editing && imessageEffectsAvailable ? onSendEffect : undefined}
          onSendMention={
            !replyTo && !editing && imessageMentionsAvailable && mentionParticipants.length >= 2
              ? onSendMention
              : undefined
          }
          onSendFormatted={
            !replyTo && !editing && imessageFormattedAvailable ? onSendFormatted : undefined
          }
          mentionParticipants={mentionParticipants}
          {...(replyTo ? { replyTo, onCancelReply: cancelReply } : {})}
          {...(editing ? { editingText: editing.text, onCancelEdit: cancelEdit } : {})}
          onSendAttachments={
            !replyTo && !editing && attachmentFeaturesAvailable ? onSendAttachments : undefined
          }
          onSendTextAttachment={
            !replyTo && !editing && attachmentFeaturesAvailable && supportsSendAttachmentText
              ? onSendTextAttachment
              : undefined
          }
          canSubmit={hasLogicalSendCapacity}
          isSubmitOwnerCurrent={accountLease.isCurrent}
          onPickFiles={!replyTo && !editing && attachmentFeaturesAvailable ? pickFiles : undefined}
          onRemoveAttachment={ownedShareBatchId ? onRemoveSharedAttachment : undefined}
          imessageImageOnly={imessageAttachmentFeaturesAvailable}
          onPickContact={!replyTo && !editing && contactCardAvailable ? onPickContact : undefined}
          onShareLocation={
            !replyTo && !editing && currentLocationAvailable ? onShareCurrentLocation : undefined
          }
          onSchedule={replyTo || editing ? undefined : onSchedule}
          onScheduleAttachment={
            !replyTo && !editing && imessageScheduledAttachmentsAvailable
              ? onScheduleAttachment
              : undefined
          }
          onTyping={typingFeaturesAvailable ? onTyping : undefined}
          onStartVoice={
            replyTo || editing || isDev() || !voiceFeaturesAvailable ? undefined : onStartVoice
          }
          translucent={hasWallpaper}
          initialText={composerInitialText}
          onDraftChange={onDraftChange}
          initialAttachments={
            shareReceiptLoaded &&
            attachmentFeaturesAvailable &&
            remainingSharedAttachments.length > 0
              ? remainingSharedAttachments
              : undefined
          }
          active={!composerHidden && screenFocused}
          onRemovalStateChange={setComposerRemovalState}
          onAdmissionApplied={ownedShareBatchId ? onShareAdmissionApplied : undefined}
        />
      ) : (
        <View style={styles.sharePreparing} pointerEvents="none">
          <ActivityIndicator size="small" color={theme.color.tint} />
          <Text style={{ color: theme.color.secondaryLabel }}>Preparing shared item…</Text>
        </View>
      )}
    </View>
  );
  const bottomStack = (
    <>
      {selectionBar}
      {composerStack}
    </>
  );

  return (
    <Screen>
      {visibleBackgroundUri ? (
        <Image
          source={{ uri: visibleBackgroundUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          // Behind the message list; the list container is transparent so this shows
          // through. Bubbles stay readable because the (edited) tokens control contrast.
          pointerEvents="none"
          accessibilityIgnoresInvertColors
        />
      ) : null}
      {/* `padding` consumes the keyboard inset under Android edge-to-edge (RN 0.86 / Expo SDK 57
          default), keeping the composer above the keyboard.
          NO `keyboardVerticalOffset`: it used to be `-insets.bottom`, purely to cancel the
          nav-bar inset the Composer reserved unconditionally. That pair only balanced while the KAV
          was the thing doing the lifting — RN clamps the KAV's padding at 0 but nothing clamped the
          Composer's, so whenever the KAV contributed nothing the cancellation vanished and a full
          nav-bar-sized band opened up between the composer and the keyboard. The Composer now takes
          the union (max) of the keyboard and the nav bar instead of their sum, which is correct
          regardless of which layer absorbs the IME, so the counterweight is not just unneeded —
          keeping it would push the composer BEHIND the keyboard. See Composer.tsx's paddingBottom.
          Same fix on the inbox (ConversationListScreen). */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding" enabled={kbVisible}>
        {/* ONE structural tree for both modes — the wallpaper flag only switches STYLES (bars go
            absolute, the list gains insets). The flag arrives ASYNC (reactive DB read, null on
            first render; a participant-set background can also land mid-chat), so branching element
            types here would remount the whole subtree on the flip — wiping the composer draft,
            staged attachments, and list scroll position.
            Stacking: the header wrapper precedes the list in flow order, so the absolute bars need
            zIndex 2 to sit above the in-flow list instead of being z-buried under it.
            The absolute bars hang off the unpadded stage view, so the keyboard inset (KAV
            padding) shrinks the stage and the composer rides up with it. */}
        <View style={styles.flex}>
          <View
            style={hasWallpaper ? styles.overlayTop : null}
            onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}
          >
            {headerNode}
            {searchNode}
            {errorNode}
            {unreadChipNode}
          </View>
          {listNode}
          <View
            style={hasWallpaper ? styles.overlayBottom : null}
            onLayout={(e) => setBottomBarH(e.nativeEvent.layout.height)}
          >
            {bottomStack}
          </View>
        </View>
      </KeyboardAvoidingView>
      {recording ? (
        <LoadErrorBoundary fallback={null} onError={() => setRecording(false)}>
          <Suspense fallback={null}>
            <VoiceRecorder
              onClose={() => setRecording(false)}
              onPermissionDenied={() =>
                showDialog(
                  'Microphone',
                  'Microphone access was denied. Enable it in system settings to record voice messages.',
                )
              }
              onPermissionError={() =>
                showDialog(
                  'Microphone',
                  'Microphone access is unavailable. Try again or enable it in system settings.',
                )
              }
              onSend={onSendVoice}
            />
          </Suspense>
        </LoadErrorBoundary>
      ) : null}
      <MessageActionsOverlay
        selected={actionSelected}
        onClose={() => setSelected(null)}
        onReact={onReact}
        onRemindLater={onRemindLater}
        onCancelSend={onCancelSelected}
        onCopy={onCopySelected}
        {...(imessageRepliesAvailable ? { onReply: onReplyToSelected } : {})}
        {...(imessageEditsAvailable ? { onEdit: onEditSelected } : {})}
        {...(imessageUnsendsAvailable ? { onUnsend: onUnsendSelected } : {})}
        {...(imessageRemoteDeleteAvailable
          ? { onRemoteDeleteFromMac: onRemoteDeleteSelected }
          : {})}
        onForward={rcsAvailable ? onForwardSelected : undefined}
        onSave={onSaveSelected}
        onShare={onShareSelected}
        onDelete={onDeleteSelected}
        onViewThread={onViewThreadSelected}
        onViewEditHistory={onViewEditHistorySelected}
        onDetails={onDetailsSelected}
        onSelect={onEnterSelect}
      />
      <ThreadSheet
        chatGuid={guid}
        originatorGuid={threadFor}
        onClose={() => setThreadFor(null)}
        onJump={(message) => setJump({ guid: message.guid })}
      />
      <EditHistorySheet data={editHistory} onClose={() => setEditHistory(null)} />
      <MessageDetailsSheet
        data={details}
        onClose={() => setDetails(null)}
        chatService={chatService}
      />
      {screenEffect.effect ? (
        <ScreenEffectOverlay effect={screenEffect.effect} onDone={screenEffect.clear} />
      ) : null}
    </Screen>
  );
}

// Extra breathing room between the newest resting message and the transparent bars floating over
// the wallpaper (added to the measured bar height for the list's content inset).
const BAR_GAP = 28;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hiddenComposer: { display: 'none' },
  sharePreparing: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  // Placeholder while the first message page loads, so the list mounts already-populated
  // (see messagesLoading) — occupies the list's slot so the layout doesn't jump on arrival.
  listLoading: { alignItems: 'center', justifyContent: 'center' },
  // Wallpaper mode: bars float over the full-height list instead of framing it. The bars precede
  // the list in flow order, so zIndex 2 keeps the bar chrome above the in-flow list (0).
  overlayTop: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 2 },
  overlayBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 2 },
  errorBanner: {
    textAlign: 'center',
    paddingVertical: 6,
    fontSize: 13,
    color: '#FF453A',
    backgroundColor: '#FF453A22',
  },
  // Multi-select action bar (replaces the composer while selecting).
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  selectCount: { fontSize: 15, fontWeight: '600' },
  selectActions: { flexDirection: 'row', gap: 24 },
  selectAction: { fontSize: 16, fontWeight: '600' },
  // "N unread — jump to first" pill under the header.
  unreadChip: {
    alignSelf: 'center',
    marginTop: 6,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
  },
  unreadChipText: { fontSize: 13, fontWeight: '600' },
});
