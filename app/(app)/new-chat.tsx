import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { ApiError } from '@core/api/errors';
import { getDatabase } from '@db/database';
import { findChatByParticipantAddresses } from '@db/repositories';
import { createNewChat } from '@/services';
import type { NewChatService } from '@/services/chatActions';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { sendImages } from '@/services/send';
import { logger } from '@core/secure';
import { consumeForwardAttachmentHandoff } from '@features/conversations/forwardAttachmentHandoff';
import { useContactSearch } from '@features/contacts/useContactSearch';
import { useRcsEnabled, useSessionStore } from '@state/sessionStore';
import { useShareIntentStore, type SharedAttachment } from '@state/shareIntentStore';
import { Icon, readableTextOn, Screen, ScreenHeader, useTheme } from '@ui';
import { ContactSuggestionList } from '@ui/ContactSuggestionList';
import { presentSendIssue } from '@ui/conversations/sendNotices';
import { useUnsavedChangesGuard } from '@ui/hooks/useUnsavedChangesGuard';

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

/** Match the first iMessage mutation's explicit destination contract; never guess a country. */
function looksLikeIMessageAddress(raw: string): boolean {
  if (raw.includes('@')) return raw.length <= 254 && looksLikeAddress(raw);
  return /^\+[1-9][0-9]{1,14}$/.test(raw);
}

const MAX_INITIAL_IMESSAGE_TEXT_BYTES = 64 * 1024;

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
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountInvalidated, setAccountInvalidated] = useState(() => !accountLease.isCurrent());
  // A forwarded message pre-fills the composer. File paths stay out of this public route: the
  // only attachment parameter is an opaque, one-time key into a process-local handoff.
  const { forwardText, forwardAttachmentHandoff } = useLocalSearchParams<{
    forwardText?: string;
    forwardAttachmentHandoff?: string;
  }>();
  const [initialForwardHandoff] = useState(forwardAttachmentHandoff);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [query, setQuery] = useState('');
  // Capture the dormant native-share store as mount-only state. The protected forward token is
  // intentionally consumed from an effect below: a render that React abandons before commit must
  // not remove its expiry timer and leak the file pins forever.
  const [initialContent] = useState(() => {
    const { text, files, clear } = useShareIntentStore.getState();
    return {
      message: (forwardText ?? '') || text || '',
      attachments: files,
      clearShareIntent: text != null || files.length > 0 ? clear : null,
    };
  });
  const [message, setMessage] = useState(initialContent.message);
  // A narrow live server capability admits new iMessage chats without restoring broad Private API.
  // Preserve the user's explicit choice if that capability disappears; never silently switch the
  // destination to another service while the draft is open.
  const rcsEnabled = useRcsEnabled();
  const imessageEnabled = useSessionStore((s) => s.serverInfo?.supports_imessage_new_chat === true);
  const [requestedService, setRequestedService] = useState<NewChatService | null>(null);
  const selectedService: NewChatService | null =
    requestedService ?? (rcsEnabled ? 'RCS' : imessageEnabled ? 'iMessage' : null);
  // Once a default becomes available, pin it for this draft. A later capability refresh must not
  // silently change a prepared RCS message into an iMessage (or the reverse).
  useEffect(() => {
    if (!requestedService && selectedService) setRequestedService(selectedService);
  }, [requestedService, selectedService]);
  const serviceAvailable =
    selectedService === 'RCS' ? rcsEnabled : selectedService === 'iMessage' && imessageEnabled;
  const showServiceChoice =
    (rcsEnabled || requestedService === 'RCS') &&
    (imessageEnabled || requestedService === 'iMessage');
  // The helper create route sends the first text itself. Reuse this identity on an ambiguous
  // response and retry of the same authored message rather than sending it a second time.
  const createAttemptsRef = useRef(new Map<string, string>());
  const [existingMatch, setExistingMatch] = useState<{
    recipientKey: string;
    guid: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Dormant bounded-share handoff. IPC-01 currently has no producer or Android share target; a
  // future owned native intake may populate this only after completing a bounded atomic batch.
  const [staged, setStaged] = useState<SharedAttachment[]>(initialContent.attachments);
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
  const screenInteractionIsCurrent = (): boolean => accountLease.isCurrent();
  const accountUnavailable = accountInvalidated || !accountLease.isCurrent();

  // The synchronous subscription covers live retirement. This layout pass also dismisses an IME
  // when the route first commits with an already-retired account lease.
  useLayoutEffect(() => {
    if (accountUnavailable) Keyboard.dismiss();
  }, [accountUnavailable]);

  // Clear dormant external share state only after this consumer mounts, so an abandoned render
  // cannot lose pending content.
  useEffect(() => {
    if (!accountLease.isCurrent()) return;
    initialContent.clearShareIntent?.();
  }, [accountLease, initialContent]);

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
    (recipients.length > 0 || query.length > 0 || message.length > 0 || staged.length > 0);
  const { navigateWithoutPrompt } = useUnsavedChangesGuard({
    enabled: hasUnsavedChanges,
    title: busy ? 'Leave while starting the conversation?' : 'Discard new message?',
    message: busy
      ? 'The send may already be in progress, but this screen will not reopen after you leave.'
      : 'The recipients, message, and attachments in this draft will be cleared.',
    onDiscard: () => {
      abandonedRef.current = true;
      releaseForwardProtection();
    },
  });

  const chosen = new Set(recipients.map((r) => r.address.toLowerCase()));

  // Already-chosen recipients are filtered out of the shared hook's suggestions.
  const suggestions = useContactSearch(query).filter((c) => !chosen.has(c.address.toLowerCase()));

  // Detect whether a chat with exactly these recipients already exists → offer to continue it.
  // Effect cleanup plus the exact recipient key prevent an older set from publishing its shortcut;
  // the captured account lease prevents a retired route from adopting a result into the next one.
  const recipientKey = JSON.stringify([selectedService, recipients.map((r) => r.address)]);
  useEffect(() => {
    let active = true;
    if (
      recipients.length === 0 ||
      !selectedService ||
      accountUnavailable ||
      !accountLease.isCurrent()
    )
      return;
    void findChatByParticipantAddresses(
      getDatabase(),
      recipients.map((r) => r.address),
      selectedService,
    )
      .then((g) => {
        if (active && accountLease.isCurrent()) {
          setExistingMatch({ recipientKey, guid: g });
        }
      })
      .catch(() => {
        if (active && accountLease.isCurrent()) {
          setExistingMatch({ recipientKey, guid: null });
        }
      });
    return () => {
      active = false;
    };
  }, [accountLease, accountUnavailable, recipients, recipientKey, selectedService]);
  const existingGuid =
    !accountUnavailable && existingMatch?.recipientKey === recipientKey ? existingMatch.guid : null;

  const addRecipient = (r: Recipient): void => {
    if (!screenInteractionIsCurrent()) return;
    if (chosen.has(r.address.toLowerCase())) return;
    setRecipients((prev) => [...prev, r]);
    setQuery('');
  };

  const removeRecipient = (address: string): void => {
    if (!screenInteractionIsCurrent()) return;
    setRecipients((prev) => prev.filter((r) => r.address !== address));
  };

  const removeStaged = (uri: string): void => {
    if (!screenInteractionIsCurrent()) return;
    setStaged((prev) => prev.filter((f) => f.uri !== uri));
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
    if (!looksLikeAddress(raw) || chosen.has(raw.toLowerCase())) return null;
    return { address: raw, name: raw };
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

  // This slice creates only 1:1 chats. Group creation is a later helper capability.
  const tooManyRecipients = effectiveRecipients.length > 1;

  // The server creates the thread by sending its required initial text. iMessage attachments are
  // not restored yet, so keep staged files visible but refuse to start until they are removed.
  const canStart =
    !accountUnavailable &&
    !busy &&
    !!selectedService &&
    serviceAvailable &&
    effectiveRecipients.length === 1 &&
    message.trim().length > 0 &&
    (selectedService !== 'iMessage' ||
      (staged.length === 0 && imessageAddressValid && !imessageTextTooLong));

  const onStart = async (): Promise<void> => {
    const recipient = effectiveRecipients[0];
    if (!canStart || !recipient || !selectedService || !accountLease.isCurrent()) return;
    // Bind navigation, follow-up attachment sends, and error UI to the account that owned the tap.
    // createNewChat receives this exact lease before its first await; retaining it here also
    // prevents an old completion from routing or showing a dialog after reconnect.
    setBusy(true);
    try {
      const body = message.trim();
      const attemptKey = JSON.stringify([selectedService, recipient.address.trim(), body]);
      let tempGuid: string | undefined;
      if (selectedService === 'iMessage') {
        tempGuid = createAttemptsRef.current.get(attemptKey);
        if (!tempGuid) {
          tempGuid = `temp-${Crypto.randomUUID()}`;
          createAttemptsRef.current.set(attemptKey, tempGuid);
        }
      }
      const guid =
        selectedService === 'RCS'
          ? await createNewChat([recipient.address], body, accountLease)
          : await createNewChat([recipient.address], body, accountLease, 'iMessage', tempGuid);
      if (!accountLease.isCurrent() || abandonedRef.current) return;
      // Send any shared files into the new (or matched) chat.
      if (staged.length > 0) {
        const sent = await sendImages(
          { chatGuid: guid, images: staged },
          accountLease,
          presentSendIssue,
        );
        if (sent == null) return;
      }
      // The submission fully succeeded. Sent files now have durable outgoing owners, while any
      // removed forward files were deliberately excluded; neither case needs the handoff pins.
      // A thrown attachment send skips this boundary and retains protection for a safe retry.
      releaseForwardProtection();
      if (!accountLease.isCurrent() || abandonedRef.current) return;
      navigateWithoutPrompt(() => router.replace(`/chat/${encodeURIComponent(guid)}`));
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
          : 'Couldn’t start the conversation. Check the address and your server connection.',
      );
    } finally {
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
          <View style={[styles.toLine, { borderBottomColor: theme.color.separator }]}>
            <Text style={[styles.toLabel, { color: theme.color.secondaryLabel }]}>To:</Text>
            <View style={styles.chipsWrap}>
              {recipients.map((r) => {
                const chipColor = theme.color.tertiaryLabel;
                return (
                  <Pressable
                    key={r.address}
                    onPress={() => removeRecipient(r.address)}
                    style={[styles.chip, { backgroundColor: chipColor }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${r.name}`}
                  >
                    <Text style={[styles.chipText, { color: readableTextOn(chipColor) }]}>
                      {r.name} ✕
                    </Text>
                  </Pressable>
                );
              })}
              <TextInput
                value={query}
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
              onPress={() => {
                if (!screenInteractionIsCurrent()) return;
                router.replace(`/chat/${encodeURIComponent(existingGuid)}`);
              }}
              style={[styles.existing, { backgroundColor: theme.color.secondaryBackground }]}
            >
              <Text style={[styles.existingText, { color: theme.color.tint }]}>
                You already have a conversation with{' '}
                {recipients.length === 1 ? 'this person' : 'these people'} — Open it ›
              </Text>
            </Pressable>
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
                    accessibilityState={{ selected, disabled: !available }}
                    disabled={!available}
                    onPress={() => {
                      if (screenInteractionIsCurrent()) setRequestedService(service);
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

          {selectedService === 'iMessage' &&
          effectiveRecipients.length === 1 &&
          !imessageAddressValid ? (
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
                    onPress={() => removeStaged(f.uri)}
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
                address: contact.address,
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
