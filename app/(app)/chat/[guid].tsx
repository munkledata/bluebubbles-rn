import { Image } from 'expo-image';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import type { Recurrence } from '@core/schedule';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { showConfirm, showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DRAFT_KV_PREFIX,
  getChatParticipants,
  kvGet,
  type MessagePreview,
  type MessageWindowAnchor,
} from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { dispatchRealtimeEvent, saveChatDraft, sendTyping } from '@/services';
import { getDatabase } from '@db/database';
import { getContactsPermissionState } from '@/services/contacts/contactsService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
import {
  editText,
  hasLogicalSendCapacity,
  isContactsPermissionDeniedError,
  pickAndSendContact,
  reply,
  schedule,
  send,
  sendImage,
  sendImages,
} from '@/services/send';
import { logger } from '@core/secure';
import { useSendContactSupported } from '@state/sessionStore';
import {
  devEditFake,
  devInjectEffect,
  devSendFake,
  devSendFakeReply,
} from '@features/conversations/devSeed';
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
  showToast,
  ThreadSheet,
  ScreenEffectOverlay,
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
import { useTypingStore } from '@state/typingStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useShareIntentStore } from '@state/shareIntentStore';
import { isGroupRow, resolveChatService, resolveTitle } from '@utils';

interface DocumentPickerModule {
  getDocumentAsync(options: { multiple: boolean; copyToCacheDirectory: boolean }): Promise<{
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
 * Open the account-neutral OS picker, then accept its result only if the screen that opened it
 * still owns the active account. The loader is injectable solely to make the delayed native-return
 * boundary deterministic in Node tests; production retains the lazy native import.
 */
export async function pickDocumentFilesForLease(
  accountLease: { isCurrent(): boolean },
  loadPicker: DocumentPickerLoader = () => import('expo-document-picker'),
): Promise<PendingAttachment[]> {
  try {
    const DocumentPicker = await loadPicker();
    if (!accountLease.isCurrent()) return [];
    const res = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
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
  const { guid, focus, focusDate, share } = useLocalSearchParams<{
    guid: string;
    focus?: string;
    focusDate?: string;
    share?: string;
  }>();
  // Remount the whole per-chat subtree when the chat (or its open mode) changes. The screen
  // instance is REUSED on a `router.replace` thread switch (notification tap while a chat is open),
  // and `useReactiveQuery` keeps the PREVIOUS deps' data until the new query resolves — without the
  // key, `messagesLoading` never gates, so the list mounted with the previous chat's rows, did its
  // one-shot bottom landing against the wrong content, and stranded the new thread mid-history.
  // The key also resets per-chat state that must not leak across a switch (pagination limit, jump
  // anchor, reply/edit targets, selection) and re-runs the share-intent lazy initializers so a
  // Direct Share into an already-open different chat still stages its files.
  const screenKey = `${guid}|${focus ?? ''}|${focusDate ?? ''}|${share ?? ''}`;
  return (
    <ChatThemeProvider key={screenKey} guid={guid}>
      <ChatScreenInner guid={guid} focusGuid={focus} fromShare={share === '1'} />
    </ChatThemeProvider>
  );
}

function ChatScreenInner({
  guid,
  focusGuid,
  fromShare = false,
}: {
  guid: string;
  focusGuid?: string;
  fromShare?: boolean;
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
  const { data: messagesData, error: messagesError } = useMessages(guid, limit, anchor);
  const messages = messagesData ?? [];
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
  // anchor and return to the live newest window. Clearing the route params changes `screenKey`
  // (clean remount → normal bottom-anchored open); clearing only `jump` keeps the instance, and
  // the anchored→normal data swap converges to the newest row via the list's pinned follow loop.
  // '' (not undefined) is the strict-TS-safe way to drop a param — the existing focus-guid guard
  // treats it as absent (`findIndex('') === -1`). `focusDate` remains in old deep links only for
  // compatibility; exact message identity now owns the window lookup.
  const router = useRouter();
  const navigation = useNavigation();
  const exitAnchor = useCallback((): void => {
    setJump(null);
    router.setParams({ focus: '', focusDate: '' });
  }, [router]);

  const closeSearch = useCallback((): void => {
    searchNavigationTokenRef.current += 1;
    appliedSearchKeyRef.current = '';
    setSearchOpen(false);
    setSearchText('');
    setSearchQuery('');
    setSearchIndex(0);
    setSearchNavigating(false);
    // Search uses a bounded context window. Return to the live newest window before the composer
    // becomes usable again, or a send outside that old window can look as though it disappeared.
    exitAnchor();
  }, [exitAnchor]);
  const exitSearchAnchor = useCallback((): void => {
    if (searchOpenRef.current) closeSearch();
    else exitAnchor();
  }, [closeSearch, exitAnchor]);
  const onSearchTextChange = useCallback((value: string): void => {
    searchNavigationTokenRef.current += 1;
    appliedSearchKeyRef.current = '';
    setSearchText(value);
    if (value.trim().length < 3) setSearchQuery('');
    setSearchIndex(0);
    setSearchNavigating(false);
    // Do not leave a stale prior-query result highlighted while the next query is debouncing.
    setJump(null);
  }, []);

  // Select the newest hit once for each completed query. Later page loads reuse the same key and
  // therefore cannot snap the reader back to result zero.
  useEffect(() => {
    if (!searchOpen || searchQuery.length < 3) return;
    const key = `${accountLease.generation}\u0000${guid}\u0000${searchQuery}`;
    if (searchPending || appliedSearchKeyRef.current === key) return;
    appliedSearchKeyRef.current = key;
    searchNavigationTokenRef.current += 1;
    setSearchIndex(0);
    setSearchNavigating(false);
    const first = searchResults[0];
    setJump(first ? { id: first.id, guid: first.guid } : null);
  }, [accountLease.generation, searchPending, searchResults, guid, searchOpen, searchQuery]);

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
  const sendSubjectLines = useFeatureSettingsStore((s) => s.sendSubjectLines);
  // Group participants for @mention autocomplete (reactive so contact-sync name updates flow in).
  const { data: participants } = useReactiveQuery<{ address: string; name: string }[]>(
    async () => (isGroup ? getChatParticipants(getDatabase(), guid) : []),
    ['chat_handles', 'handles'],
    [guid, isGroup],
  );
  const [replyTo, setReplyTo] = useState<MessagePreview | null>(null);
  const [editing, setEditing] = useState<{
    guid: string;
    text: string;
    partIndex: number;
  } | null>(null);
  const [recording, setRecording] = useState(false);

  // Dormant future bounded-share handoff. IPC-01 currently exposes no inbound Android share target,
  // so production navigation never supplies `?share=1`. If an owned bounded intake is added later,
  // capture the already-materialized batch ONCE in these lazy initializers; the effect then clears
  // the store so a normal chat open never picks it up.
  const [sharedAttachments] = useState<PendingAttachment[]>(() =>
    fromShare
      ? useShareIntentStore
          .getState()
          .files.map((f) => ({ uri: f.uri, name: f.name, mimeType: f.mimeType, size: f.size }))
      : [],
  );
  const [sharedText] = useState<string | null>(() =>
    fromShare ? useShareIntentStore.getState().text : null,
  );
  useEffect(() => {
    if (fromShare) useShareIntentStore.getState().clear();
  }, [fromShare]);
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
      // Capture the active reply target so a scheduled reply still threads.
      void schedule(
        {
          chatGuid: guid,
          text,
          scheduledFor,
          selectedMessageGuid: replyTo?.guid,
          selectedMessagePartIndex: replyTo?.targetPartIndex,
          recurrence,
        },
        accountLease,
      ).catch((error: unknown) => {
        if (!accountLease.isCurrent()) return;
        logger.warn('[chat] could not schedule message', error);
        showDialog('Scheduled', 'Couldn’t schedule that message.');
      });
      setReplyTo(null);
    },
    [accountLease, guid, replyTo],
  );

  const onSend = useCallback(
    (
      text: string,
      effectId?: string,
      subject?: string,
      mentions?: { start: number; length: number; address: string }[],
    ): void => {
      // DEV: when on the local dev session, simulate the server round-trip so the
      // optimistic → sent flow is visible without a real Gator server.
      if (editing) {
        const g = editing.guid;
        const partIndex = editing.partIndex;
        setEditing(null);
        if (isDev()) void devEditFake(g, text, partIndex, accountLease);
        else
          void editText({ messageGuid: g, newText: text, chatGuid: guid, partIndex }, accountLease);
        return;
      }
      if (replyTo) {
        const partIndex = replyTo.targetPartIndex ?? 0;
        if (isDev())
          void devSendFakeReply(guid, text, replyTo.guid, partIndex, effectId, accountLease);
        else
          void reply(
            {
              chatGuid: guid,
              text,
              replyToGuid: replyTo.guid,
              replyToPartIndex: partIndex,
              effectId,
            },
            accountLease,
            presentSendIssue,
          );
        setReplyTo(null);
        return;
      }
      if (isDev()) void devSendFake(guid, text, effectId, accountLease);
      else
        void send(
          { chatGuid: guid, text, effectId, subject, mentions },
          accountLease,
          presentSendIssue,
        );
    },
    [accountLease, guid, editing, replyTo, isDev],
  );

  // The long-press menu / multi-select / swipe-reply handlers (selected, selectedGuids, and
  // threadFor state live in the hook). onLongPressMessage / onSwipeReply / onToggleSelect are
  // STABLE — they feed the memoized MessageList → MessageRow chain (see useMessageActions).
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
    onToggleSelect,
    onEnterSelect,
    onBulkCopy,
    onBulkDelete,
    onViewThreadSelected,
    onEditSelected,
    onUnsendSelected,
    onCancelSelected,
    onReact,
    onReplyToSelected,
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
    setReplyTo,
    setEditing,
  });

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

  const [composerRemovalState, setComposerRemovalState] = useState<ComposerRemovalState>({
    hasUnsavedEdit: false,
    hasUnsavedDraftMetadata: false,
  });
  const backConfirmationPendingRef = useRef(false);
  const shouldHandleBack =
    searchOpen ||
    selectedGuids != null ||
    replyTo != null ||
    editing != null ||
    composerRemovalState.hasUnsavedDraftMetadata;

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
    if (editing != null) {
      if (!composerRemovalState.hasUnsavedEdit) {
        setEditing(null);
        return;
      }
      if (backConfirmationPendingRef.current) return;
      backConfirmationPendingRef.current = true;
      showConfirm({
        title: 'Discard message edit?',
        message: 'The changes to this message will be lost.',
        confirmText: 'Discard',
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
    if (replyTo != null) {
      setReplyTo(null);
      return;
    }
    if (!composerRemovalState.hasUnsavedDraftMetadata || backConfirmationPendingRef.current) return;
    backConfirmationPendingRef.current = true;
    showConfirm({
      title: 'Discard message attachments and options?',
      message:
        'Attachments, the subject, and mention details are not part of the saved text draft.',
      confirmText: 'Discard',
      destructive: true,
      onCancel: () => {
        backConfirmationPendingRef.current = false;
      },
      onConfirm: () => {
        backConfirmationPendingRef.current = false;
        navigation.dispatch(data.action);
      },
    });
  });

  // The inline tray's "Files" button — pick documents and return them to STAGE as pending
  // previews (the tray handles photos/videos itself; this covers PDFs/other files). No popup
  // beyond the OS document picker itself.
  const pickFiles = useCallback(
    (): Promise<PendingAttachment[]> => pickDocumentFilesForLease(accountLease),
    [accountLease],
  );

  // The rest of the Composer's callback props, useCallback-stable for the same memo reason.
  const onSendAttachments = useCallback(
    (items: PendingAttachment[]): void => {
      void sendImages({ chatGuid: guid, images: items }, accountLease, presentSendIssue).catch(
        (error) => {
          if (!accountLease.isCurrent()) return;
          logger.warn('[chat] attachment send rejected', error);
          showToast('Couldn’t send one or more attachments—add the missing file again');
        },
      );
    },
    [accountLease, guid],
  );
  const onCancelReply = useCallback((): void => setReplyTo(null), []);
  const onCancelEdit = useCallback((): void => setEditing(null), []);
  const onTyping = useCallback(
    (active: boolean): void => {
      // Composer debounce/unmount callbacks can run after Disconnect. The socket emit itself is
      // synchronous, so a lease check is the complete atomic boundary here.
      if (accountLease.isCurrent()) void sendTyping(guid, active);
    },
    [accountLease, guid],
  );
  const onStartVoice = useCallback((): void => setRecording(true), []);

  // Contact card: only offered when the server can build vCards (supports_send_contact). Explain
  // the optional Contacts grant before Android's prompt, then open the native picker and send the
  // chosen contact (optimistic bubble + reconcile inside the service).
  const supportsSendContact = useSendContactSupported();
  const runContactPicker = useCallback((): void => {
    const attempt = (): void => {
      pickAndSendContact(guid, accountLease, presentSendIssue).catch((e) => {
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
      });
    };
    attempt();
  }, [accountLease, guid]);
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
      onSwipeReply={searchOpen ? undefined : onSwipeReply}
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
  // MOUNTED (display:none below): unmount/remount preserved body text but destroyed attachments,
  // subject/mention metadata, and in-progress edits.
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

  const composerHidden = selectedGuids != null || searchOpen;
  const composerStack = (
    <View
      style={composerHidden ? styles.hiddenComposer : null}
      pointerEvents={composerHidden ? 'none' : 'auto'}
      accessibilityElementsHidden={composerHidden}
      importantForAccessibility={composerHidden ? 'no-hide-descendants' : 'auto'}
    >
      {isTyping ? <TypingBubble /> : null}
      {/* Renders nothing unless this chat has an upload in flight. It lives INSIDE the measured
          bottom bar, so appearing/disappearing re-lands the message list through the wrapper's
          existing onLayout → pin convergence rather than stranding it behind the composer. */}
      <UploadStatusBar chatGuid={guid} translucent={hasWallpaper} />
      <Composer
        placeholder={
          chatService === 'RCS'
            ? 'RCS Message'
            : chatService === 'SMS'
              ? 'Text Message'
              : 'iMessage'
        }
        onSend={onSend}
        onSendAttachments={onSendAttachments}
        canSubmit={hasLogicalSendCapacity}
        isSubmitOwnerCurrent={accountLease.isCurrent}
        onPickFiles={pickFiles}
        onPickContact={supportsSendContact ? onPickContact : undefined}
        replyTo={replyTo}
        onCancelReply={onCancelReply}
        editingText={editing?.text ?? null}
        onCancelEdit={onCancelEdit}
        onSchedule={onSchedule}
        onTyping={onTyping}
        onStartVoice={isDev() ? undefined : onStartVoice}
        translucent={hasWallpaper}
        subjectEnabled={sendSubjectLines && chatService === 'iMessage'}
        mentionParticipants={
          isGroup && chatService === 'iMessage' ? (participants ?? NO_PARTICIPANTS) : undefined
        }
        initialText={draft ?? sharedText ?? undefined}
        onDraftChange={onDraftChange}
        initialAttachments={sharedAttachments.length > 0 ? sharedAttachments : undefined}
        active={!composerHidden && screenFocused}
        onRemovalStateChange={setComposerRemovalState}
      />
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
              onSend={(uri) => {
                setRecording(false);
                void sendImage(
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
                ).catch((error) => {
                  if (!accountLease.isCurrent()) return;
                  logger.warn('[chat] voice message send rejected', error);
                  showToast('Couldn’t send that recording—try recording it again');
                });
              }}
            />
          </Suspense>
        </LoadErrorBoundary>
      ) : null}
      <MessageActionsOverlay
        selected={selected}
        onClose={() => setSelected(null)}
        onReact={onReact}
        onReply={onReplyToSelected}
        onRemindLater={onRemindLater}
        onEdit={onEditSelected}
        onUnsend={onUnsendSelected}
        onCancelSend={onCancelSelected}
        onCopy={onCopySelected}
        onForward={onForwardSelected}
        onSave={onSaveSelected}
        onShare={onShareSelected}
        onDelete={onDeleteSelected}
        onViewThread={onViewThreadSelected}
        onViewEditHistory={onViewEditHistorySelected}
        onDetails={onDetailsSelected}
        onSelect={onEnterSelect}
      />
      <ThreadSheet
        originatorGuid={threadFor}
        onClose={() => setThreadFor(null)}
        onJump={(m) => setJump({ guid: m.guid })}
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
      {__DEV__ ? (
        <Pressable style={styles.devFx} onPress={() => void devInjectEffect(guid, accountLease)}>
          <Text style={styles.devFxText}>💥</Text>
        </Pressable>
      ) : null}
      {__DEV__ ? (
        <Pressable
          style={styles.devTyping}
          onPress={() => {
            if (!isDevServer() || !accountLease.isCurrent()) return;
            void dispatchRealtimeEvent(
              'typing-indicator',
              { chatGuid: guid, display: true },
              'dev',
              accountLease,
            ).catch((error: unknown) => {
              if (accountLease.isCurrent()) {
                logger.debug('[chat] DEV typing injection failed', error);
              }
            });
          }}
        >
          <Text style={styles.devFxText}>⌨️</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}

// Extra breathing room between the newest resting message and the transparent bars floating over
// the wallpaper (added to the measured bar height for the list's content inset).
const BAR_GAP = 28;

// Stable empty fallback for mentionParticipants — a fresh [] each render would defeat the
// memoized Composer's shallow prop compare.
const NO_PARTICIPANTS: { address: string; name: string }[] = [];

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hiddenComposer: { display: 'none' },
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
  // DEV-only: inject a send-effect message into this chat to demo effects.
  devFx: {
    position: 'absolute',
    left: 12,
    bottom: 92,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#00000088',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // DEV-only: inject a typing-indicator event to demo the typing bubble.
  devTyping: {
    position: 'absolute',
    left: 12,
    bottom: 144,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#00000088',
    alignItems: 'center',
    justifyContent: 'center',
  },
  devFxText: { fontSize: 22 },
});
