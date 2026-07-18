import { File } from 'expo-file-system';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import { findChatByParticipantAddresses } from '@db/repositories';
import { createNewChat, http } from '@/services';
import { sendImages } from '@/services/send';
import { checkIMessageAvailability } from '@core/api/endpoints/handles';
import { parseForwardAttachments } from '@features/conversations/forwardParams';
import { useContactSearch } from '@features/contacts/useContactSearch';
import { useRcsEnabled } from '@state/sessionStore';
import { useShareIntentStore, type SharedAttachment } from '@state/shareIntentStore';
import { Icon, Screen, ScreenHeader, useTheme } from '@ui';
import { ContactSuggestionList } from '@ui/ContactSuggestionList';

/** A chosen recipient chip: an address plus its best display name. */
interface Recipient {
  address: string;
  name: string;
}

/** Start a new conversation: pick recipient chips + an initial message. */
export default function NewChatScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  // A forwarded message pre-fills the composer (from the chat's "Forward" action); its
  // downloaded attachments ride as a JSON param, validated + staged in the mount effect below.
  const { forwardText, forwardAttachments } = useLocalSearchParams<{
    forwardText?: string;
    forwardAttachments?: string;
  }>();
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState(forwardText ?? '');
  const [service, setService] = useState<'iMessage' | 'SMS' | 'RCS'>('iMessage');
  // RCS is server-gated: the chip only renders when the connected server's RCS bridge is on.
  const rcsEnabled = useRcsEnabled();
  const [existingGuid, setExistingGuid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Files shared INTO the app (Android share sheet) — staged to send after the chat is created.
  const [staged, setStaged] = useState<SharedAttachment[]>([]);

  // Stage incoming content once on mount: forwarded attachments (validated — only `file://`
  // paths that actually exist on disk are staged) plus any content shared INTO the app via the
  // share sheet (prefills the message with shared text/URL, then clears the store).
  useEffect(() => {
    const forwarded = parseForwardAttachments(forwardAttachments, (uri) => {
      const f = new File(uri);
      return { exists: f.exists, size: f.size };
    });
    const { text, files, clear } = useShareIntentStore.getState();
    if (text) setMessage((m) => m || text);
    // Merge (dedupe by uri) — the staged tray keys rows by uri.
    const seen = new Set<string>();
    const all = [...forwarded, ...files].filter((f) =>
      seen.has(f.uri) ? false : (seen.add(f.uri), true),
    );
    if (all.length > 0) setStaged(all);
    if (text || files.length > 0) clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-recipient iMessage availability (advisory): true → blue chip, false → green (SMS),
  // undefined → probe pending/failed (neutral). Any confirmed-false recipient auto-switches the
  // compose to SMS so the send routes correctly without guessing.
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  // Each address is probed at most once per screen (the ref survives recipient changes, so
  // re-runs don't discard + re-issue in-flight probes); an in-flight result still lands after
  // the list changes — a setState after unmount is a safe no-op in React 19.
  const probedRef = useRef(new Set<string>());
  useEffect(() => {
    for (const r of recipients) {
      if (probedRef.current.has(r.address)) continue;
      probedRef.current.add(r.address);
      void checkIMessageAvailability(http, r.address)
        .then((available) => {
          setAvailability((cur) => ({ ...cur, [r.address]: available }));
        })
        .catch(() => {
          // Advisory only (helper down / older server) — leave the chip neutral.
        });
    }
  }, [recipients]);
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
    if (!rcsEnabled && service === 'RCS') setService('iMessage');
  }, [rcsEnabled, service]);

  const chosen = new Set(recipients.map((r) => r.address.toLowerCase()));

  // Already-chosen recipients are filtered out of the shared hook's suggestions.
  const suggestions = useContactSearch(query).filter((c) => !chosen.has(c.address.toLowerCase()));

  // Detect whether a chat with exactly these recipients already exists → offer to continue it.
  useEffect(() => {
    let active = true;
    if (recipients.length === 0) {
      setExistingGuid(null);
      return;
    }
    void findChatByParticipantAddresses(
      getDatabase(),
      recipients.map((r) => r.address),
    )
      .then((g) => {
        if (active) setExistingGuid(g);
      })
      .catch(() => {
        if (active) setExistingGuid(null);
      });
    return () => {
      active = false;
    };
  }, [recipients]);

  const addRecipient = (r: Recipient): void => {
    if (chosen.has(r.address.toLowerCase())) return;
    setRecipients((prev) => [...prev, r]);
    setQuery('');
  };

  const removeRecipient = (address: string): void => {
    setRecipients((prev) => prev.filter((r) => r.address !== address));
  };

  const removeStaged = (uri: string): void => {
    setStaged((prev) => prev.filter((f) => f.uri !== uri));
  };

  // Backspace on an empty input removes the last chip (iOS token-field behavior).
  const onKeyPress = (key: string): void => {
    if (key === 'Backspace' && query.length === 0 && recipients.length > 0) {
      removeRecipient(recipients[recipients.length - 1]!.address);
    }
  };

  // Committing raw typed text (comma / return) as a chip, when it looks like an address.
  const commitRaw = (): void => {
    const raw = query.trim().replace(/,$/, '').trim();
    if (raw.length === 0) return;
    addRecipient({ address: raw, name: raw });
  };

  // RCS chats are 1:1 (the server's RCS branch routes to the FIRST address only) — block a
  // multi-recipient create instead of silently dropping the extra people.
  const rcsTooMany = service === 'RCS' && recipients.length > 1;

  // A staged shared file can be sent even with no typed message.
  const canStart =
    !busy &&
    !rcsTooMany &&
    recipients.length > 0 &&
    (message.trim().length > 0 || staged.length > 0);

  const onStart = async (): Promise<void> => {
    if (!canStart) return;
    setBusy(true);
    try {
      // createNewChat is server-deduped, so it returns the existing chat if there is one.
      const guid = await createNewChat(
        recipients.map((r) => r.address),
        message.trim(),
        service,
      );
      // Send any shared files into the new (or matched) chat.
      if (staged.length > 0) await sendImages({ chatGuid: guid, images: staged });
      router.replace(`/chat/${encodeURIComponent(guid)}`);
    } catch {
      showDialog(
        'New message',
        'Couldn’t start the conversation. Check the address and your server connection.',
      );
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader
        title="New Message"
        onBack={() => router.back()}
        right={
          <Pressable onPress={() => void onStart()} disabled={!canStart} accessibilityRole="button">
            <Text
              style={[
                styles.start,
                { color: canStart ? theme.color.tint : theme.color.tertiaryLabel },
              ]}
            >
              Start
            </Text>
          </Pressable>
        }
      />

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
                  <Text style={styles.chipText}>{r.name} ✕</Text>
                </Pressable>
              );
            })}
            <TextInput
              value={query}
              onChangeText={(t) => {
                if (t.endsWith(',')) commitRaw();
                else setQuery(t);
              }}
              onKeyPress={(e) => onKeyPress(e.nativeEvent.key)}
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
            onPress={() => router.replace(`/chat/${encodeURIComponent(existingGuid)}`)}
            style={[styles.existing, { backgroundColor: theme.color.secondaryBackground }]}
          >
            <Text style={[styles.existingText, { color: theme.color.tint }]}>
              You already have a conversation with{' '}
              {recipients.length === 1 ? 'this person' : 'these people'} — Open it ›
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.serviceRow}>
          {(rcsEnabled
            ? (['iMessage', 'SMS', 'RCS'] as const)
            : (['iMessage', 'SMS'] as const)
          ).map((s) => (
            <Pressable
              key={s}
              onPress={() => {
                serviceTouchedRef.current = true;
                setService(s);
              }}
              style={[
                styles.serviceChip,
                {
                  backgroundColor:
                    service === s ? theme.color.tint : theme.color.secondaryBackground,
                },
              ]}
            >
              <Text style={{ color: service === s ? '#fff' : theme.color.label, fontSize: 14 }}>
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
                {f.mimeType.startsWith('image/') ? (
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
                        f.mimeType.startsWith('video/') ? 'videocam-outline' : 'document-outline'
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
          onChangeText={setMessage}
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
          onPick={(c) => addRecipient({ address: c.address, name: c.name || c.address })}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  start: { fontSize: 17, fontWeight: '600', textAlign: 'right' },
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
  chipText: { color: '#fff', fontSize: 14 },
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
