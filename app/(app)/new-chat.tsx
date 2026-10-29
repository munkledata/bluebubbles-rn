import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { checkIMessageAvailability } from '@core/api/endpoints/handles';
import { ApiError } from '@core/api/errors';
import { MAX_RCS_ATTACHMENT_UPLOAD_BYTES } from '@core/models/serverInfo';
import { currentRcsProviderEpoch } from '@core/rcs/providerIdentity';
import { canonicalRecipientAddress } from '@core/recipientAddress';
import { formatChatDate } from '@utils/date';
import { getDatabase } from '@db/database';
import {
  findChatsByParticipantAddresses,
  type ExistingChatMatch,
  type ShareIntakeManifestIdentity,
  type ShareIntakeNewChatPlan,
} from '@db/repositories';
import { addTextToChatDraft, createNewChat, http } from '@/services';
import type { NewChatService } from '@/services/chatActions';
import {
  consumeShareIntakeBatchIfComplete,
  discardShareIntakeItem,
  discardShareIntakeBatch,
  drainShareIntake,
  isShareIntakeFileSettled,
  isShareIntakeNewChatRetryWindowOpen,
  isShareIntakeReceiptComplete,
  prepareShareIntakeNewChatPlan,
  readShareIntakeReceipt,
} from '@/services/share/shareIntake';
import {
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { send, sendImages } from '@/services/send';
import { logger } from '@core/secure';
import { consumeForwardAttachmentHandoff } from '@features/conversations/forwardAttachmentHandoff';
import { observeQueueAdmission } from '@features/conversations/observeQueueAdmission';
import { useContactSearch } from '@features/contacts/useContactSearch';
import { useRcsMutationEnabled, useSessionStore } from '@state/sessionStore';
import { useShareIntentStore, type SharedAttachment } from '@state/shareIntentStore';
import { Icon, readableTextOn, Screen, ScreenHeader, useTheme } from '@ui';
import { ContactSuggestionList } from '@ui/ContactSuggestionList';
import { presentSendIssue } from '@ui/conversations/sendNotices';
import { useUnsavedChangesGuard } from '@ui/hooks/useUnsavedChangesGuard';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';
import { useShareBatchOwnership } from '@ui/hooks/useShareBatchOwnership';

/** A chosen recipient chip: an address plus its best display name. */
interface Recipient {
  address: string;
  name: string;
}

/**
 * PURE: does this raw typed string plausibly address someone? Deliberately loose — the server
 * is the real validator — but strict enough that a half-typed contact NAME ("Aar") never becomes
 * a recipient and starts a garbage chat. An email needs an `@` with text either side; a phone
 * needs at least 7 digits (shortcodes are 5-6, but those aren't addressable outbound here).
 */
function looksLikeAddress(raw: string): boolean {
  if (raw.length === 0) return false;
  if (raw.includes('@')) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw);
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 7 && /^[+\d\s()./-]+$/.test(raw);
}

/**
 * The address a recipient chip keeps: the standard form (lowercased email, or a `+` number using
 * the owner's +1 rule) when there is one, else the exact text, which only an exact match can use.
 */
function recipientAddressFor(raw: string): string {
  return canonicalRecipientAddress(raw) ?? raw.trim();
}

/**
 * Match the first iMessage mutation's explicit destination contract. Chips already hold the
 * standard form, so a number still without a country code here is one the +1 rule couldn't prove.
 */
function looksLikeIMessageAddress(raw: string): boolean {
  if (raw.includes('@')) return raw.length <= 254 && looksLikeAddress(raw);
  return /^\+[1-9][0-9]{1,14}$/.test(raw);
}

/** "Weekend · Yesterday": an existing chat's name (or its kind) and when it was last active. */
function existingChatLabel(match: ExistingChatMatch): string {
  const name = match.name ?? (match.isGroup ? 'Group conversation' : 'iMessage conversation');
  const when = formatChatDate(match.latestMessageDate);
  return when ? `${name} · ${when}` : name;
}

const MAX_INITIAL_IMESSAGE_TEXT_BYTES = 64 * 1024;

/** The SMS green the old app used for a recipient who isn't on iMessage. */
const NOT_ON_IMESSAGE_GREEN = '#34C759';

/** Leaving mid-send would abandon the send's result, so Back waits until the send settles. */
const SEND_IN_PROGRESS = {
  title: 'Still starting the conversation',
  message: 'Wait for the send to finish before leaving this screen.',
} as const;

/** Only these paired-server status/type pairs are known to reject before helper dispatch. */
function isKnownPreDispatchNewChatError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 400) {
    return (
      error.serverErrorType === 'validation' || error.serverErrorType === 'idempotency_key_invalid'
    );
  }
  return (
    error.status === 503 &&
    (error.serverErrorType === 'imessage_new_chat_unavailable' ||
      error.serverErrorType === 'idempotency_capacity_exhausted' ||
      error.serverErrorType === 'idempotency_persistence_unavailable')
  );
}

/** Start a new conversation: pick recipient chips + an initial message. */
export default function NewChatScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  // Bind this mounted composer (including its delayed Start callback) to the account that opened
  // it. Capturing at tap time would let a stale A screen silently adopt B after reconnect.
  const accountLease = useScreenAccountLease();
  const [accountInvalidated, setAccountInvalidated] = useState(() => !accountLease.isCurrent());
  // A forwarded message pre-fills the composer. File paths stay out of this public route: the
  // only attachment parameter is an opaque, one-time key into a process-local handoff.
  const { forwardText, forwardAttachmentHandoff, shareBatch } = useLocalSearchParams<{
    forwardText?: string;
    forwardAttachmentHandoff?: string;
    shareBatch?: string;
  }>();
  const [initialForwardHandoff] = useState(forwardAttachmentHandoff);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [query, setQuery] = useState('');
  // Capture only the exact native claim named by this route. A stale/external URL cannot consume
  // whichever share happens to be ambient in the process.
  const [initialContent] = useState(() => {
    const { batchId, createdAtMs, text, files } = useShareIntentStore.getState();
    const ownsShare = typeof shareBatch === 'string' && batchId === shareBatch;
    return {
      batchId: ownsShare ? batchId : null,
      identity:
        ownsShare && batchId && createdAtMs != null
          ? ({
              batchId,
              nativeCreatedAtMs: createdAtMs,
              hasText: text !== null,
              fileCount: files.length,
            } satisfies ShareIntakeManifestIdentity)
          : null,
      message: (forwardText ?? '') || (ownsShare ? text : null) || '',
      attachments: ownsShare ? files : [],
    };
  });
  useShareBatchOwnership(initialContent.batchId);
  const [message, setMessage] = useState(initialContent.message);
  // A narrow live server capability admits new iMessage chats without restoring broad Private API.
  // Preserve the user's explicit choice if that capability disappears; never silently switch the
  // destination to another service while the draft is open.
  const rcsEnabled = useRcsMutationEnabled();
  const rcsAttemptOwnershipSupported = useSessionStore(
    (s) => s.serverInfo?.supports_rcs_send_attempt_ownership === true,
  );
  const imessageEnabled = useSessionStore((s) => s.serverInfo?.supports_imessage_new_chat === true);
  const exactIMessageTextSupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_plain_text === true,
  );
  // Advisory only: the server's read-only lookup colours an iMessage recipient blue (reachable) or
  // green (not on iMessage). It never blocks Start or switches the service.
  const availabilitySupported = useSessionStore(
    (s) => s.serverInfo?.supports_imessage_availability === true,
  );
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  // Each address is looked up at most once per mounted screen; a removed and re-added chip reuses it.
  const probedRef = useRef(new Set<string>());
  const [requestedService, setRequestedService] = useState<NewChatService | null>(null);
  const selectedService: NewChatService | null =
    requestedService ?? (rcsEnabled ? 'RCS' : imessageEnabled ? 'iMessage' : null);
  // Once a default becomes available, pin it for this draft. A later capability refresh must not
  // silently change a prepared RCS message into an iMessage (or the reverse).
  useEffect(() => {
    if (!requestedService && selectedService) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Pin the first available service for the lifetime of this authored draft.
      setRequestedService(selectedService);
    }
  }, [requestedService, selectedService]);
  const serviceAvailable =
    selectedService === 'RCS' ? rcsEnabled : selectedService === 'iMessage' && imessageEnabled;
  const showServiceChoice =
    (rcsEnabled || requestedService === 'RCS') &&
    (imessageEnabled || requestedService === 'iMessage');
  // The helper create route sends the first text itself. Reuse this identity on an ambiguous
  // response and retry of the same authored message rather than sending it a second time.
  const createAttemptsRef = useRef(new Map<string, string>());
  const [existingMatches, setExistingMatches] = useState<{
    recipientKey: string;
    matches: ExistingChatMatch[];
  } | null>(null);
  // The user's pick among several existing chats; a different recipient set drops it.
  const [pickedMatch, setPickedMatch] = useState<{ recipientKey: string; guid: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const submissionInFlightRef = useRef(false);
  // Native-owned share files remain replayable until this screen confirms durable send ownership.
  const [staged, setStaged] = useState<SharedAttachment[]>(
    initialContent.identity ? [] : initialContent.attachments,
  );
  const [shareResumeReady, setShareResumeReady] = useState(initialContent.identity === null);
  const [sharePlanPrepared, setSharePlanPrepared] = useState(false);
  const forwardConsumedRef = useRef(false);
  const abandonedRef = useRef(false);
  const forwardProtectionReleaseRef = useRef<(() => void) | null>(null);
  const forwardProtectionReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    abandonedRef.current = false;
    return () => {
      abandonedRef.current = true;
    };
  }, []);

  // The lease itself is deliberately non-reactive. Subscribe to its synchronous invalidation so
  // an account-A form is removed from the host tree instead of waiting for route teardown.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountInvalidated(true);
        Keyboard.dismiss();
      }),
    [accountLease],
  );

  // Retained native/test callbacks must consult the lease itself: accountInvalidated drives the
  // host render, but an old closure could have captured its earlier false value.
  const screenInteractionIsCurrent = (): boolean =>
    accountLease.isCurrent() && shareResumeReady && !submissionInFlightRef.current;
  const accountUnavailable = accountInvalidated || !accountLease.isCurrent();

  useEffect(() => {
    if (accountUnavailable || !availabilitySupported || selectedService !== 'iMessage') return;
    if (!accountLease.isCurrent()) return;
    for (const r of recipients) {
      if (probedRef.current.has(r.address) || !looksLikeIMessageAddress(r.address)) continue;
      probedRef.current.add(r.address);
      void checkIMessageAvailability(http, r.address)
        .then((available) => {
          if (accountLease.isCurrent()) {
            setAvailability((cur) => ({ ...cur, [r.address]: available }));
          }
        })
        .catch(() => {
          // Helper down, busy, or an older server: leave the chip neutral.
        });
    }
  }, [accountLease, accountUnavailable, availabilitySupported, recipients, selectedService]);
  const showAvailability = availabilitySupported && selectedService === 'iMessage';
  const anyNotOnIMessage =
    showAvailability && recipients.some((r) => availability[r.address] === false);

  // The synchronous subscription covers live retirement. This layout pass also dismisses an IME
  // when the route first commits with an already-retired account lease.
  useLayoutEffect(() => {
    if (accountUnavailable) Keyboard.dismiss();
  }, [accountUnavailable]);

  // Adopt the forward handoff only after React commits this screen. Every file is re-statted while
  // its stage-time protection is still held; the lease then survives until a successful durable
  // send or unmount. React development Strict Mode immediately cleans up and re-runs mount effects,
  // so cleanup is deferred one task and cancelled by that second setup instead of briefly unpinning.
  useEffect(() => {
    if (!accountLease.isCurrent()) return;
    if (forwardProtectionReleaseTimerRef.current != null) {
      clearTimeout(forwardProtectionReleaseTimerRef.current);
      forwardProtectionReleaseTimerRef.current = null;
    }
    if (!forwardConsumedRef.current) {
      let releaseForwardProtection: (() => void) | null = null;
      const forwarded = consumeForwardAttachmentHandoff(initialForwardHandoff, {
        ownedRoots: [Paths.cache.uri, Paths.document.uri],
        fileInfo: (uri) => {
          const f = new File(uri);
          return { exists: f.exists, size: f.size };
        },
        onProtectionLease: (release) => {
          releaseForwardProtection = release;
        },
      });
      forwardConsumedRef.current = true;
      forwardProtectionReleaseRef.current = releaseForwardProtection;
      if (forwarded.length > 0) {
        // The handoff is an external process-local source. Publish its committed result from the
        // next microtask instead of synchronously cascading another render inside this effect.
        void Promise.resolve().then(() => {
          setStaged((current) => {
            const seen = new Set<string>();
            return [...forwarded, ...current].filter((file) =>
              seen.has(file.uri) ? false : (seen.add(file.uri), true),
            );
          });
        });
      }
    }

    return () => {
      const release = forwardProtectionReleaseRef.current;
      if (!release) return;
      const timer = setTimeout(() => {
        if (forwardProtectionReleaseTimerRef.current !== timer) return;
        forwardProtectionReleaseTimerRef.current = null;
        if (forwardProtectionReleaseRef.current === release) {
          forwardProtectionReleaseRef.current = null;
          release();
        }
      }, 0);
      forwardProtectionReleaseTimerRef.current = timer;
    };
  }, [accountLease, initialForwardHandoff]);

  const releaseForwardProtection = (): void => {
    if (forwardProtectionReleaseTimerRef.current != null) {
      clearTimeout(forwardProtectionReleaseTimerRef.current);
      forwardProtectionReleaseTimerRef.current = null;
    }
    const release = forwardProtectionReleaseRef.current;
    forwardProtectionReleaseRef.current = null;
    release?.();
  };

  const hasUnsavedChanges =
    !accountUnavailable &&
    (initialContent.identity !== null ||
      recipients.length > 0 ||
      query.length > 0 ||
      message.length > 0 ||
      staged.length > 0);
  const { navigateWithoutPrompt } = useUnsavedChangesGuard({
    enabled: hasUnsavedChanges,
    title: 'Discard new message?',
    message: 'The recipients, message, and attachments in this draft will be cleared.',
    blocked: busy ? SEND_IN_PROGRESS : null,
    onDiscard: async () => {
      if (submissionInFlightRef.current || busy) {
        showDialog(SEND_IN_PROGRESS.title, SEND_IN_PROGRESS.message);
        return false;
      }
      if (initialContent.batchId) {
        try {
          const discarded = await discardShareIntakeBatch(initialContent.batchId, {
            lease: accountLease,
            drainNext: false,
          });
          if (!discarded || !accountLease.isCurrent()) return false;
        } catch (error) {
          if (!accountLease.isCurrent()) return false;
          logger.warn('[new-chat] shared batch discard failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          showDialog('Shared item', 'Gator could not safely discard this share. Try again.');
          return false;
        }
      }
      abandonedRef.current = true;
      releaseForwardProtection();
      return true;
    },
    onAfterDiscardNavigation: () => {
      if (initialContent.batchId) void drainShareIntake();
    },
  });

  // Reconcile crash-safe receipts before exposing native files or allowing another /chat/new.
  // This must sit below useUnsavedChangesGuard: its memoized navigation function is referenced by
  // both the effect body and dependency list and cannot be read before that hook initializes it.
  useEffect(() => {
    const identity = initialContent.identity;
    if (!identity || !accountLease.isCurrent()) return;
    let active = true;
    let receipt: Awaited<ReturnType<typeof readShareIntakeReceipt>> = null;
    void runTrackedRealtimeWork(accountLease, async () => {
      receipt = await readShareIntakeReceipt(identity);
    })
      .then(async (outcome) => {
        if (outcome !== 'delivered' || !active || !accountLease.isCurrent()) return;
        if (receipt?.destination) {
          if (isShareIntakeReceiptComplete(receipt)) {
            const consumed = await consumeShareIntakeBatchIfComplete(identity, {
              lease: accountLease,
              drainNext: false,
            });
            if (!consumed || !active || !accountLease.isCurrent()) return;
            navigateWithoutPrompt(() =>
              router.replace(`/chat/${encodeURIComponent(receipt!.destination!.chatGuid)}`),
            );
            void drainShareIntake();
          } else {
            navigateWithoutPrompt(() =>
              router.replace(
                `/chat/${encodeURIComponent(receipt!.destination!.chatGuid)}?shareBatch=${encodeURIComponent(identity.batchId)}`,
              ),
            );
          }
          return;
        }
        if (receipt?.newChatPlan) {
          const plan = receipt.newChatPlan;
          setRecipients([{ address: plan.address, name: plan.address }]);
          setQuery('');
          setMessage(plan.body);
          setRequestedService(plan.service);
          setSharePlanPrepared(true);
        }
        const replayableShareAttachments = initialContent.attachments.filter(
          (file) =>
            file.shareItemIndex == null || !isShareIntakeFileSettled(receipt, file.shareItemIndex),
        );
        setStaged((current) => {
          const byUri = new Map(
            [
              ...current.filter((file) => file.origin !== 'share'),
              ...replayableShareAttachments,
            ].map((file) => [file.uri, file]),
          );
          return [...byUri.values()];
        });
        setShareResumeReady(true);
      })
      .catch((error: unknown) => {
        if (!active || !accountLease.isCurrent()) return;
        logger.warn('[new-chat] shared receipt reconciliation failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        showDialog(
          'Shared item',
          'Gator could not safely resume this share. Its files were not sent.',
        );
      });
    return () => {
      active = false;
    };
  }, [accountLease, initialContent, navigateWithoutPrompt, router]);

  const chosen = new Set(recipients.map((r) => r.address.toLowerCase()));

  // Already-chosen recipients are filtered out of the shared hook's suggestions.
  const suggestions = useContactSearch(query).filter(
    (c) => !chosen.has(recipientAddressFor(c.address).toLowerCase()),
  );

  // Offer local existing chats only where the stored participant is authoritative. Cached RCS
  // participant strings are presentation data (display name, formatted number, or opaque id), so
  // they can never choose a Google conversation; Start uses Google's find/create route.
  // Effect cleanup plus the exact recipient key prevent an older iMessage set from publishing its
  // matches, and the captured account lease prevents a retired route from adopting a result.
  const recipientKey = JSON.stringify([selectedService, recipients.map((r) => r.address)]);
  useEffect(() => {
    let active = true;
    if (
      recipients.length === 0 ||
      selectedService !== 'iMessage' ||
      accountUnavailable ||
      !accountLease.isCurrent()
    )
      return;
    void findChatsByParticipantAddresses(
      getDatabase(),
      recipients.map((r) => r.address),
      selectedService,
    )
      .then((matches) => {
        if (active && accountLease.isCurrent()) {
          setExistingMatches({ recipientKey, matches });
        }
      })
      .catch(() => {
        if (active && accountLease.isCurrent()) {
          setExistingMatches({ recipientKey, matches: [] });
        }
      });
    return () => {
      active = false;
    };
  }, [accountLease, accountUnavailable, recipients, recipientKey, selectedService]);
  const matches =
    !accountUnavailable &&
    shareResumeReady &&
    !sharePlanPrepared &&
    existingMatches?.recipientKey === recipientKey
      ? existingMatches.matches
      : [];
  // The newest chat is selected until the user picks another one from the list.
  const selectedMatch =
    matches.find(
      (match) => pickedMatch?.recipientKey === recipientKey && match.guid === pickedMatch.guid,
    ) ??
    matches[0] ??
    null;
  const existingGuid = selectedMatch?.guid ?? null;

  const addRecipient = (r: Recipient): void => {
    if (!screenInteractionIsCurrent() || sharePlanPrepared) return;
    if (chosen.has(r.address.toLowerCase())) return;
    setRecipients((prev) => [...prev, r]);
    setQuery('');
  };

  const removeRecipient = (address: string): void => {
    if (!screenInteractionIsCurrent() || sharePlanPrepared) return;
    setRecipients((prev) => prev.filter((r) => r.address !== address));
  };

  const removeStaged = async (file: SharedAttachment): Promise<void> => {
    if (!screenInteractionIsCurrent() || busy) return;
    const identity = initialContent.identity;
    if (identity && file.origin === 'share') {
      if (file.shareItemIndex == null) return;
      try {
        const outcome = await runTrackedRealtimeWork(accountLease, (lease) =>
          discardShareIntakeItem(
            {
              identity,
              itemIndex: file.shareItemIndex!,
              appliedAtMs: Date.now(),
            },
            () => lease.isCurrent(),
          ),
        );
        if (outcome !== 'delivered' || !accountLease.isCurrent()) return;
      } catch (error) {
        if (!accountLease.isCurrent()) return;
        logger.warn('[new-chat] shared attachment discard failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        showDialog('Shared item', 'Gator could not safely remove this shared file.');
        return;
      }
    }
    setStaged((prev) => prev.filter((candidate) => candidate.uri !== file.uri));
  };

  // Backspace on an empty input removes the last chip (iOS token-field behavior).
  const onKeyPress = (key: string): void => {
    if (!screenInteractionIsCurrent()) return;
    if (key === 'Backspace' && query.length === 0 && recipients.length > 0) {
      removeRecipient(recipients[recipients.length - 1]!.address);
    }
  };

  // The typed-but-uncommitted address, if it looks like one. Tapping "Start" must honour this:
  // commitRaw() is only wired to a trailing comma and onSubmitEditing, so a user who types a
  // number that ISN'T a saved contact and taps Start would otherwise hit `recipients.length > 0`
  // and get a silent no-op — no navigation, no error. Treating it as a pending recipient makes
  // Start work for an unsaved number, which is the whole point of a free-text "To:" field.
  // Raw text → recipient, or null when it isn't addressable / is already chosen. Shared by the
  // pending-recipient derivation and the comma handler so both agree on what counts.
  const rawToRecipient = (text: string): Recipient | null => {
    const raw = text.trim().replace(/,$/, '').trim();
    if (!looksLikeAddress(raw)) return null;
    const address = recipientAddressFor(raw);
    if (chosen.has(address.toLowerCase())) return null;
    // The chip shows the address Start will use, so a +1 the app assumed is visible.
    return { address, name: address };
  };

  const pendingRecipient = rawToRecipient(query);

  // Committing raw typed text (return key) as a chip, when it looks like an address.
  const commitRaw = (): void => {
    if (!screenInteractionIsCurrent()) return;
    if (!pendingRecipient) return;
    addRecipient(pendingRecipient);
  };

  /**
   * The comma key means "commit this recipient". It MUST resolve from the INCOMING text, not from
   * `query`: a PASTE delivers the whole address and the comma in ONE change event, so resolving
   * from the previous `query` (still empty) committed nothing AND — because the comma branch never
   * called setQuery — silently threw the pasted text away. Typing char-by-char hid this, since
   * `query` was already populated by the time the comma arrived.
   * When the text isn't addressable we keep it visible (minus the comma) rather than dropping it.
   */
  const onCommaCommit = (text: string): void => {
    if (!screenInteractionIsCurrent()) return;
    const rec = rawToRecipient(text);
    if (rec) {
      addRecipient(rec);
      setQuery('');
      return;
    }
    setQuery(text.replace(/,$/, ''));
  };

  // Recipients as they'd be at send time, including a still-uncommitted typed address.
  const effectiveRecipients = pendingRecipient ? [...recipients, pendingRecipient] : recipients;
  const imessageAddressValid =
    effectiveRecipients.length === 1 && looksLikeIMessageAddress(effectiveRecipients[0]!.address);
  const imessageTextTooLong =
    selectedService === 'iMessage' &&
    new TextEncoder().encode(message.trim()).byteLength > MAX_INITIAL_IMESSAGE_TEXT_BYTES;
  const shareNewIMessageBlocked =
    initialContent.identity !== null && selectedService === 'iMessage';
  const shareRetryExpired =
    initialContent.identity !== null &&
    !isShareIntakeNewChatRetryWindowOpen(initialContent.identity);

  // With an existing one-to-one iMessage chat selected, Start adds the message to it through the
  // normal send path: a bubble, the outgoing queue and the exact route's acknowledgement, whose
  // message id merges the Mac's copy. A group's text goes through the server's AppleScript route,
  // which returns no id, so a copy fetched as the chat opens could show twice; a group therefore
  // uses "Open it", which keeps the message as its draft. A share keeps its own durable path. A
  // typed but uncommitted address isn't part of the lookup, so it never reaches a found chat.
  const choosesExisting =
    selectedMatch !== null && pendingRecipient === null && initialContent.identity === null;
  const sendsToExisting =
    choosesExisting &&
    !selectedMatch.isGroup &&
    selectedService === 'iMessage' &&
    exactIMessageTextSupported;
  const groupUsesOpenIt = choosesExisting && selectedMatch.isGroup;

  // This slice creates only 1:1 chats. Group creation is a later helper capability.
  const tooManyRecipients = effectiveRecipients.length > 1 && !groupUsesOpenIt;

  // The server refuses RCS media over this limit, and Start creates the thread with its text before
  // it sends files, so a send-time refusal would leave the new chat without its file. Name the
  // first such file and refuse to start until it is removed.
  const rcsFileTooLarge =
    selectedService === 'RCS'
      ? (staged.find((file) => file.size > MAX_RCS_ATTACHMENT_UPLOAD_BYTES) ?? null)
      : null;

  // The server creates the thread by sending its required initial text. iMessage attachments are
  // not restored yet, so keep staged files visible but refuse to start until they are removed.
  const canStart =
    !accountUnavailable &&
    !busy &&
    shareResumeReady &&
    !!selectedService &&
    serviceAvailable &&
    !shareNewIMessageBlocked &&
    !shareRetryExpired &&
    (initialContent.identity === null ||
      selectedService !== 'RCS' ||
      rcsAttemptOwnershipSupported) &&
    (sendsToExisting || effectiveRecipients.length === 1) &&
    message.trim().length > 0 &&
    rcsFileTooLarge === null &&
    (selectedService !== 'iMessage' ||
      (staged.length === 0 && (sendsToExisting || imessageAddressValid) && !imessageTextTooLong));

  /**
   * "Open it": go to the selected existing chat. A share travels with the route, so it must never
   * reach the guard's discard, which deletes it. Typed text is kept as that chat's draft first.
   * Staged or forwarded files don't carry over, so then the guard asks before dropping them.
   */
  const openExistingChat = async (chatGuid: string): Promise<void> => {
    if (!screenInteractionIsCurrent()) return;
    const batchId = initialContent.batchId;
    if (batchId !== null) {
      navigateWithoutPrompt(() =>
        router.replace(
          `/chat/${encodeURIComponent(chatGuid)}?shareBatch=${encodeURIComponent(batchId)}`,
        ),
      );
      return;
    }
    const text = message.trim();
    if (text.length > 0) {
      // Hold other taps while the draft is saved. The busy state would block this navigation and
      // turn the guard's discard question into "Still starting the conversation".
      submissionInFlightRef.current = true;
      try {
        await addTextToChatDraft(chatGuid, text, accountLease);
      } catch (error) {
        if (accountLease.isCurrent() && !abandonedRef.current) {
          logger.warn('[new-chat] keeping the message as a draft failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          showDialog(
            'New message',
            'Couldn’t keep your message as that conversation’s draft. It is still here.',
          );
        }
        return;
      } finally {
        submissionInFlightRef.current = false;
      }
      if (!accountLease.isCurrent() || abandonedRef.current) return;
    }
    const destination = `/chat/${encodeURIComponent(chatGuid)}`;
    if (staged.length === 0 && initialForwardHandoff == null) {
      navigateWithoutPrompt(() => router.replace(destination));
    } else {
      router.replace(destination);
    }
  };

  /** Start with an existing chat selected: queue the message there, then open that chat. */
  const startInExistingChat = async (chatGuid: string): Promise<void> => {
    submissionInFlightRef.current = true;
    setBusy(true);
    try {
      // A refusal before the queue that shows no notice of its own (for example, capabilities
      // refreshed mid-admission) resolves null; a full queue has already shown its notice.
      let issuePresented = false;
      const queued = await observeQueueAdmission(
        (onQueued) =>
          send(
            { chatGuid, text: message.trim() },
            accountLease,
            (issue) => {
              issuePresented = true;
              presentSendIssue(issue);
            },
            onQueued,
          ).then((result) => {
            if (result == null && accountLease.isCurrent() && !issuePresented) {
              throw new Error('Send capabilities changed before queue admission.');
            }
            return result;
          }),
        () => undefined,
        (error) => {
          if (!accountLease.isCurrent() || abandonedRef.current) return;
          logger.warn('[new-chat] existing-chat send was not queued', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          showDialog(
            'New message',
            'Couldn’t send to that conversation. Your message is still here.',
          );
        },
      );
      if (!queued || !accountLease.isCurrent() || abandonedRef.current) return;
      // The bubble and the outgoing queue own the message now. Start needs every staged file
      // removed for iMessage, so no forwarded file is left that needs its handoff pins.
      releaseForwardProtection();
      navigateWithoutPrompt(() => router.replace(`/chat/${encodeURIComponent(chatGuid)}`));
    } finally {
      submissionInFlightRef.current = false;
      if (accountLease.isCurrent() && !abandonedRef.current) setBusy(false);
    }
  };

  const onStart = async (): Promise<void> => {
    const recipient = effectiveRecipients[0];
    if (
      !canStart ||
      !recipient ||
      !selectedService ||
      !accountLease.isCurrent() ||
      submissionInFlightRef.current
    )
      return;
    if (sendsToExisting && existingGuid) {
      await startInExistingChat(existingGuid);
      return;
    }
    if (initialContent.identity && !isShareIntakeNewChatRetryWindowOpen(initialContent.identity)) {
      showDialog(
        'Shared item',
        'This share is too old to retry without risking a duplicate message. Go Back and choose Discard.',
      );
      return;
    }
    // Bind navigation, follow-up attachment sends, and error UI to the account that owned the tap.
    // createNewChat receives this exact lease before its first await; retaining it here also
    // prevents an old completion from routing or showing a dialog after reconnect.
    submissionInFlightRef.current = true;
    setBusy(true);
    try {
      const body = message.trim();
      const address = recipient.address.trim();
      const identity = initialContent.identity;
      let sharePlan: ShareIntakeNewChatPlan | undefined;
      let tempGuid: string | undefined;
      if (identity) {
        const providerEpoch =
          selectedService === 'RCS'
            ? currentRcsProviderEpoch(useSessionStore.getState().serverInfo)
            : null;
        if (
          selectedService === 'RCS' &&
          (!providerEpoch ||
            useSessionStore.getState().serverInfo?.supports_rcs_send_attempt_ownership !== true)
        ) {
          throw new Error('Safe retry ownership is unavailable for this RCS conversation.');
        }
        const proposedPlan: ShareIntakeNewChatPlan = {
          address,
          body,
          service: selectedService,
          providerEpoch,
          tempGuid: `share-${identity.batchId}`,
          clientAttemptGeneration: 1,
        };
        let persistedPlan: ShareIntakeNewChatPlan | undefined;
        const preparation = await runTrackedRealtimeWork(accountLease, async (lease) => {
          persistedPlan = await prepareShareIntakeNewChatPlan(
            identity,
            proposedPlan,
            () =>
              lease.isCurrent() &&
              (selectedService !== 'RCS' ||
                (currentRcsProviderEpoch(useSessionStore.getState().serverInfo) === providerEpoch &&
                  useSessionStore.getState().serverInfo?.supports_rcs_send_attempt_ownership ===
                    true)),
          );
        });
        if (preparation !== 'delivered' || !persistedPlan) return;
        sharePlan = persistedPlan;
        tempGuid = persistedPlan.tempGuid;
        setSharePlanPrepared(true);
      } else {
        // One stable request id per draft, so Start after an uncertain failure replays the first
        // attempt instead of sending the first message twice. RCS needs the server's attempt
        // ownership for that, and a re-pair starts a fresh attempt.
        const serverInfo = useSessionStore.getState().serverInfo;
        if (
          selectedService === 'iMessage' ||
          serverInfo?.supports_rcs_send_attempt_ownership === true
        ) {
          const attemptKey = JSON.stringify([
            selectedService,
            address,
            body,
            selectedService === 'RCS' ? currentRcsProviderEpoch(serverInfo) : null,
          ]);
          tempGuid = createAttemptsRef.current.get(attemptKey);
          if (!tempGuid) {
            tempGuid = `temp-${Crypto.randomUUID()}`;
            createAttemptsRef.current.set(attemptKey, tempGuid);
          }
        }
      }
      const guid =
        identity && sharePlan
          ? await createNewChat([address], body, accountLease, selectedService, tempGuid, {
              identity,
              plan: sharePlan,
            })
          : await createNewChat([address], body, accountLease, selectedService, tempGuid);
      if (!accountLease.isCurrent() || abandonedRef.current) return;
      // Send any shared files into the new (or matched) chat.
      if (staged.length > 0) {
        const sent = identity
          ? await sendImages(
              { chatGuid: guid, images: staged, shareIntake: identity },
              accountLease,
              presentSendIssue,
              (admission) => {
                if (admission.queued && accountLease.isCurrent()) {
                  setStaged((current) => current.filter((file) => file.uri !== admission.uri));
                }
              },
            )
          : await sendImages({ chatGuid: guid, images: staged }, accountLease, presentSendIssue);
        if (sent == null) return;
      }
      if (
        identity &&
        !(await consumeShareIntakeBatchIfComplete(identity, {
          lease: accountLease,
          drainNext: false,
        }))
      ) {
        throw new Error('The shared content is not fully owned yet.');
      }
      // The submission fully succeeded. Sent files now have durable outgoing owners, while any
      // removed forward files were deliberately excluded; neither case needs the handoff pins.
      // A thrown attachment send skips this boundary and retains protection for a safe retry.
      releaseForwardProtection();
      if (!accountLease.isCurrent() || abandonedRef.current) return;
      navigateWithoutPrompt(() => router.replace(`/chat/${encodeURIComponent(guid)}`));
      if (identity) void drainShareIntake();
    } catch (e) {
      if (!accountLease.isCurrent() || abandonedRef.current) return;
      // Log at ERROR: only error-level lines reach ErrorReportSink, and this is a user-visible
      // dead end (found on-device — the dialog appeared with NO log line anywhere, so a real
      // failure like an RCS bridge outage left zero telemetry).
      logger.error('[new-chat] createNewChat failed', 'sfcbzc1wod', e);
      const knownNotDispatched = isKnownPreDispatchNewChatError(e);
      showDialog(
        'New message',
        selectedService === 'iMessage'
          ? knownNotDispatched
            ? 'Couldn’t start the iMessage conversation. The address or Messages helper may be unavailable. Your draft is still here.'
            : 'We could not confirm whether the iMessage was sent. Check Messages or the conversation before trying again. Your draft is still here.'
          : initialContent.identity
            ? knownNotDispatched
              ? 'Couldn’t start the conversation. Check the address and your server connection. Your shared item is still here.'
              : 'Gator could not confirm whether the first RCS message was sent. Check Google Messages. To stop this share, go Back and choose Discard; Gator will not retry it automatically.'
            : knownNotDispatched
              ? 'Couldn’t start the conversation. Check the address and your server connection.'
              : 'Gator could not confirm whether the first RCS message was sent. Check Google Messages before trying again. Your draft is still here.',
      );
    } finally {
      submissionInFlightRef.current = false;
      if (accountLease.isCurrent() && !abandonedRef.current) setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader
        title="New Message"
        onBack={() => router.back()}
        right={
          accountUnavailable ? null : (
            // `disabled` greys the label but does NOT reach the a11y tree on its own, so TalkBack
            // would announce a dead button as actionable — state it explicitly.
            <Pressable
              onPress={() => void onStart()}
              disabled={!canStart}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canStart }}
            >
              <Text
                style={[
                  styles.start,
                  { color: canStart ? theme.color.tint : theme.color.tertiaryLabel },
                ]}
              >
                Start
              </Text>
            </Pressable>
          )
        }
      />

      {accountUnavailable ? (
        <Text
          accessibilityRole="text"
          accessibilityLabel="Account changed. Go back and start a new message again."
          style={[styles.accountChanged, { color: theme.color.secondaryLabel }]}
        >
          Account changed. Go back and start a new message again.
        </Text>
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {!shareResumeReady ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              Checking the shared item before it can be edited…
            </Text>
          ) : null}
          <View style={[styles.toLine, { borderBottomColor: theme.color.separator }]}>
            <Text style={[styles.toLabel, { color: theme.color.secondaryLabel }]}>To:</Text>
            <View style={styles.chipsWrap}>
              {recipients.map((r) => {
                const avail = showAvailability ? availability[r.address] : undefined;
                // Blue = on iMessage, green = not on iMessage, grey = unknown or not checked.
                const chipColor =
                  avail === true
                    ? theme.color.tint
                    : avail === false
                      ? NOT_ON_IMESSAGE_GREEN
                      : theme.color.tertiaryLabel;
                return (
                  <Pressable
                    key={r.address}
                    onPress={() => removeRecipient(r.address)}
                    disabled={busy || !shareResumeReady || sharePlanPrepared}
                    style={[styles.chip, { backgroundColor: chipColor }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${r.name}${
                      avail === true
                        ? ' (on iMessage)'
                        : avail === false
                          ? ' (not on iMessage)'
                          : ''
                    }`}
                  >
                    <Text style={[styles.chipText, { color: readableTextOn(chipColor) }]}>
                      {r.name} ✕
                    </Text>
                  </Pressable>
                );
              })}
              <TextInput
                value={query}
                editable={!busy && shareResumeReady && !sharePlanPrepared}
                onChangeText={(text) => {
                  if (!screenInteractionIsCurrent()) return;
                  if (text.endsWith(',')) onCommaCommit(text);
                  else setQuery(text);
                }}
                onKeyPress={(event) => onKeyPress(event.nativeEvent.key)}
                onSubmitEditing={commitRaw}
                placeholder={recipients.length === 0 ? 'Phone or email' : 'Add another…'}
                placeholderTextColor={theme.color.tertiaryLabel}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={[styles.toInput, { color: theme.color.label }]}
              />
            </View>
          </View>

          {existingGuid ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void openExistingChat(existingGuid)}
              style={[styles.existing, { backgroundColor: theme.color.secondaryBackground }]}
            >
              <Text style={[styles.existingText, { color: theme.color.tint }]}>
                You already have a conversation with{' '}
                {recipients.length === 1 ? 'this person' : 'these people'} — Open it ›
              </Text>
            </Pressable>
          ) : null}

          {matches.length > 1 ? (
            <View
              style={styles.matchList}
              accessibilityRole="radiogroup"
              accessibilityLabel="Existing conversation"
            >
              {matches.map((match) => {
                const selected = match.guid === existingGuid;
                const label = existingChatLabel(match);
                return (
                  <Pressable
                    key={match.guid}
                    accessibilityRole="radio"
                    accessibilityLabel={label}
                    accessibilityState={{ selected, disabled: busy }}
                    disabled={busy}
                    onPress={() => {
                      if (screenInteractionIsCurrent()) {
                        setPickedMatch({ recipientKey, guid: match.guid });
                      }
                    }}
                    style={[
                      styles.matchRow,
                      {
                        borderColor: selected ? theme.color.tint : theme.color.separator,
                        backgroundColor: selected
                          ? theme.color.secondaryBackground
                          : theme.color.background,
                      },
                    ]}
                  >
                    <Text style={{ color: selected ? theme.color.tint : theme.color.label }}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {showServiceChoice ? (
            <View
              style={styles.serviceChoiceRow}
              accessibilityRole="radiogroup"
              accessibilityLabel="Message service"
            >
              {(['RCS', 'iMessage'] as const).map((service) => {
                const available = service === 'RCS' ? rcsEnabled : imessageEnabled;
                const selected = selectedService === service;
                return (
                  <Pressable
                    key={service}
                    accessibilityRole="radio"
                    accessibilityLabel={service}
                    accessibilityState={{
                      selected,
                      disabled: busy || !available || !shareResumeReady || sharePlanPrepared,
                    }}
                    disabled={busy || !available || !shareResumeReady || sharePlanPrepared}
                    onPress={() => {
                      if (screenInteractionIsCurrent() && !sharePlanPrepared) {
                        setRequestedService(service);
                      }
                    }}
                    style={[
                      styles.serviceChoice,
                      {
                        borderColor: selected ? theme.color.tint : theme.color.separator,
                        backgroundColor: selected
                          ? theme.color.secondaryBackground
                          : theme.color.background,
                        opacity: available ? 1 : 0.5,
                      },
                    ]}
                  >
                    <Text style={{ color: selected ? theme.color.tint : theme.color.label }}>
                      {service}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
            {selectedService === 'iMessage'
              ? imessageEnabled
                ? 'New iMessage conversations support one recipient and text only.'
                : 'Starting a new iMessage conversation requires the Messages helper.'
              : rcsEnabled
                ? 'New conversations use RCS and support one recipient.'
                : 'Starting a new conversation requires an available RCS bridge. Open an existing conversation to send a message.'}
          </Text>

          {anyNotOnIMessage ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              {rcsEnabled
                ? 'A green recipient isn’t on iMessage. Choose RCS to reach them.'
                : 'A green recipient isn’t on iMessage, so an iMessage may not reach them.'}
            </Text>
          ) : null}

          {shareNewIMessageBlocked ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              To share with iMessage, open an existing conversation above. Starting a new iMessage
              conversation from Share is disabled because a retry could use the wrong Messages
              account. Choose RCS when no existing iMessage conversation is available.
            </Text>
          ) : null}

          {shareRetryExpired ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              This share is too old to retry safely. Go Back and choose Discard.
            </Text>
          ) : null}

          {initialContent.identity && selectedService === 'RCS' && !rcsAttemptOwnershipSupported ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              This server cannot safely retry a shared RCS conversation yet.
            </Text>
          ) : null}

          {sharePlanPrepared ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              Recipient, service, and message are locked so retrying cannot send the share twice.
            </Text>
          ) : null}

          {sendsToExisting ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              Start sends your message to the existing conversation.
            </Text>
          ) : null}

          {groupUsesOpenIt ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              To send to this group, choose Open it. Your message goes with you as a draft.
            </Text>
          ) : null}

          {tooManyRecipients ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              New conversations are one-to-one — remove extra recipients to start.
            </Text>
          ) : null}

          {selectedService === 'iMessage' && staged.length > 0 ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              iMessage attachments are not available yet. Remove them or choose RCS to start.
            </Text>
          ) : null}

          {rcsFileTooLarge ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              “{rcsFileTooLarge.name}” is larger than RCS allows (100 MiB). Remove it from your
              message to start.
            </Text>
          ) : null}

          {selectedService === 'iMessage' &&
          effectiveRecipients.length === 1 &&
          !imessageAddressValid &&
          !sendsToExisting ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              For iMessage, enter a full email address or a number with country code, such as
              +15551234567.
            </Text>
          ) : null}

          {imessageTextTooLong ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              The first iMessage must be 64 KB or smaller. Shorten it to start.
            </Text>
          ) : null}

          {staged.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.stagedRow}
              keyboardShouldPersistTaps="handled"
            >
              {staged.map((f) => (
                <View key={f.uri} style={styles.stagedItem}>
                  {/* `mimeType` is typed non-null but a share intent can deliver null (the
                    provider reported no type) — an unguarded `.startsWith` is a render crash
                    into the root ErrorBoundary. Same idiom as MessageBubble. */}
                  {(f.mimeType ?? '').startsWith('image/') ? (
                    <Image source={{ uri: f.uri }} style={styles.stagedThumb} contentFit="cover" />
                  ) : (
                    <View
                      style={[
                        styles.stagedThumb,
                        styles.stagedFile,
                        { backgroundColor: theme.color.secondaryBackground },
                      ]}
                    >
                      <Icon
                        name={
                          (f.mimeType ?? '').startsWith('video/')
                            ? 'videocam-outline'
                            : 'document-outline'
                        }
                        size={22}
                        color={theme.color.secondaryLabel}
                      />
                    </View>
                  )}
                  <Pressable
                    onPress={() => void removeStaged(f)}
                    disabled={busy || !shareResumeReady}
                    hitSlop={6}
                    style={styles.stagedRemove}
                    accessibilityRole="button"
                    accessibilityLabel="Remove attachment"
                  >
                    <Icon name="close-circle" size={20} color="#fff" />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}

          <TextInput
            value={message}
            editable={!busy && shareResumeReady && !sharePlanPrepared}
            onChangeText={(text) => {
              if (!screenInteractionIsCurrent()) return;
              setMessage(text);
            }}
            placeholder="Message"
            placeholderTextColor={theme.color.tertiaryLabel}
            multiline
            style={[
              styles.message,
              { color: theme.color.label, backgroundColor: theme.color.secondaryBackground },
            ]}
          />

          <ContactSuggestionList
            suggestions={suggestions}
            onPick={(contact) => {
              if (!screenInteractionIsCurrent()) return;
              addRecipient({
                address: recipientAddressFor(contact.address),
                name: contact.name || contact.address,
              });
            }}
          />
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  start: { fontSize: 17, fontWeight: '600', textAlign: 'right' },
  accountChanged: { textAlign: 'center', marginTop: 40, fontSize: 15, paddingHorizontal: 16 },
  content: { padding: 16, gap: 12 },
  toLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
  },
  toLabel: { fontSize: 16, marginRight: 8, marginTop: 6 },
  chipsWrap: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: { borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontSize: 14 },
  toInput: { flexGrow: 1, minWidth: 120, fontSize: 16, paddingVertical: 4 },
  existing: { borderRadius: 10, padding: 12 },
  existingText: { fontSize: 14, fontWeight: '500' },
  matchList: { gap: 6 },
  matchRow: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  rcsNote: { fontSize: 13 },
  serviceChoiceRow: { flexDirection: 'row', gap: 8 },
  serviceChoice: {
    flex: 1,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    paddingVertical: 9,
  },
  message: { minHeight: 90, borderRadius: 12, padding: 14, fontSize: 16, textAlignVertical: 'top' },
  stagedRow: { gap: 10, paddingVertical: 2 },
  stagedItem: { width: 64, height: 64 },
  stagedThumb: { width: 64, height: 64, borderRadius: 10 },
  stagedFile: { alignItems: 'center', justifyContent: 'center' },
  stagedRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 11,
  },
});
