import { chatsApi, scheduledApi } from '@core/api';
import { isIMessageReadStateGuid } from '@core/api/endpoints/chats';
import type { HttpClient } from '@core/api/http';
import { parseRcsChatGuid } from '@core/rcs/providerIdentity';
import { logger } from '@core/secure';
import {
  ATTACHMENT_CACHE_RECOVERY_MAX_FILES,
  ATTACHMENT_CACHE_RECOVERY_BATCH_FILES,
  clearChatTombstoneWithinTransaction,
  DRAFT_KV_PREFIX,
  deleteChatLocal,
  deleteReminderByNotificationIdWithinTransaction,
  deleteScheduledWithinTransaction,
  getChatIdByGuid,
  getNewestReceivedGuid,
  isShareIntakeNewChatRetryWindowOpen,
  linkHandlesToContacts,
  listChatAttachmentGuids,
  listReminders,
  listScheduledByChat,
  markAllChatsReadLocalWithinTransaction,
  kvSetWithinTransaction,
  resumeChatPurges,
  recordShareIntakeNewChatWithinTransaction,
  setChatAppearanceWithinTransaction,
  setChatArchiveWithinTransaction,
  setChatCustomizationWithinTransaction,
  setHandleColorWithinTransaction,
  setChatMuteWithinTransaction,
  setChatPinWithinTransaction,
  setChatUnreadLocalWithinTransaction,
  setLastReadMessageGuidWithinTransaction,
  swapPinnedChatOrder,
  upsertChatsWithinTransaction,
  upsertHandlesWithinTransaction,
  type ChatAppearancePatch,
  type InboxSenderFilter,
  type PinnedOrderMoveDirection,
  type ShareIntakeManifestIdentity,
  type ShareIntakeNewChatPlan,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbTransactionContext,
} from '@db/transaction';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { sessionAccessors } from '@state/sessionStore';
import { accountHttp, http } from './clients';
import { ensureDatabase } from './databaseControl';
import { createAttachmentCacheAccountScope } from './download/attachmentCacheAccountScope';
import { cancelAttachmentDownloads } from './download/downloadService';
import { attachmentCacheCoordinator } from './download/attachmentCacheCoordinator';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { getSocket } from './realtimeControl';

/** Private rollback signal for a create-chat mutation whose account was disconnected. */
const STALE_CREATE_CHAT = Symbol('stale-create-chat');
/** Private control-flow signal for a chat action whose account is being retired. */
const STALE_CHAT_ACTION = Symbol('stale-chat-action');

function assertCreateChatLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw STALE_CREATE_CHAT;
}

export type NewChatService = 'RCS' | 'iMessage';

export interface ShareIntakeNewChatContext {
  readonly identity: ShareIntakeManifestIdentity;
  readonly plan: ShareIntakeNewChatPlan;
}

function assertCreateChatCapability(
  service: NewChatService,
  expectedRcsEpoch?: string | null,
  requireAttemptOwnership = false,
): string | null {
  if (service !== 'RCS' && service !== 'iMessage') {
    throw new Error('This conversation service cannot be started.');
  }
  if (service === 'RCS') {
    const providerEpoch = sessionAccessors.rcsProviderEpoch();
    if (!providerEpoch || (expectedRcsEpoch !== undefined && providerEpoch !== expectedRcsEpoch)) {
      throw new Error('Starting a new RCS conversation is unavailable for this Google pairing.');
    }
    if (requireAttemptOwnership && !sessionAccessors.rcsSendAttemptOwnershipSupported()) {
      throw new Error('Safe retry ownership is unavailable for this RCS conversation.');
    }
    return providerEpoch;
  }
  if (!sessionAccessors.imessageNewChatEnabled()) {
    throw new Error(`Starting a new ${service} conversation is unavailable on this server.`);
  }
  return null;
}

function assertSingleRecipient(
  addresses: readonly string[],
): asserts addresses is readonly [string] {
  if (addresses.length !== 1 || addresses[0]?.trim().length === 0) {
    throw new Error('Starting a new conversation requires exactly one recipient.');
  }
}

function assertChatActionLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw STALE_CHAT_ACTION;
}

/**
 * Guard for a step that reaches the SERVER about a chat. Apple chats always pass; an RCS chat needs
 * the active Google pairing, because a re-pair can reuse provider ids at the server. Local state
 * (tombstones, archive, pin, mute, read markers, drafts, folders) never uses this: it is keyed by
 * the exact stored guid, so any RCS history row, including one from an older pairing, stays editable.
 */
function captureRcsServerStepGuard(...chatGuids: readonly string[]): (() => boolean) | null {
  const rcsTargets = chatGuids.filter((guid) => guid.startsWith('RCS;-;'));
  if (rcsTargets.length === 0) return () => true;
  const expectedEpoch = sessionAccessors.rcsProviderEpoch();
  if (!expectedEpoch || rcsTargets.some((guid) => !sessionAccessors.acceptsRcsChat(guid))) {
    return null;
  }
  return () =>
    sessionAccessors.rcsProviderEpoch() === expectedEpoch &&
    rcsTargets.every((guid) => sessionAccessors.acceptsRcsChat(guid));
}

/**
 * Admit an entire user/chat mutation before its first await and quietly abandon stale work.
 *
 * Disconnect invalidates `lease` synchronously and drains the published slot before wiping the
 * account. That means an operation already inside a short DB write completes and is then wiped,
 * while one parked on Keystore/network work cannot wake up and touch the next account.
 */
async function runChatAction(
  lease: RealtimeDeliveryLease,
  action: (lease: RealtimeDeliveryLease) => Promise<void>,
  mutationIsCurrent: () => boolean = () => true,
): Promise<void> {
  try {
    await runTrackedRealtimeWork(lease, async (trackedLease) => {
      const guardedLease: RealtimeDeliveryLease = {
        generation: trackedLease.generation,
        ...(trackedLease.signal ? { signal: trackedLease.signal } : {}),
        isCurrent: () => trackedLease.isCurrent() && mutationIsCurrent(),
      };
      assertChatActionLease(guardedLease);
      await action(guardedLease);
      assertChatActionLease(guardedLease);
    });
  } catch (error) {
    if (error === STALE_CHAT_ACTION || !lease.isCurrent()) return;
    throw error;
  }
}

type ReadStateSyncTask = () => Promise<void>;

interface ReadStateSyncReservation {
  run(task: ReadStateSyncTask): Promise<void>;
  releaseWithoutSync(): void;
}

/**
 * Reserve the caller's place in one chat's remote read-state sequence before any local await.
 * Local database changes still happen immediately; only the best-effort Mac requests wait for the
 * preceding intent. Releasing every unused reservation prevents an early return from blocking the
 * next read/unread action.
 */
const readStateSyncTails = new Map<string, Promise<void>>();

function reserveReadStateSync(
  accountGeneration: number,
  chatGuid: string,
): ReadStateSyncReservation {
  const laneKey = `${accountGeneration}\u0000${chatGuid}`;
  let supplyTask: (task: ReadStateSyncTask | null) => void = () => undefined;
  const admittedTask = new Promise<ReadStateSyncTask | null>((resolve) => {
    supplyTask = resolve;
  });
  const previous = readStateSyncTails.get(laneKey) ?? Promise.resolve();
  let supplied = false;
  const completion = previous.then(async () => {
    const task = await admittedTask;
    if (task) await task();
  });
  let settledTail: Promise<void>;
  settledTail = completion
    .catch(() => undefined)
    .finally(() => {
      if (readStateSyncTails.get(laneKey) === settledTail) readStateSyncTails.delete(laneKey);
    });
  readStateSyncTails.set(laneKey, settledTail);

  return {
    run(task) {
      if (!supplied) {
        supplied = true;
        supplyTask(task);
      }
      return completion;
    },
    releaseWithoutSync() {
      if (supplied) return;
      supplied = true;
      supplyTask(null);
    },
  };
}

/** Set or clear the device-local mute preference for one conversation. */
export function setChatMuted(
  chatGuid: string,
  muted: boolean,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await setChatMuteWithinTransaction(context, chatGuid, muted ? 'mute' : null);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Move a conversation into or out of the device-local archive. */
export function setChatArchived(
  chatGuid: string,
  archived: boolean,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await setChatArchiveWithinTransaction(context, chatGuid, archived);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Set or clear the device-local pinned state for one conversation. */
export function setChatPinned(
  chatGuid: string,
  pinned: boolean,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await setChatPinWithinTransaction(context, chatGuid, pinned);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Local name/color fields accepted by the chat-settings command boundary. */
export interface ChatCustomizationPatch {
  readonly customName?: string | null;
  readonly customColor?: string | null;
}

/** Update one or more device-local name/color overrides for a conversation. */
export function updateChatCustomization(
  chatGuid: string,
  patch: ChatCustomizationPatch,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await setChatCustomizationWithinTransaction(context, chatGuid, patch);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Set or reset a device-local participant color from the exact conversation that selected it. */
export function updateHandleColor(
  chatGuid: string,
  address: string,
  service: string | null,
  color: string | null,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        const updated = await setHandleColorWithinTransaction(
          context,
          chatGuid,
          address,
          service,
          color,
        );
        if (!updated)
          throw new Error('The selected participant is no longer in this conversation.');
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Update one or more device-local theme/background fields for a conversation. */
export function updateChatAppearance(
  chatGuid: string,
  patch: ChatAppearancePatch,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await setChatAppearanceWithinTransaction(context, chatGuid, patch);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Atomically clear the local name, accent color, and mute preference for one conversation. */
export function resetChatLocalPreferences(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await setChatCustomizationWithinTransaction(context, chatGuid, {
          customName: null,
          customColor: null,
        });
        assertChatActionLease(activeLease);
        await setChatMuteWithinTransaction(context, chatGuid, null);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

export interface MovePinnedChatOptions {
  readonly chatGuid: string;
  readonly adjacentChatGuid: string;
  readonly direction: PinnedOrderMoveDirection;
  readonly sender?: InboxSenderFilter;
}

/** Swap a pinned conversation with its current visible neighbor. */
export function movePinnedChat(
  options: MovePinnedChatOptions,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await swapPinnedChatOrder(
      db,
      options.chatGuid,
      options.adjacentChatGuid,
      options.direction,
      () => activeLease.isCurrent(),
      options.sender ?? 'any',
    );
  });
}

/** Clear every local inbox unread marker without sending server read receipts. */
export function markAllChatsRead(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await markAllChatsReadLocalWithinTransaction(context);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/** Persist the current body-text draft for one conversation. */
export function saveChatDraft(
  chatGuid: string,
  text: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await kvSetWithinTransaction(context, `${DRAFT_KV_PREFIX}${chatGuid}`, text);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
  });
}

/**
 * Create a one-recipient chat with an initial message, upsert the returned chat locally so it
 * appears immediately, and return its guid (route into it). iMessage requires a narrowly admitted
 * helper capability and a stable request identity; SMS creation remains unavailable.
 */
export async function createNewChat(
  addresses: readonly [string],
  message: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  service: NewChatService = 'RCS',
  tempGuid?: string,
  shareIntake?: ShareIntakeNewChatContext,
): Promise<string> {
  try {
    // Capture happened in the default argument. A retained callback must fail as old-account work
    // before it reads any capability owned by a successor session.
    assertCreateChatLease(accountLease);
    // Fail before opening the DB or starting HTTP. The single-recipient shape is checked at runtime
    // too, so stale JavaScript or an untyped caller cannot silently drop extra recipients.
    assertSingleRecipient(addresses);
    if (shareIntake && !isShareIntakeNewChatRetryWindowOpen(shareIntake.identity)) {
      throw new Error('This shared conversation is too old to retry safely.');
    }
    if (shareIntake && service === 'iMessage') {
      throw new Error(
        'Starting a new iMessage conversation from Share is disabled because its retry identity is not scoped to the active Messages account.',
      );
    }
    const rcsProviderEpoch = assertCreateChatCapability(
      service,
      shareIntake && service === 'RCS' ? shareIntake.plan.providerEpoch : undefined,
      shareIntake != null,
    );
    const createProviderIsCurrent = (): boolean =>
      service !== 'RCS' || sessionAccessors.rcsProviderEpoch() === rcsProviderEpoch;
    if (service === 'iMessage' && !tempGuid?.trim()) {
      throw new Error('Starting an iMessage conversation requires a stable request identity.');
    }
    if (
      shareIntake &&
      (shareIntake.plan.address !== addresses[0] ||
        shareIntake.plan.body !== message ||
        shareIntake.plan.service !== service ||
        shareIntake.plan.tempGuid !== tempGuid ||
        shareIntake.plan.providerEpoch !== rcsProviderEpoch)
    ) {
      throw new Error('The resumed share no longer matches its durable new-chat plan.');
    }
    // Re-check after opening the DB so an A-account call parked on Keystore/database work cannot
    // wake up after reconnect and send its request with B's live credentials.
    const db = await ensureDatabase();
    assertCreateChatLease(accountLease);
    assertSingleRecipient(addresses);
    assertCreateChatCapability(service, rcsProviderEpoch, shareIntake != null);

    // HttpClient snapshots the origin + credential at request entry. A Disconnect cannot recall a
    // request the old server already accepted, but its response is disowned below and can never be
    // reconciled into the next account's database.
    // No await separates this last epoch check from request creation. A same-session re-pair that
    // already reached ServerInfo therefore cannot dispatch an old draft into its replacement.
    assertCreateChatCapability(service, rcsProviderEpoch, shareIntake != null);
    const chat = await chatsApi.createChat(http, {
      address: addresses[0],
      message,
      service,
      tempGuid,
      // A stable id lets a retry of the same draft or share replay its first attempt instead of
      // sending the first message again; the receipt proves the server kept that identity.
      ...(service === 'RCS' && tempGuid
        ? {
            clientAttemptGeneration: shareIntake?.plan.clientAttemptGeneration ?? 1,
            requireAttemptReceipt: true,
          }
        : {}),
      ...(service === 'RCS' && rcsProviderEpoch ? { providerEpoch: rcsProviderEpoch } : {}),
    });
    assertCreateChatLease(accountLease);
    assertCreateChatCapability(service, rcsProviderEpoch, shareIntake != null);
    if (service === 'RCS') {
      const scoped = parseRcsChatGuid(chat.guid);
      if (
        !rcsProviderEpoch ||
        scoped?.providerEpoch !== rcsProviderEpoch ||
        (chat.providerEpoch != null && chat.providerEpoch !== rcsProviderEpoch)
      ) {
        throw new Error('The server returned a conversation from a different Google pairing.');
      }
    }

    // Keep every local consequence atomic. Disconnect either waits for this short commit and then
    // wipes it, rejects admission before it begins, or invalidates the lease mid-transaction and
    // the final check rolls the whole handle/chat/tombstone set back.
    const commit = await runTrackedRealtimeWork(accountLease, () =>
      withDbTransaction(
        db,
        async (context) => {
          assertCreateChatLease(accountLease);
          const handleIds = await upsertHandlesWithinTransaction(context, chat.participants ?? []);
          assertCreateChatLease(accountLease);
          await upsertChatsWithinTransaction(context, [chat], handleIds);
          assertCreateChatLease(accountLease);
          // A 1:1 guid is `service;-;address`, so composing with someone whose thread was deleted here
          // returns the SAME guid — still under its deletion tombstone, i.e. hidden from the inbox we
          // are about to route into. Deliberately starting the conversation again is an un-delete.
          await clearChatTombstoneWithinTransaction(context, chat.guid);
          assertCreateChatLease(accountLease);
          if (shareIntake) {
            await recordShareIntakeNewChatWithinTransaction(context, {
              identity: shareIntake.identity,
              chatGuid: chat.guid,
              plan: shareIntake.plan,
              nativeTextConsumed: shareIntake.identity.hasText,
              appliedAtMs: Date.now(),
            });
            assertCreateChatLease(accountLease);
          }
        },
        () => accountLease.isCurrent() && createProviderIsCurrent(),
      ),
    );
    if (commit === 'paused') throw STALE_CREATE_CHAT;
    assertCreateChatLease(accountLease);
    assertCreateChatCapability(service, rcsProviderEpoch, shareIntake != null);

    // Device-contact matching reads the whole address book, so it must run only after the short
    // authoritative handle/chat/tombstone transaction commits. Each actual match owns its own
    // commit-guarded transaction; a presentation-only failure must not undo a successfully created
    // conversation.
    try {
      await linkHandlesToContacts(
        db,
        (chat.participants ?? []).map((participant) => participant.address),
        undefined,
        () => accountLease.isCurrent() && createProviderIsCurrent(),
      );
    } catch (error) {
      if (!accountLease.isCurrent() || !createProviderIsCurrent()) throw STALE_CREATE_CHAT;
      logger.debug('[chats] post-create contact linking skipped', error);
    }
    assertCreateChatLease(accountLease);
    assertCreateChatCapability(service, rcsProviderEpoch, shareIntake != null);
    return chat.guid;
  } catch (error) {
    if (error === STALE_CREATE_CHAT) {
      throw new Error('Create chat stopped because the account session changed');
    }
    throw error;
  }
}

interface TypingIntent {
  readonly isTyping: boolean;
  readonly socket: NonNullable<ReturnType<typeof getSocket>>;
  readonly accountLease: RealtimeDeliveryLease;
  releaseInvalidation: () => void;
}

const latestTypingIntent = new Map<string, TypingIntent>();
const TYPING_STOP_RETRY_DELAY_MS = 1_000;

function confirmedTypingAck(response: unknown, expected: boolean): boolean {
  if (typeof response !== 'object' || response === null) return false;
  const envelope = response as { status?: unknown; data?: unknown };
  if (envelope.status !== 200 || typeof envelope.data !== 'object' || envelope.data === null) {
    return false;
  }
  return (envelope.data as { typing?: unknown }).typing === expected;
}

function retryableTypingStopAck(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) return false;
  const envelope = response as { status?: unknown; error?: unknown };
  if (envelope.status === 503) return true;
  if (envelope.status !== 409 || typeof envelope.error !== 'object' || envelope.error === null) {
    return false;
  }
  return (envelope.error as { type?: unknown }).type === 'imessage_typing_outcome_unknown';
}

function stillLatestTypingIntent(chatGuid: string, intent: TypingIntent): boolean {
  return latestTypingIntent.get(chatGuid) === intent;
}

function retireTypingIntent(chatGuid: string, intent: TypingIntent): void {
  if (!stillLatestTypingIntent(chatGuid, intent)) return;
  latestTypingIntent.delete(chatGuid);
  intent.releaseInvalidation();
}

function installTypingIntent(
  chatGuid: string,
  isTyping: boolean,
  socket: NonNullable<ReturnType<typeof getSocket>>,
  accountLease: RealtimeDeliveryLease,
): TypingIntent | null {
  const intent: TypingIntent = {
    isTyping,
    socket,
    accountLease,
    releaseInvalidation: () => undefined,
  };
  intent.releaseInvalidation = subscribeRealtimeGenerationInvalidation(
    accountLease.generation,
    () => retireTypingIntent(chatGuid, intent),
  );
  if (!accountLease.isCurrent()) {
    intent.releaseInvalidation();
    return null;
  }

  latestTypingIntent.get(chatGuid)?.releaseInvalidation();
  latestTypingIntent.set(chatGuid, intent);
  return intent;
}

async function stopImessageTyping(chatGuid: string, intent: TypingIntent): Promise<void> {
  const first = await intent.socket.request('stop-typing', { guid: chatGuid });
  if (!stillLatestTypingIntent(chatGuid, intent)) return;
  if (first.kind === 'ack' && confirmedTypingAck(first.response, false)) {
    retireTypingIntent(chatGuid, intent);
    return;
  }
  if (first.kind === 'ack' && !retryableTypingStopAck(first.response)) {
    retireTypingIntent(chatGuid, intent);
    return;
  }

  await new Promise<void>((resolve) => setTimeout(resolve, TYPING_STOP_RETRY_DELAY_MS));
  if (
    !stillLatestTypingIntent(chatGuid, intent) ||
    intent.isTyping ||
    !intent.accountLease.isCurrent()
  ) {
    retireTypingIntent(chatGuid, intent);
    return;
  }

  // A foreground reconnect can replace the service without replacing the account. Reacquire it
  // only while the START's exact account lease is current; an account switch invalidates that
  // lease synchronously and can never receive this old chat's cleanup.
  const retrySocket = getSocket();
  if (retrySocket) await retrySocket.request('stop-typing', { guid: chatGuid });
  retireTypingIntent(chatGuid, intent);
}

/** Send only a separately supported typing action; RCS still has no stop-typing command. */
export function sendTyping(chatGuid: string, isTyping: boolean): void {
  if (chatGuid.startsWith('RCS;-;')) {
    if (!isTyping || !sessionAccessors.acceptsRcsChat(chatGuid)) return;
    const fs = useFeatureSettingsStore.getState();
    if (!fs.sendTypingIndicators) return;
    const socket = getSocket();
    if (!socket?.connected) return;
    socket.emit('start-typing', { guid: chatGuid });
    return;
  }

  const imessageGuidParts = chatGuid.split(';-;');
  const validImessageGuid =
    (chatGuid.startsWith('iMessage;-;') || chatGuid.startsWith('any;-;')) &&
    imessageGuidParts.length === 2 &&
    (imessageGuidParts[1]?.length ?? 0) > 0;
  if (!validImessageGuid) return;

  if (isTyping) {
    if (!sessionAccessors.imessageTypingEnabled()) return;
    const fs = useFeatureSettingsStore.getState();
    if (!fs.sendTypingIndicators) return;
    const socket = getSocket();
    const accountLease = captureRealtimeDeliveryLease();
    if (!socket?.connected || !accountLease.isCurrent()) return;
    const intent = installTypingIntent(chatGuid, true, socket, accountLease);
    if (!intent) return;
    socket.emit('start-typing', { guid: chatGuid });
    return;
  }

  // STOP is idempotent cleanup. Once a START may have escaped, a later capability/setting change
  // must not strand the remote typing indicator. The captured account lease fences every attempt.
  const previous = latestTypingIntent.get(chatGuid);
  if (!previous?.isTyping) return;
  const accountLease = previous.accountLease;
  if (!accountLease.isCurrent()) {
    retireTypingIntent(chatGuid, previous);
    return;
  }
  const socket = getSocket() ?? previous.socket;
  if (!socket) return;
  const intent = installTypingIntent(chatGuid, false, socket, accountLease);
  if (!intent) return;
  void stopImessageTyping(chatGuid, intent);
}

type FeatureSettings = ReturnType<typeof useFeatureSettingsStore.getState>;

/**
 * The feature settings, guaranteed to reflect what the user actually chose.
 *
 * Headlessly (a notification action on a killed app) no UI boot effect ever seeded this store, so
 * every flag sits at its MODULE DEFAULT — and both flags that gate the read receipt default to ON.
 * Reading them raw would tell the other party you read the message on behalf of someone who
 * switched receipts off. Gated on `hydrated` so it touches kv at most once per JS context, mirroring
 * `dispatchRealtimeEvent`; in the foreground it is already hydrated and this costs nothing.
 */
async function hydratedFeatureSettings(): Promise<FeatureSettings> {
  const fs = useFeatureSettingsStore.getState();
  if (!fs.hydrated) await fs.hydrate();
  return useFeatureSettingsStore.getState();
}

type MarkReadTarget =
  | { readonly chatExists: false; readonly newestReceivedGuid: null }
  | { readonly chatExists: true; readonly newestReceivedGuid: string | null };

/** One authorized client for the optional best-effort server read receipt. */
export interface ReadReceiptTransport {
  readonly http: HttpClient;
  isCurrent(): boolean;
  /** Exact pairing epoch captured from this transport's authoritative ServerInfo. */
  readonly rcsProviderEpoch?: string | null;
  /** Required for RCS: proves this exact conversation still belongs to the current pairing. */
  acceptsRcsChat?(chatGuid: string): boolean;
  /**
   * This transport's own server answer for the narrow iMessage read-state capability. A killed-app
   * task sets it because it never hydrates the session; when it is absent, the live session decides.
   */
  readonly imessageReadStateEnabled?: boolean;
}

export interface MarkReadOptions {
  /**
   * Resolve the exact transport used by a best-effort receipt, only after the local marker commits
   * and only when receipts are enabled. When supplied, the iMessage capability check waits for it,
   * and a server answer it carries overrides the session.
   */
  resolveReceiptTransport?: () => Promise<ReadReceiptTransport | null>;
}

/** Resolve the complete local mark-read target without observing another owner's partial work. */
function resolveMarkReadTargetWithinTransaction(
  context: DbTransactionContext,
  chatGuid: string,
): Promise<MarkReadTarget> {
  return runInTransactionContext(context, async (db) => {
    const chatId = await getChatIdByGuid(db, chatGuid);
    if (chatId == null) return { chatExists: false, newestReceivedGuid: null } as const;
    return {
      chatExists: true,
      newestReceivedGuid: await getNewestReceivedGuid(db, chatId),
    } as const;
  });
}

/**
 * Mark a chat read locally, and send the server read receipt ONLY when the "Send Read Receipts"
 * toggle is on. The read marker is local state, so it is written for every chat, including RCS
 * history from an older Google pairing and a killed-app wake that cannot reach the server. Only the
 * RCS receipt needs current pairing authority: it addresses a provider id the server may reuse.
 */
export function markRead(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
  options: MarkReadOptions = {},
): Promise<void> {
  const isRcs = chatGuid.startsWith('RCS;-;');
  const readStateSync = isIMessageReadStateGuid(chatGuid)
    ? reserveReadStateSync(accountLease.generation, chatGuid)
    : null;
  const action = runChatAction(accountLease, async (activeLease) => {
    let receiptTransport: ReadReceiptTransport | null = null;
    let expectedRcsEpoch: string | null = null;
    let rcsAuthorityRevoked = false;
    const rcsAuthorityIsCurrent = (): boolean => {
      if (!isRcs) return true;
      if (rcsAuthorityRevoked) return false;
      let current = false;
      try {
        current =
          expectedRcsEpoch != null &&
          parseRcsChatGuid(chatGuid)?.providerEpoch === expectedRcsEpoch &&
          receiptTransport?.rcsProviderEpoch === expectedRcsEpoch &&
          receiptTransport.isCurrent() &&
          receiptTransport.acceptsRcsChat?.(chatGuid) === true;
      } catch {
        current = false;
      }
      if (!current) rcsAuthorityRevoked = true;
      return current;
    };
    // ensureDatabase, never getDatabase: the tray's "Mark as read" button runs HEADLESS on a
    // killed-app wake, where no React tree ever mounted, boot() never ran and the eager accessor
    // throws "Database not initialized". That rejection escaped the whole action handler, so the
    // notification wasn't even cleared — the button looked completely dead, but only when the app
    // had been killed, which is exactly when the button is most useful.
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    const target = await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        const resolved = await resolveMarkReadTargetWithinTransaction(context, chatGuid);
        assertChatActionLease(activeLease);
        // Even an outgoing-only chat can carry a deliberate mark-as-unread stamp. Writing null is
        // still necessary there: it clears that stamp so this device's badge changes before any
        // optional server request.
        await setLastReadMessageGuidWithinTransaction(
          context,
          chatGuid,
          resolved.newestReceivedGuid,
        );
        assertChatActionLease(activeLease);
        return resolved;
      },
      () => activeLease.isCurrent(),
    );
    assertChatActionLease(activeLease);
    if (!target.chatExists) return;
    const isIMessage = isIMessageReadStateGuid(chatGuid);
    if (!isRcs && !isIMessage) return;
    // A killed-app notification action never hydrates the session, so the transport it resolves
    // reports the iMessage capability from its own server answer (review M199). Until then, only a
    // caller without such a transport can rule the receipt out from the session.
    const imessageReadStateEnabled = (): boolean =>
      receiptTransport?.imessageReadStateEnabled ?? sessionAccessors.imessageReadStateEnabled();
    const sessionRulesOutIMessage = (): boolean =>
      !options.resolveReceiptTransport && !sessionAccessors.imessageReadStateEnabled();
    if (isIMessage && sessionRulesOutIMessage()) return;

    let fs: FeatureSettings;
    try {
      fs = await hydratedFeatureSettings();
    } catch {
      // An unreadable persisted preference is not permission to disclose read state.
      return;
    }
    assertChatActionLease(activeLease);
    // Hydration deliberately leaves `hydrated=false` on a DB/read failure. The module defaults are
    // enabled for normal first use, but they are not proof of the user's persisted privacy choice.
    if (!fs.hydrated || !fs.sendReadReceipts) return;
    if (isIMessage && sessionRulesOutIMessage()) return;

    if (isRcs) {
      // A killed-process notification action has no hydrated foreground ServerInfo, so RCS
      // authority is captured from the authenticated task transport. Without it, no receipt.
      try {
        if (options.resolveReceiptTransport) {
          receiptTransport = await options.resolveReceiptTransport();
        } else {
          const rcsProviderEpoch = sessionAccessors.rcsProviderEpoch();
          receiptTransport = {
            http: accountHttp(activeLease),
            isCurrent: () => activeLease.isCurrent(),
            rcsProviderEpoch,
            acceptsRcsChat: (guid) => sessionAccessors.acceptsRcsChat(guid),
          };
        }
      } catch {
        return;
      }
      expectedRcsEpoch = receiptTransport?.rcsProviderEpoch ?? null;
      if (!activeLease.isCurrent() || !rcsAuthorityIsCurrent()) return;
    }
    const receiptIsCurrent = (): boolean => activeLease.isCurrent() && rcsAuthorityIsCurrent();

    if (!receiptTransport) {
      try {
        receiptTransport = options.resolveReceiptTransport
          ? await options.resolveReceiptTransport()
          : { http: accountHttp(activeLease), isCurrent: () => activeLease.isCurrent() };
      } catch {
        // The local iMessage marker is authoritative for this device. Vault/client discovery is
        // best-effort and must never restore the unread badge.
        return;
      }
    }
    if (!receiptIsCurrent() || !receiptTransport?.isCurrent()) return;
    if (isIMessage && !imessageReadStateEnabled()) return;
    try {
      if (isIMessage && readStateSync) {
        await readStateSync.run(async () => {
          const currentSettings = useFeatureSettingsStore.getState();
          if (
            !currentSettings.hydrated ||
            !currentSettings.sendReadReceipts ||
            !activeLease.isCurrent() ||
            !receiptTransport.isCurrent() ||
            !imessageReadStateEnabled()
          ) {
            return;
          }
          await chatsApi.markChatRead(receiptTransport.http, chatGuid);
        });
      } else {
        const currentSettings = useFeatureSettingsStore.getState();
        if (!currentSettings.hydrated || !currentSettings.sendReadReceipts) return;
        if (isRcs && !receiptIsCurrent()) return;
        await chatsApi.markChatRead(receiptTransport.http, chatGuid);
      }
    } catch {
      // Offline / not connected — the local marker still clears the badge.
    }
  });
  return action.finally(() => readStateSync?.releaseWithoutSync());
}

/** Mark a chat unread locally, then best-effort sync a separately supported iMessage bridge. */
export function markUnread(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const readStateSync = isIMessageReadStateGuid(chatGuid)
    ? reserveReadStateSync(accountLease.generation, chatGuid)
    : null;
  const action = runChatAction(accountLease, async (activeLease) => {
    // ensureDatabase for the same headless reason as markRead — this shares the
    // notification-action and background-event code paths.
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    const markedUnreadAt = Date.now();
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await setChatUnreadLocalWithinTransaction(context, chatGuid, markedUnreadAt);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
    assertChatActionLease(activeLease);
    if (!isIMessageReadStateGuid(chatGuid) || !sessionAccessors.imessageReadStateEnabled()) {
      return;
    }
    try {
      await readStateSync?.run(async () => {
        if (!activeLease.isCurrent() || !sessionAccessors.imessageReadStateEnabled()) return;
        await chatsApi.markChatUnread(accountHttp(activeLease), chatGuid);
      });
    } catch {
      // The local marker remains authoritative for this device when Mac sync is unavailable.
    }
    assertChatActionLease(activeLease);
  });
  return action.finally(() => readStateSync?.releaseWithoutSync());
}

/**
 * Delete a conversation from this device.
 *
 * `deleteChatLocal` does the DB half. This wrapper owns the half the repository CANNOT do, because
 * `src/db` must stay free of both React and native modules: retiring the chat's state that lives
 * OUTSIDE the database and would otherwise keep acting on its own — the reminders' OS alarms and
 * the Mac's copy of any server-backed scheduled message. Both are the same shape of problem: a
 * local row delete doesn't cancel them, it just destroys the only handle we had for cancelling
 * them. Same lazy import + own try/catch as `forget()`.
 *
 * The chat delete itself is UNCONDITIONAL and goes FIRST: reaching the native bridge or the server
 * must never be what stops — or delays — a delete the user asked for. Both list call sites invoke
 * this as `void deleteChat(...)` with no spinner, so anything awaited ahead of the local delete is
 * time the tile sits in the inbox looking like the tap did nothing; `cancelServerScheduledForChat`
 * is a sequential per-row HTTP loop, and against a server that accepts the connection and then
 * blackholes it (a dead tunnel — not the same as offline, where fetch rejects at once) each row
 * costs the full request timeout. Ordering it after the delete costs nothing: `deleteChatLocal`
 * deliberately PRESERVES pending server-backed scheduled rows (that is the whole reason this
 * wrapper exists), and reminders are not touched by it at all, so both helpers still find exactly
 * the rows they need. What IS conditional is dropping the rows that track that external state —
 * see the two helpers.
 *
 * THE ONE THING THAT MUST BE READ BEFORE THE DELETE is the list of attachment guids. It names both
 * completed and in-flight transfers; the message cascade otherwise destroys the only way to cancel
 * them. Physical files are retired later by exact ledger path, never by recursively deleting these
 * GUID directories. The lookup is one indexed local SELECT — no native bridge or network.
 */
export function deleteChat(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, (activeLease) => deleteChatForAccount(chatGuid, activeLease));
}

const DELETED_CHAT_CACHE_MAX_PASSES =
  Math.ceil(ATTACHMENT_CACHE_RECOVERY_MAX_FILES / ATTACHMENT_CACHE_RECOVERY_BATCH_FILES) + 2;

async function deleteChatForAccount(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  const db = await ensureDatabase();
  assertChatActionLease(accountLease);
  const attachmentCacheScope = createAttachmentCacheAccountScope(accountLease);
  // Never let this stop the delete: with no candidates the files are simply left behind, which is
  // the state the delete had before this existed.
  const attachmentGuids = await listChatAttachmentGuids(db, chatGuid).catch((e) => {
    if (accountLease.isCurrent()) {
      logger.warn('[chats] could not list downloaded attachments for deleted chat', e);
    }
    return [] as string[];
  });
  assertChatActionLease(accountLease);

  let deleteFailed = false;
  let deleteError: unknown;
  try {
    // Stop queued/active bytes before the purge removes their ownership rows. The final guarded
    // path write is still the backstop for a native result that wins this synchronous cancel race.
    cancelAttachmentDownloads(attachmentGuids, accountLease.generation);
    await deleteChatLocal(db, chatGuid, Date.now(), () => accountLease.isCurrent());
    assertChatActionLease(accountLease);
    await attachmentCacheCoordinator
      .retireInactiveEntries(db, { scope: attachmentCacheScope })
      .catch((e) => logger.warn('[chats] exact attachment cache cleanup deferred', e));
    await attachmentCacheCoordinator
      .drainDueRetirements(db, { scope: attachmentCacheScope })
      .catch((e) => logger.warn('[chats] attachment cache recovery deferred', e));
    assertChatActionLease(accountLease);
  } catch (error) {
    deleteFailed = true;
    deleteError = error;
  }

  // Preserve the original cleanup-on-delete-failure behavior while preventing an invalidated
  // account from continuing into native/network side effects after teardown has begun.
  assertChatActionLease(accountLease);
  try {
    // `finally`, so moving the local delete first cannot cost the external cleanup its run. If the
    // delete fails part-way the chat is already tombstoned, and an uncancelled server-backed
    // scheduled send would fire into that hidden thread and un-hide it; if it failed before the
    // tombstone, this is exactly what the previous ordering did anyway. None of these helpers throws
    // (each swallows its own failures), so nothing here can mask the original error.
    //
    // The tray cancel goes FIRST because it is the only one that is both instant (a local native
    // call) and user-visible: `cancelServerScheduledForChat` is a sequential per-row HTTP loop that
    // costs a full request timeout per row against a blackholing tunnel, and a notification for the
    // conversation the user just deleted must not survive that.
    await cancelChatNotification(chatGuid, accountLease);
    assertChatActionLease(accountLease);
    // The only server-facing step: an RCS chat outside the active pairing keeps its local delete
    // but must not address a possibly reused provider id at the server.
    if (captureRcsServerStepGuard(chatGuid)?.()) {
      await cancelServerScheduledForChat(db, chatGuid, accountLease);
    }
    assertChatActionLease(accountLease);
    await cancelRemindersForChat(db, chatGuid, accountLease);
    assertChatActionLease(accountLease);
    // Finish any purge that never got to complete — a previous delete killed mid-loop, or this
    // one's own loop if that is what threw. One query when there is nothing to resume (the norm).
    await resumeChatPurges(db, () => accountLease.isCurrent()).catch((e) => {
      if (accountLease.isCurrent()) logger.warn('[chats] purge resume failed', e);
    });
    assertChatActionLease(accountLease);
    // One coordinator pass stops at its batch cap, so a large chat kept the rest of its files until
    // the next startup scan. Repeat until a pass finds nothing, bounded by the cache's own file
    // cap (review M149).
    for (let pass = 0; pass < DELETED_CHAT_CACHE_MAX_PASSES; pass += 1) {
      const retired = await attachmentCacheCoordinator
        .retireInactiveEntries(db, { scope: attachmentCacheScope })
        .catch((e) => {
          logger.warn('[chats] resumed-purge cache cleanup deferred', e);
          return null;
        });
      await attachmentCacheCoordinator
        .drainDueRetirements(db, { scope: attachmentCacheScope })
        .catch((e) => logger.warn('[chats] resumed-purge exact delete deferred', e));
      assertChatActionLease(accountLease);
      if (retired?.status !== 'complete' || retired.attempted === 0) break;
    }
  } finally {
    if (deleteFailed) throw deleteError;
  }
}

/**
 * Dismiss the deleted chat's notification from the tray.
 *
 * A posted notification is SYSTEM state keyed by chat guid that outlives every row this delete
 * touches — the same shape of problem as a reminder's alarm. Left up, it still shows the sender and
 * the message preview of a conversation the user just deleted, and tapping it routes straight into
 * the hidden thread. Own try/catch + lazy import so the native bridge can never cost the delete.
 */
async function cancelChatNotification(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  try {
    const { cancelForChat } = await import('./notifications/notifeeService');
    assertChatActionLease(accountLease);
    await cancelForChat(chatGuid, accountLease);
    assertChatActionLease(accountLease);
  } catch (e) {
    if (e === STALE_CHAT_ACTION || !accountLease.isCurrent()) throw STALE_CHAT_ACTION;
    logger.warn('[chats] tray notification cancel failed for deleted chat', e);
  }
}

/**
 * Cancel the OS alarms of this chat's reminders and drop ONLY the rows whose cancellation actually
 * succeeded.
 *
 * A trigger notification is SYSTEM state that outlives its row: an uncancelled one still fires
 * hours later, showing the deleted message's preview on the lock screen and deep-linking into a
 * conversation that is no longer in the inbox. Deleting the row anyway makes that alarm
 * UNSTOPPABLE — the Reminders screen and `forget()` both enumerate via `listReminders`, so once the
 * row is gone nothing can ever find it again. So a row survives its chat exactly when its alarm
 * did; keeping it costs a stale entry on the Reminders screen, which is precisely the affordance
 * needed to cancel the thing. (It leaks no preview text the still-armed alarm doesn't already hold.)
 *
 * `allSettled`, not `all`: one unreachable trigger must not cost the other reminders their delete.
 */
async function cancelRemindersForChat(
  db: AppDatabase,
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  try {
    const pending = (await listReminders(db)).filter((r) => r.chatGuid === chatGuid);
    assertChatActionLease(accountLease);
    if (pending.length === 0) return;
    const { cancelReminderNotification } = await import('./notifications/notifeeService');
    assertChatActionLease(accountLease);
    const settled = await Promise.allSettled(
      pending.map(async (r) => {
        assertChatActionLease(accountLease);
        await cancelReminderNotification(r.notificationId);
        return r.notificationId;
      }),
    );
    assertChatActionLease(accountLease);
    for (const s of settled) {
      assertChatActionLease(accountLease);
      if (s.status === 'fulfilled') {
        await withDbTransaction(
          db,
          (context) => deleteReminderByNotificationIdWithinTransaction(context, s.value),
          () => accountLease.isCurrent(),
        );
        assertChatActionLease(accountLease);
      }
    }
  } catch (e) {
    if (e === STALE_CHAT_ACTION || !accountLease.isCurrent()) throw STALE_CHAT_ACTION;
    // Reaching the notifee module at all failed (or the row read did) — every reminder keeps both
    // its alarm and its row, which is the recoverable state.
    logger.warn('[chats] reminder cancel failed for deleted chat', e);
  }
}

/**
 * Cancel this chat's SERVER-BACKED scheduled messages on the Mac, then drop the rows the Mac
 * confirmed. Runs AFTER `deleteChatLocal`, which is safe because that call deliberately leaves
 * pending server-backed rows behind — they are the only rows left here to find.
 *
 * A server-backed row (`serverId` set — the default: `scheduleTextMessage` POSTs first and only
 * falls back to local-only for a reply target / recurrence / failure) is fired by the MAC. The
 * on-device ticker deliberately skips it, so deleting the local row cancels nothing: the message is
 * still sent at its time, and the resulting `new-message` un-hides the conversation the user just
 * deleted. Worse, `cancelScheduled` needs that row's `serverId`, so dropping it blind leaves no way
 * to stop it until a Scheduled-screen refresh happens to re-sync it back.
 *
 * A row is only removed once the server confirms; a refused cancel keeps it, exactly as
 * `cancelScheduled` does, so the user retains the handle on the Scheduled screen (which lists
 * pending rows without joining `chats`, so a hidden chat doesn't hide them). Per-row try/catch:
 * one unreachable server call must not skip the rest, nor block the delete.
 */
async function cancelServerScheduledForChat(
  db: AppDatabase,
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  let pending: Awaited<ReturnType<typeof listScheduledByChat>>;
  try {
    pending = await listScheduledByChat(db, chatGuid);
    assertChatActionLease(accountLease);
  } catch (e) {
    if (e === STALE_CHAT_ACTION || !accountLease.isCurrent()) throw STALE_CHAT_ACTION;
    logger.warn('[chats] could not read scheduled messages for deleted chat', e);
    return;
  }
  for (const row of pending) {
    assertChatActionLease(accountLease);
    const serverId = row.serverId;
    if (serverId == null) continue; // local-only: deleteChatLocal dropping the row IS the cancel
    try {
      await scheduledApi.deleteScheduled(accountHttp(accountLease), serverId);
      assertChatActionLease(accountLease);
      await withDbTransaction(
        db,
        (context) => deleteScheduledWithinTransaction(context, row.id),
        () => accountLease.isCurrent(),
      );
      assertChatActionLease(accountLease);
    } catch (e) {
      if (e === STALE_CHAT_ACTION || !accountLease.isCurrent()) throw STALE_CHAT_ACTION;
      logger.warn('[chats] server scheduled-message cancel failed; keeping the local row', e);
    }
  }
}
