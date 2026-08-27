import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import { findChatByParticipantAddresses } from '@db/repositories';
import { createNewChat, http } from '@/services';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { sendImages } from '@/services/send';
import { checkIMessageAvailability } from '@core/api/endpoints/handles';
import { logger } from '@core/secure';
import { consumeForwardAttachmentHandoff } from '@features/conversations/forwardAttachmentHandoff';
import { useContactSearch } from '@features/contacts/useContactSearch';
import { useRcsEnabled } from '@state/sessionStore';
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
  const [service, setService] = useState<'iMessage' | 'SMS' | 'RCS'>('iMessage');
  // RCS is server-gated: the chip only renders when the connected server's RCS bridge is on.
  const rcsEnabled = useRcsEnabled();
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
  // Per-recipient iMessage availability (advisory): true → blue chip, false → green (SMS),
  // undefined → probe pending/failed (neutral).
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  // Each address is probed at most once for this mounted account. Results stay address-keyed so
  // removing and re-adding a recipient can reuse a confirmed transport without another request.
  const probedRef = useRef(new Set<string>());

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

  // Any confirmed-false recipient auto-switches the compose to SMS so the send routes correctly
  // without guessing. The original account owns both request admission and result publication;
  // address-keyed results deliberately survive a remove/re-add inside that same mounted form.
  useEffect(() => {
    if (accountUnavailable || !accountLease.isCurrent()) return;
    for (const r of recipients) {
      if (probedRef.current.has(r.address)) continue;
      probedRef.current.add(r.address);
      void checkIMessageAvailability(http, r.address)
        .then((available) => {
          if (accountLease.isCurrent()) {
            setAvailability((cur) => ({ ...cur, [r.address]: available }));
          }
        })
        .catch(() => {
          // Advisory only (helper down / older server) — leave the chip neutral.
        });
    }
  }, [accountLease, accountUnavailable, recipients]);
  // Auto-pick the service from availability UNTIL the user manually taps the toggle. Deriving both
  // directions (SMS when any recipient is confirmed SMS-only, else iMessage) means removing the
  // SMS-only recipient reverts to iMessage instead of getting stuck on SMS; the `touched` guard
  // stops a later probe from clobbering the user's explicit choice. RCS is NEVER auto-picked —
  // it's a manual choice only, and (being manual) is itself protected by the same guard.
  const serviceTouchedRef = useRef(false);
  useEffect(() => {
    if (serviceTouchedRef.current) return;
    const anySmsOnly = recipients.some((r) => availability[r.address] === false);
    setService(anySmsOnly ? 'SMS' : 'iMessage');
  }, [recipients, availability]);
  // If the capability disappears mid-compose (reconnect to a non-RCS server) while RCS is
  // selected, fall back so we never send service='RCS' to a server that can't route it.
  useEffect(() => {
    // This is a real external-capability transition, not derived render state: resetting the
    // selection prevents RCS from silently becoming active again if a later server supports it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!rcsEnabled && service === 'RCS') setService('iMessage');
  }, [rcsEnabled, service]);

  const chosen = new Set(recipients.map((r) => r.address.toLowerCase()));

  // Already-chosen recipients are filtered out of the shared hook's suggestions.
  const suggestions = useContactSearch(query).filter((c) => !chosen.has(c.address.toLowerCase()));

  // Detect whether a chat with exactly these recipients already exists → offer to continue it.
  // Effect cleanup plus the exact recipient key prevent an older set from publishing its shortcut;
  // the captured account lease prevents a retired route from adopting a result into the next one.
  const recipientKey = JSON.stringify(recipients.map((r) => r.address));
  useEffect(() => {
    let active = true;
    if (recipients.length === 0 || accountUnavailable || !accountLease.isCurrent()) return;
    void findChatByParticipantAddresses(
      getDatabase(),
      recipients.map((r) => r.address),
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
  }, [accountLease, accountUnavailable, recipients, recipientKey]);
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

  // RCS chats are 1:1 (the server's RCS branch routes to the FIRST address only) — block a
  // multi-recipient create instead of silently dropping the extra people.
  const rcsTooMany = service === 'RCS' && effectiveRecipients.length > 1;

  // A staged shared file can be sent even with no typed message.
  const canStart =
    !accountUnavailable &&
    !busy &&
    !rcsTooMany &&
    effectiveRecipients.length > 0 &&
    (message.trim().length > 0 || staged.length > 0);

  const onStart = async (): Promise<void> => {
    if (!canStart || !accountLease.isCurrent()) return;
    // Bind navigation, follow-up attachment sends, and error UI to the account that owned the tap.
    // createNewChat receives this exact lease before its first await; retaining it here also
    // prevents an old completion from routing or showing a dialog after reconnect.
    setBusy(true);
    try {
      // createNewChat is server-deduped, so it returns the existing chat if there is one.
      const guid = await createNewChat(
        effectiveRecipients.map((r) => r.address),
        message.trim(),
        service,
        accountLease,
      );
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
      showDialog(
        'New message',
        'Couldn’t start the conversation. Check the address and your server connection.',
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
                const avail = availability[r.address];
                // Blue = confirmed iMessage, green = SMS-only, gray = unknown (probe pending/failed).
                const chipColor =
                  avail === true
                    ? theme.color.tint
                    : avail === false
                      ? '#34C759'
                      : theme.color.tertiaryLabel;
                return (
                  <Pressable
                    key={r.address}
                    onPress={() => removeRecipient(r.address)}
                    style={[styles.chip, { backgroundColor: chipColor }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${r.name}${avail === false ? ' (SMS only)' : ''}`}
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

          {/* Transport picker. `radio` + `selected` so the active transport is ANNOUNCED — colour
            alone leaves a screen-reader user unable to tell which one is armed. */}
          <View style={styles.serviceRow} accessibilityRole="radiogroup">
            {(rcsEnabled
              ? (['iMessage', 'SMS', 'RCS'] as const)
              : (['iMessage', 'SMS'] as const)
            ).map((s) => (
              <Pressable
                key={s}
                onPress={() => {
                  if (!screenInteractionIsCurrent()) return;
                  serviceTouchedRef.current = true;
                  setService(s);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: service === s }}
                accessibilityLabel={`Send as ${s}`}
                style={[
                  styles.serviceChip,
                  {
                    backgroundColor:
                      service === s ? theme.color.tint : theme.color.secondaryBackground,
                  },
                ]}
              >
                <Text
                  style={{
                    color: service === s ? readableTextOn(theme.color.tint) : theme.color.label,
                    fontSize: 14,
                  }}
                >
                  {s}
                </Text>
              </Pressable>
            ))}
          </View>

          {rcsTooMany ? (
            <Text style={[styles.rcsNote, { color: theme.color.secondaryLabel }]}>
              RCS conversations are one-to-one — remove extra recipients to start.
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
            placeholder={staged.length > 0 ? 'Add a message (optional)' : 'Message'}
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
  serviceRow: { flexDirection: 'row', gap: 8 },
  serviceChip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14 },
  rcsNote: { fontSize: 13 },
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
