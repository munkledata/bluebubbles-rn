import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Recurrence } from '@core/schedule';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getChatIdByGuid,
  getChatParticipants,
  getFirstUnreadInChat,
  isChatHiddenByDeletion,
  kvGet,
  kvSet,
  type MessagePreview,
} from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import {
  dispatchRealtimeEvent,
  ensureChatSynced,
  ensureSyncedBackground,
  http,
  markRead,
  sendTyping,
} from '@/services';
import { getDatabase } from '@db/database';
import { clearChatNotification } from '@/services/notifications/notifeeService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import {
  editText,
  fireDueScheduled,
  isContactsPermissionDeniedError,
  pickAndSendContact,
  recoverOutgoing,
  reply,
  runDueScheduled,
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
import { useMessageActions } from '@features/conversations/useMessageActions';
import { useMessages } from '@features/conversations/useMessages';
import { useNewScreenEffect } from '@features/conversations/useNewScreenEffect';
import { isDevServer } from '@utils/isDev';
import {
  Composer,
  ConversationHeader,
  EditHistorySheet,
  MessageActionsOverlay,
  MessageDetailsSheet,
  MessageList,
  Screen,
  ThreadSheet,
  ScreenEffectOverlay,
  TypingBubble,
  UploadStatusBar,
  useTheme,
  type PendingAttachment,
} from '@ui';
import { ChatThemeProvider, useChatBackgroundUri } from '@ui/theme/ChatThemeProvider';
import { readableTextOn } from '@ui/theme/adaptiveFromImage';
import { useKeyboardVisible } from '@ui/hooks/useKeyboardVisible';
import { LoadErrorBoundary } from '@ui/LoadErrorBoundary';
import { useLockStore } from '@state/lockStore';
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
 * Backfill this thread's history from the server, so it fills in even if the large initial sync
 * hasn't reached it yet (or was interrupted). The reactive query picks up the upserted messages
 * automatically. Driven both by opening the chat and by pull-to-refresh.
 *
 * SKIPPED FOR A CHAT THE USER DELETED, because this screen stays reachable for one (a tapped
 * notification, a Direct Share chip published before the delete, `router.back()` out of chat
 * settings) and `getChatHeader` is deliberately not visibility-filtered. Re-paging there restores
 * the entire purged conversation — plaintext rows AND their FTS entries — while every restored row
 * is `<= deleted_at`, so the chat stays out of the inbox, out of the archive and out of search: the
 * user cannot see what came back and cannot delete it again, and nothing re-runs the purge. The
 * delete is silently undone. A chat that legitimately came BACK is not affected — the check is the
 * same predicate the lists use, so the moment real activity makes the thread visible again its
 * history backfills exactly as before.
 *
 * A failed check FALLS THROUGH TO SYNCING: a DB read that throws must not be a silent way to
 * disable history backfill for every chat.
 */
async function backfillUnlessDeleted(
  guid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  if (!accountLease.isCurrent()) return;
  try {
    const hidden = await isChatHiddenByDeletion(getDatabase(), guid);
    // The tombstone read can wait behind native SQLite while Disconnect wipes A and admits B.
    // Stop before ensureChatSynced(), whose own session capture would otherwise bind this old
    // screen continuation to B's perfectly current credentials.
    if (!accountLease.isCurrent() || hidden) return;
  } catch (e) {
    if (!accountLease.isCurrent()) return;
    logger.debug('[chat] tombstone check failed; syncing anyway', { error: String(e) });
  }
  if (!accountLease.isCurrent()) return;
  await ensureChatSynced(guid);
}

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
      <ChatScreenInner
        guid={guid}
        focusGuid={focus}
        focusDate={focusDate}
        fromShare={share === '1'}
      />
    </ChatThemeProvider>
  );
}

function ChatScreenInner({
  guid,
  focusGuid,
  focusDate,
  fromShare = false,
}: {
  guid: string;
  focusGuid?: string;
  focusDate?: string;
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
  // When focusing a search hit, load a window CENTERED on it (context on both sides) instead of the
  // recent window; otherwise the normal recent window. ONE message subscription for the whole screen
  // — fed to the list and the screen-effect trigger (avoids doubling the query work).
  const anchorNum = focusDate ? Number(focusDate) : NaN;
  const routeAnchorDate = Number.isFinite(anchorNum) ? anchorNum : undefined;
  // "Jump to oldest unread" reuses the search-hit anchor plumbing: tapping the chip anchors the
  // window on the first unread message (declared here, above useMessages, for hook order).
  const [jump, setJump] = useState<{ guid: string; dateCreated: number } | null>(null);
  const anchorDate = routeAnchorDate ?? jump?.dateCreated;
  const effFocusGuid = focusGuid ?? jump?.guid;
  // The message window grows as the user scrolls back through history (see onLoadOlder). Starts at
  // one screen-worth+ and pages by PAGE_SIZE. In search-anchor mode the window is centered on the
  // hit instead (limit is ignored), so pagination is disabled there.
  const [limit, setLimit] = useState(250);
  const { data: messagesData, error: messagesError } = useMessages(guid, limit, anchorDate);
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
    if (anchorDate != null || loadingOlderRef.current) return;
    if (messages.length < limit) return;
    loadingOlderRef.current = true;
    setLimit((n) => n + 200);
  }, [anchorDate, messages.length, limit]);
  // The list's scroll-to-bottom button in an ANCHORED session (search hit / unread jump): exit the
  // anchor and return to the live newest window. Clearing the route params changes `screenKey`
  // (clean remount → normal bottom-anchored open); clearing only `jump` keeps the instance, and
  // the anchored→normal data swap converges to the newest row via the list's pinned follow loop.
  // '' (not undefined) is the strict-TS-safe way to drop a param — the existing guards treat ''
  // as absent (`focusDate ? … : NaN`, findIndex('') === -1).
  const router = useRouter();
  const exitAnchor = useCallback((): void => {
    setJump(null);
    router.setParams({ focus: '', focusDate: '' });
  }, [router]);
  const isTyping = useTypingStore((s) => !!s.typing[guid]);
  const sendSubjectLines = useFeatureSettingsStore((s) => s.sendSubjectLines);
  // Group participants for @mention autocomplete (reactive so contact-sync name updates flow in).
  const { data: participants } = useReactiveQuery<{ address: string; name: string }[]>(
    async () => (isGroup ? getChatParticipants(getDatabase(), guid) : []),
    ['chat_handles', 'handles'],
    [guid, isGroup],
  );
  const [replyTo, setReplyTo] = useState<MessagePreview | null>(null);
  const [editing, setEditing] = useState<{ guid: string; text: string } | null>(null);
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
  // "Jump to oldest unread": captured BEFORE markRead moves the read marker. The chip shows only
  // when the backlog is deep enough that the oldest unread sits off-screen above the opening view.
  const [firstUnread, setFirstUnread] = useState<{
    guid: string;
    dateCreated: number;
    count: number;
  } | null>(null);

  // Is the app actually in FRONT? This screen stays MOUNTED while the app is backgrounded and
  // underneath the app-lock overlay (the gate is an absolute-fill overlay at the ROOT layout, not a
  // route swap), and FCM keeps writing incoming messages in both states — which flushes the
  // reactive query and re-renders this screen. The live read marker below must not run then.
  // `AppState.currentState` is null until the native module has reported in, and a chat screen only
  // ever mounts because the user navigated to it, so "unknown" counts as on screen.
  const [appActive, setAppActive] = useState(() => AppState.currentState !== 'background');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);
  const locked = useLockStore((s) => s.locked);

  // Gates the live read-marker effect below. The open-time effect MUST read the old marker before
  // anything advances it (that's how firstUnread is computed), so live tracking stays disarmed
  // until that capture is done — armed any earlier it would erase the jump target before use.
  // STATE rather than a ref because arming has to RE-RENDER: when the message window happens to
  // resolve before the capture finishes, a ref would leave the effect below never re-examined, and
  // the first message to actually arrive would be mistaken for the baseline and swallowed. Holds
  // the guid it was armed FOR (not a boolean) so a reused screen instance handed a DIFFERENT chat
  // is disarmed by the compare, with no state reset cascading an extra render on every open.
  const [armedForGuid, setArmedForGuid] = useState<string | null>(null);
  const readTrackingArmed = armedForGuid === guid;
  // The newest RECEIVED guid the read marker already covers; `undefined` until the first message
  // window has been accounted for (see the effect below).
  const markedThroughGuid = useRef<string | null | undefined>(undefined);

  // Runs once per guid/account lease — no once-ref, so a reused screen
  // instance that receives a NEW guid marks the new chat read/synced too.
  useEffect(() => {
    markedThroughGuid.current = undefined;
    if (!guid) return;
    void (async () => {
      // Capture the oldest-unread target BEFORE markRead clears the marker.
      try {
        const db = getDatabase();
        const chatId = await getChatIdByGuid(db, guid);
        if (chatId != null) {
          const fu = await getFirstUnreadInChat(db, chatId);
          if (fu && fu.count >= JUMP_UNREAD_MIN) setFirstUnread(fu);
        }
      } catch {
        // best-effort — the chip just doesn't show
      }
      void markRead(guid, accountLease);
      setArmedForGuid(guid);
    })();
    clearChatNotification(guid, accountLease); // dismiss any tray notification for this chat
    void backfillUnlessDeleted(guid, accountLease);
    // Fetch this chat's synced (macOS 26) background if a participant set/changed one — the
    // reactive `chats` query repaints the background once the downloaded uri is written.
    void ensureSyncedBackground(http, getDatabase(), guid);
  }, [accountLease, guid]);

  // Keep the read marker current while the thread STAYS open. The effect above fires exactly once
  // per guid, so a message the user WATCHED arrive still left a bold unread badge on the inbox when
  // they pressed Back, and left its heads-up notification sitting in the tray. A received message
  // that has rendered here has been read.
  // The rows are NEWEST-FIRST (listMessagesWithSenders orders `date_created DESC`), so the newest
  // received row is the FIRST non-from-me entry. Keying the effect on that guid rather than on the
  // rows is what keeps it off the hot path: every reactive flush rebuilds the array, but in-place
  // ticks (delivery/read receipts, localPath writes, reaction joins) never move the guid — and a
  // reaction can't become the newest row at all, since queryMessageRows excludes
  // `associated_message_type IS NOT NULL`. Memoized over `messagesData`, not `messages`, because
  // the latter's `?? []` fallback is a fresh array on every render.
  const newestReceivedGuid = useMemo(
    () => messagesData?.find((m) => m.isFromMe === 0)?.guid,
    [messagesData],
  );
  // Has the window been read at least once? Tracked separately from the guid because a first window
  // with NO received rows (an empty chat, or one where you sent everything) still has to be
  // baselined — otherwise the first message to arrive there would be taken for the baseline.
  const messagesResolved = messagesData != null;
  useEffect(() => {
    if (!guid || !readTrackingArmed || !messagesResolved) return;
    if (markedThroughGuid.current === undefined) {
      // Baseline, NOT a mark: `useReactiveQuery` renders `data: null` first and resolves the window
      // afterwards, so the undefined→guid step is just the window arriving — everything in it was
      // already covered by the open-time markRead above. Without this baseline every single chat
      // open fired a second markRead: another `chats` write whose reactive flush re-runs the
      // inbox query, plus a second POST /chat/:guid/read when read receipts are on.
      markedThroughGuid.current = newestReceivedGuid ?? null;
      return;
    }
    if (!newestReceivedGuid || newestReceivedGuid === markedThroughGuid.current) return;
    // Only when the user can actually SEE the thread. Marking read from behind the lock screen or
    // from the background would cancel the heads-up notification for a message they never saw
    // (clearChatNotification kills the whole chat's notification by id) and clear the inbox badge
    // with it — and, with read receipts on, tell the sender you read it while the phone is in your
    // pocket. `appActive`/`locked` are deps, so coming back / unlocking re-runs this and marks the
    // message read the moment the thread is genuinely on screen again — nothing is lost, only
    // deferred.
    if (!appActive || locked) return;
    markedThroughGuid.current = newestReceivedGuid;
    void markRead(guid, accountLease);
    clearChatNotification(guid, accountLease);
  }, [
    accountLease,
    guid,
    readTrackingArmed,
    messagesResolved,
    newestReceivedGuid,
    appActive,
    locked,
  ]);

  const isDev = isDevServer;

  // Fire any scheduled messages that have come due — on open + every 20s while open.
  // The ref is a re-entrancy guard so a slow send (>20s) doesn't let the next tick
  // start a second concurrent run (the DB-level claim is the real lock; this just
  // avoids redundant work).
  const firingRef = useRef(false);
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (firingRef.current || !accountLease.isCurrent()) return;
      firingRef.current = true;
      try {
        if (isDev()) {
          await runTrackedRealtimeWork(accountLease, () =>
            runDueScheduled(
              getDatabase(),
              http,
              Date.now(),
              (g, t, s) =>
                s
                  ? devSendFakeReply(g, t, s, undefined, accountLease)
                  : devSendFake(g, t, undefined, accountLease),
              accountLease,
            ),
          );
        } else {
          await fireDueScheduled();
          if (!accountLease.isCurrent()) return;
          // Also drain the outgoing retry queue while a chat is open, so a failed send
          // (text or picture) recovers in ~30s instead of waiting for the next home
          // mount / 15-min background tick. next_retry_at backoff + the DB claim gate
          // the actual re-sends; an empty queue is a single indexed SELECT.
          await recoverOutgoing();
        }
      } catch (error) {
        // A revoked DEV ticker throws its ownership sentinel from the DB guards. It belongs to the
        // retired screen; current-account failures remain a quiet, best-effort ticker diagnostic.
        if (accountLease.isCurrent()) logger.debug('[chat] scheduled catch-up failed', error);
      } finally {
        firingRef.current = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 20_000);
    return () => clearInterval(id);
  }, [accountLease, isDev]);

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
        setEditing(null);
        if (isDev()) void devEditFake(g, text, accountLease);
        else void editText({ messageGuid: g, newText: text, chatGuid: guid }, accountLease);
        return;
      }
      if (replyTo) {
        if (isDev()) void devSendFakeReply(guid, text, replyTo.guid, effectId, accountLease);
        else
          void reply({ chatGuid: guid, text, replyToGuid: replyTo.guid, effectId }, accountLease);
        setReplyTo(null);
        return;
      }
      if (isDev()) void devSendFake(guid, text, effectId, accountLease);
      else void send({ chatGuid: guid, text, effectId, subject, mentions }, accountLease);
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

  // Per-chat draft: restore on open, persist (debounced in the Composer) via kv `draft.<guid>`.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void runTrackedRealtimeWork(accountLease, async () => {
      const value = await kvGet(getDatabase(), `draft.${guid}`);
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
      void runTrackedRealtimeWork(accountLease, async () => {
        await kvSet(getDatabase(), `draft.${guid}`, text);
      }).catch(() => {
        // Best-effort while this account is live — losing a draft persist is not worth surfacing.
      });
    },
    [accountLease, guid],
  );

  // The inline tray's "Files" button — pick documents and return them to STAGE as pending
  // previews (the tray handles photos/videos itself; this covers PDFs/other files). No popup
  // beyond the OS document picker itself.
  const pickFiles = useCallback(
    (): Promise<PendingAttachment[]> => pickDocumentFilesForLease(accountLease),
    [accountLease],
  );

  // The rest of the Composer's callback props, useCallback-stable for the same memo reason.
  const onSendAttachments = useCallback(
    (items: PendingAttachment[]): void =>
      void sendImages({ chatGuid: guid, images: items }, accountLease),
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

  // Contact card: only offered when the server can build vCards (supports_send_contact). Opens the
  // native picker and sends the chosen contact (optimistic bubble + reconcile inside the service).
  const supportsSendContact = useSendContactSupported();
  const onPickContact = useCallback((): void => {
    pickAndSendContact(guid, accountLease).catch((e) => {
      if (!accountLease.isCurrent()) return;
      if (isContactsPermissionDeniedError(e)) {
        showDialog(
          'Contacts',
          'Permission denied. Enable Contacts access in system settings to send a contact.',
        );
        return;
      }
      logger.warn('[chat] contact pick/send failed', e);
    });
  }, [accountLease, guid]);

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
  const bottomBar = bottomBarH > 0 ? bottomBarH : insets.bottom + 54;

  const headerNode = (
    <ConversationHeader chatGuid={guid} data={header.data} translucent={hasWallpaper} />
  );
  const errorNode = messagesError ? (
    <Text style={styles.errorBanner}>Couldn’t load messages. Pull to refresh or reopen.</Text>
  ) : null;
  // "N unread — jump to first" chip under the header; tap anchors the list on the oldest unread.
  const unreadChipNode =
    firstUnread && !jump ? (
      <Pressable
        onPress={() => {
          setJump({ guid: firstUnread.guid, dateCreated: firstUnread.dateCreated });
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
      onLongPressMessage={onLongPressMessage}
      onSwipeReply={onSwipeReply}
      onRefresh={() => backfillUnlessDeleted(guid, accountLease)}
      onLoadOlder={onLoadOlder}
      focusGuid={effFocusGuid}
      selectedGuids={selectedGuids}
      onToggleSelect={onToggleSelect}
      onExitAnchor={anchorDate != null || effFocusGuid ? exitAnchor : undefined}
      accountLease={accountLease}
    />
  );
  // Multi-select replaces the composer with a selection action bar. The Composer's unmount flush
  // persists any in-progress draft to kv AND to `draft` state (via onDraftChange), so exiting
  // select mode remounts the Composer with a fresh `initialText` and restores the draft.
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

  const bottomStack = selectedGuids ? (
    selectionBar
  ) : (
    <>
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
      />
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
                );
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
        onJump={(m) => setJump({ guid: m.guid, dateCreated: m.dateCreated })}
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

// Show the "jump to oldest unread" chip only for a backlog deep enough that the oldest unread
// message sits above the opening (bottom-anchored) view — a handful of unread is already visible.
const JUMP_UNREAD_MIN = 6;

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
