import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { getChatIdByGuid, getFirstUnreadInChat, isChatHiddenByDeletion } from '@db/repositories';
import { ensureChatSynced, ensureSyncedBackgroundForChat, markRead } from '@/services';
import { useLockStore } from '@state/lockStore';
import { claimActiveChat, type ActiveChatClaim } from '@/services/notifications/activeChat';
import { clearChatNotification } from '@/services/notifications/notifeeService';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import type { EnrichedMessage } from './useMessages';

const JUMP_UNREAD_MIN = 6;

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
export async function backfillChatUnlessDeleted(
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

export function useChatReadLifecycle({
  guid,
  messagesData,
  accountLease,
}: {
  guid: string;
  messagesData: EnrichedMessage[] | null;
  accountLease: RealtimeDeliveryLease;
}) {
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
  // Unknown native state fails closed: an extra alert is safer than suppressing a background wake.
  const activeChatClaim = useRef<ActiveChatClaim | null>(null);
  const [screenFocused, setScreenFocused] = useState(false);
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      // Publish synchronously at the native boundary. Waiting for React's state/effect cycle leaves
      // a small background transition window where a real alert can be incorrectly suppressed.
      activeChatClaim.current?.setVisible(active && !useLockStore.getState().locked);
      setAppActive(active);
    });
    return () => sub.remove();
  }, []);
  const locked = useLockStore((s) => s.locked);

  // Navigation focus is distinct from mount: Expo keeps this chat mounted underneath routes such
  // as Chat Settings. Publish only the focused route, and use an owner token so a late cleanup from
  // chat A cannot clear a newly focused chat B. AppState/App Lock are folded in below.
  useFocusEffect(
    useCallback(() => {
      const claim = claimActiveChat(guid);
      activeChatClaim.current = claim;
      claim.setVisible(AppState.currentState === 'active' && !useLockStore.getState().locked);
      setScreenFocused(true);
      return () => {
        claim.release();
        if (activeChatClaim.current === claim) activeChatClaim.current = null;
        setScreenFocused(false);
      };
    }, [guid]),
  );

  useEffect(() => {
    activeChatClaim.current?.setVisible(screenFocused && appActive && !locked);
  }, [appActive, locked, screenFocused]);

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
    void backfillChatUnlessDeleted(guid, accountLease);
    // Fetch this chat's synced (macOS 26) background if a participant set/changed one — the
    // reactive `chats` query repaints the background once the downloaded uri is written.
    void ensureSyncedBackgroundForChat(guid, accountLease);
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
    if (!screenFocused || !appActive || locked) return;
    markedThroughGuid.current = newestReceivedGuid;
    void markRead(guid, accountLease);
    clearChatNotification(guid, accountLease);
  }, [
    accountLease,
    guid,
    readTrackingArmed,
    messagesResolved,
    newestReceivedGuid,
    screenFocused,
    appActive,
    locked,
  ]);
  return { firstUnread, setFirstUnread, screenFocused };
}
